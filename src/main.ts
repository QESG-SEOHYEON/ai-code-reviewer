import { readFileSync, existsSync } from "fs";
import path from "path";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import { minimatch } from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

// 공통 가이드라인(액션 레포 내부)
const COMMON_RULES_PATH: string =
  core.getInput("COMMON_RULES_PATH") || "rules/common.md";
// 레포 특화 규칙(대상 레포 내부)
const REPO_RULES_PATH: string =
  core.getInput("REPO_RULES_PATH") || ".github/ai-review/rules.md";
// PR 설명 최대 글자수
const MAX_PR_DESCRIPTION_CHARS: number = (() => {
  const raw = core.getInput("MAX_PR_DESCRIPTION_CHARS") || "1500";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 1500;
})();

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

type RulesBundle = { commonRules: string; repoRules: string };

function safeReadFile(filePath: string): string {
  try {
    if (!existsSync(filePath)) return "";
    return readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function loadRules(): RulesBundle {
  // ✅ ncc 번들 환경에서 가장 안전한 액션 루트
  const actionRoot =
    process.env.GITHUB_ACTION_PATH || path.resolve(__dirname, "..");
  const commonAbs = path.resolve(actionRoot, COMMON_RULES_PATH);

  // 대상 레포는 checkout 되어 GITHUB_WORKSPACE에 있음
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const repoAbs = path.resolve(workspace, REPO_RULES_PATH);

  return {
    commonRules: safeReadFile(commonAbs),
    repoRules: safeReadFile(repoAbs).trim(),
  };
}

function truncate(text: string, maxChars: number): string {
  if (!text) return "";
  if (maxChars <= 0) return ""; // 0이면 description 미포함
  return text.length > maxChars
    ? text.slice(0, maxChars) + "\n...(truncated)"
    : text;
}

async function getPRDetails(): Promise<PRDetails> {
  const eventPath = process.env.GITHUB_EVENT_PATH || "";
  const { repository, number } = JSON.parse(readFileSync(eventPath, "utf8"));

  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });

  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string for diff format
  return response.data;
}

function createSystemPrompt(rules: RulesBundle): string {
  const common = rules.commonRules || "(none)";
  const hasRepoRules = Boolean(
    rules.repoRules && rules.repoRules.trim().length > 0
  );

  // ✅ repoSection에는 '블록 전체'만 들어가게(깨짐 방지)
  const repoSection = hasRepoRules
    ? `
[레포 특화 규칙]
---
${rules.repoRules.trim()}
---
`
    : "";

  const priorityLine = hasRepoRules
    ? `- 공통 가이드라인과 레포 특화 규칙이 충돌하면 **레포 특화 규칙이 우선(override)** 입니다.`
    : `- 레포 특화 규칙이 없으므로 **공통 가이드라인만 적용**합니다.`;

  return `당신은 QESG GitHub PR 코드리뷰 봇입니다. 모든 리뷰 코멘트는 반드시 **한국어**로 작성합니다.

규칙 우선순위:
${priorityLine}

[공통 가이드라인]
---
${common}
---
${repoSection}
작성 규칙:
- 반드시 아래 JSON만 출력: {"reviews":[{"lineNumber":<number>,"reviewComment":"<markdown, 한국어>"}]}
- 공통규칙/레포 규칙 위반이 있으면 반드시 지적.
- 칭찬/긍정 코멘트 금지.
- 개선점이 없으면 reviews는 빈 배열([])로 반환.
- 각 리뷰는 반드시 diff의 특정 라인을 근거로 하며, 근거 없는 일반론은 금지.
- **코드에 주석 추가를 제안하지 않음.**
- lineNumber는 가능한 한 **새 파일 기준(추가/수정된 라인)** 번호로 지정.`;
}

function createUserPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  const desc = truncate(prDetails.description || "", MAX_PR_DESCRIPTION_CHARS);

  return `다음 PR 정보를 참고해서, 아래 diff를 리뷰해줘.

PR 제목: ${prDetails.title}
PR 설명:
---
${desc || "(생략)"}
---

대상 파일: ${file.to}

diff:
\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln2 ?? c.ln ?? ""} ${c.content}`)
  .join("\n")}
