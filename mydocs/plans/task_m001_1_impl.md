# D-HWP 구현계획서

수행계획서: [task_m001_1.md](task_m001_1.md)
GitHub Issue: [#1](https://github.com/buenosiempre-cmd/d-hwp/issues/1)
마일스톤: M001

## 단계 개요
| Stage | 산출물 | 검증 |
|---|---|---|
| 1 | src/assistant/workflows.ts, 단위 테스트 | 입력 경계·업무별 출력·문서 격리 |
| 2 | src/assistant/panel.ts, src/desk, 편집기 연결, 빌드/serve | typecheck, production/dev build, SDK 통합 |
| 3 | 브라우저 테스트·실행안내·단계/최종보고서 | unit/slack/security/viewer, git diff --check |

## 문서 위치 확인
README·docs/d-hwp.md는 공식 사용자/개발 안내, mydocs 문서는 작업 추적에 사용한다. 수행계획서와 일치한다.

## Stage 1
순수 함수로 업무 목적별 체크리스트와 AI 요청문을 생성한다. 빈 입력/초과 크기/잘못된 task를 거부하고 원문을 데이터로 구분한다. 입력 내용은 자동 전송/저장하지 않는다.
검증: node --import tsx --test tests/unit/d-hwp-workflows.test.ts
커밋: Task #1 Stage 1: AI 업무 요청문 모델과 입력 검증

## Stage 2
공통 패널에서 전체 문서 가져오기 또는 부분 붙여넣기, 용도 선택, 검토용 요청문 생성, 복사와 Markdown 다운로드를 구현한다. source 변경 시 이전 결과를 무효화한다. 로컬 작업실은 실제 HWP/HWPX 편집·다운로드, Slack 편집기는 기존 저장을 유지한다.
검증: npm run typecheck, npm run build, npm run build:dev, npm run build:desk, 브라우저 통합 시나리오.
커밋: Task #1 Stage 2: D-HWP 작업실과 문서 업무 도우미 연결

## Stage 3
기존 회귀와 새 E2E, 모바일 및 시각 검토, 로컬 실행·실제 처리 범위·한계 문서를 완료한다. 작업 브랜치를 publish/task1에 push하고 origin과 HEAD 일치를 확인한다. 사용자 fork main 대상 PR을 생성한다.
검증: npm test, npm run test:slack, npm run test:security, npm exec playwright test, git diff --check.
커밋: Task #1 Stage 3 + 최종 보고서: D-HWP 검증과 사용 안내

## 단계 의존성과 실행 근거
모델 → 공통 UI/호스트 → 통합 검증 순서다. 독립 파일 구현은 병렬 진행하되 stage commit과 검증은 순차 실행한다. 사용자 2026-10-28 개발·commit·push 지시 범위로 수행한다. 실제 운영 Slack/컨테이너 배포와 AI 응답 품질은 별도 검증이다.
