# D-HWP 규정 MCP 연동 구현계획서

수행계획서: [task_m001_3.md](task_m001_3.md)
Issue: [#3](https://github.com/buenosiempre-cmd/d-hwp/issues/3), M001

| Stage | 구현 | 검증 |
|---|---|---|
| 1 | 공유 계약, SDK MCP adapter, 안전한 환경설정과 오류 처리 | 어댑터/입력 단위 테스트, typecheck |
| 2 | 로컬 및 Slack API, 공통 규정 패널, 근거 요청문 | API 보안·브라우저 통합·빌드 |
| 3 | 기존 회귀, 실제 MCP 합성 확인, 사용 문서와 최종 보고 | 전체 수용 기준, 원격 SHA 확인 |

계획된 docs/와 mydocs/ 역할을 유지한다. 각 단계는 소스·검증·보고서를 함께 commit한다. 독립 파일은 병렬 구현하되 contract와 실제 연결을 통합 확인한다.

검증 명령: npm run typecheck, npm test, npm run test:slack, npm run test:security, npm run build:desk, npm run build:dev, npm exec playwright test, npm run test:desk, node --test tests/conversion/*.test.mjs, git diff --check.

커밋: Task #3 Stage 1: 규정 MCP 계약과 서버 어댑터 / Task #3 Stage 2: 문서 검토 화면과 인증 API 연결 / Task #3 Stage 3 + 최종 보고서: 규정 연동 검증과 사용 안내.

사용자 계속 진행 지시에 따라 단계별 추가 승인 요청 없이 구현·검증·게시를 수행한다. 실제 AI 공급자 선택이 오면 범위를 구체화하고 계획에 반영한다. 공급자 미선택은 MCP 연결을 막지 않는다.