\`\`\`

※ 출력은 반드시 한국어로만 작성하세요.
`;
}

// 응답 검증 + 1회 재시도
function hasHangul(text: string): boolean {
  return /[가-힣]/.test(text);
}

function allKoreanOrEmpty(
  reviews: Array<{ reviewComment?: string }>
): boolean {
  return reviews.every((r) => {
    const c = String(r.reviewComment || "").trim();
    if (!c) return true;
    return hasHangul(c);
  });
}

function safeParseReviews(raw: string): Array<{ lineNumber: string; reviewComment: string }> {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.reviews)) return parsed.reviews;
    return [];
  } catch {
    return [];
  }
}

async function callOpenAIOnce(systemPrompt: string, userPrompt: string) {
  const response = await openai.chat.completions.create({
    model: OPENAI_API_MODEL,
    temperature: 0.1,
    max_tokens: 700,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" } as any,
  });

  const res = response.choices[0].message?.content?.trim() || "{}";
  return safeParseReviews(res);
}

async function getAIResponse(
  systemPrompt: string,
  userPrompt: string
): Promise<Array<{ lineNumber: string; reviewComment: string }> | null> {
  try {
    // 1차
    let reviews = await callOpenAIOnce(systemPrompt, userPrompt);
    // 재시도
    if (!allKoreanOrEmpty(reviews)) {
      core.info("Non-Korean response detected. Retrying once with stricter rule.");

      const stricterSystem =
        systemPrompt +
        `

[추가 강제 규칙]
- reviewComment는 반드시 한국어 문장만 사용한다.
- 영어 문장 작성은 금지한다. 필요하면 한국어로 풀어서 설명한다.
`;

      reviews = await callOpenAIOnce(stricterSystem, userPrompt);
    }

    return reviews;
  } catch (e) {
    console.error("OpenAI error:", e);
    return null;
  }
}

function createComment(
  file: File,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  if (!file.to) return [];

  return aiResponses.flatMap((aiResponse) => {
    const line = Number(aiResponse.lineNumber);
    if (!Number.isFinite(line) || line <= 0) return [];

    return {
      body: aiResponse.reviewComment,
      path: file.to!,
      line,
    };
  });
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails,
  rules: RulesBundle
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  const systemPrompt = createSystemPrompt(rules);

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue;

    for (const chunk of file.chunks) {
      const userPrompt = createUserPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(systemPrompt, userPrompt);
      if (!aiResponse) continue;

      const newComments = createComment(file, aiResponse);
      if (newComments.length > 0) comments.push(...newComments);
    }
  }

  return comments;
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
  });
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;

  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );

  if (eventData.action === "opened") {
    diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: { accept: "application/vnd.github.v3.diff" },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  const excludeRaw = core.getInput("exclude") || "";
  const excludePatterns = excludeRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const filteredDiff = parsedDiff.filter((file) => {
    const filePath = file.to ?? "";
    if (!filePath) return false;
    return !excludePatterns.some((pattern) => minimatch(filePath, pattern));
  });

  const rules = loadRules();

  if (!rules.repoRules || rules.repoRules.trim().length === 0) {
    core.info("Repo rules not found; using common rules only.");
  }

  core.info(`COMMON_RULES loaded: ${rules.commonRules ? "YES" : "NO"}`);
  core.info(`REPO_RULES loaded: ${rules.repoRules ? "YES" : "NO"}`);
  core.info(`GITHUB_WORKSPACE: ${process.env.GITHUB_WORKSPACE || "(empty)"}`);
  core.info(`COMMON_RULES_PATH: ${COMMON_RULES_PATH}`);
  core.info(`REPO_RULES_PATH: ${REPO_RULES_PATH}`);
  core.info(`MAX_PR_DESCRIPTION_CHARS: ${MAX_PR_DESCRIPTION_CHARS}`);
  core.info(`MODEL: ${OPENAI_API_MODEL}`);

  const comments = await analyzeCode(filteredDiff, prDetails, rules);

  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
