# QESG 개발 가이드라인 프롬프트 test

## 0) 리뷰 작성 규칙 (QESG 리뷰 봇은 반드시 준수)
- 리뷰 코멘트는 반드시 한국어
- 일반론 금지(근거 있는 diff만)
- 규칙 위반 우선 탐지
- 개선점 없으면 빈 배열
- 주석 추가 제안 금지

<!-- ENV_RULES_START -->
# 환경변수 관리 지침
## 폴더 구조
모든 프로젝트는 환경 변수 파일을 env/ 디렉토리 하위에 배포 환경별로 분리하여 관리합니다.
> env/ 폴더는 프로젝트 루트(root) 경로에 위치해야 합니다.

## Git 커밋 방지 (.gitignore 설정)
환경 변수 파일은 절대 Git에 커밋되지 않도록 .gitignore에 반드시 추가해야 합니다.

## 배포 환경 기준
| 환경    | 파일명               | 설명            |
| ----- | ----------------- | ------------- |
| 로컬 개발 | `.env.local`      | 개인 로컬 환경용 설정  |
| 스테이징  | `.env.staging`    | 테스트 서버용 설정    |
| 프로덕션  | `.env.production` | 실제 서비스 환경용 설정 |
> 각 환경별로 NODE_ENV, API endpoint, 인증 키 등이 분리되어야 합니다.

## ⚠️ 빌드 시 주의사항
1. npm run build:local 은 package.json에 등록하지 않습니다.
- 로컬 빌드 커맨드는 배포용 빌드(npm run build) 와 혼동을 일으킬 수 있습니다.
2. npm run build 시 기본 환경 변수는 .env.production 만 사용해야 합니다.
- 빌드 시 로컬 환경(.env.local)이나 로컬호스트 주소가 포함되지 않도록 반드시 확인해야 합니다.
- 예를 들어, 아래와 같이 .env.production이 기본으로 사용되는지 확인하세요.

```
# 예시: 빌드 명령어
NODE_ENV=production ENV_FILE=./env/.env.production npm run build
```

## 🧪 환경 변수 로딩 로직 (예시)
환경별로 명시적으로 .env 파일을 지정하도록 스크립트 또는 설정을 구성하세요.

```
# package.json 예시
{
  "scripts": {
    "check-env": "node check-env.js",

    "serve:local": "cross-env BUILD_ENV=local vue-cli-service serve",
    "serve:staging": "cross-env BUILD_ENV=staging vue-cli-service serve", 
    "serve:production": "cross-env BUILD_ENV=production vue-cli-service serve", 
    "serve:locknlock": "cross-env BUILD_ENV=locknlock vue-cli-service serve",

    "build": "npm run check-env && cross-env BUILD_ENV=production NODE_ENV=production vue-cli-service build",
    "build:test": "vue-cli-service build",
    "build:staging": "cross-env BUILD_ENV=staging NODE_ENV=staging vue-cli-service build",
    "build:production": "npm run check-env && cross-env BUILD_ENV=production NODE_ENV=production vue-cli-service build",
    "build:locknlock": "cross-env BUILD_ENV=locknlock NODE_ENV=production vue-cli-service build", 
  },
}
```
<!-- ENV_RULES_END -->