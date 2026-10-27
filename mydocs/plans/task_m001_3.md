# D-HWP 규정 MCP 연동 수행계획서

GitHub Issue: [#3](https://github.com/buenosiempre-cmd/d-hwp/issues/3)
마일스톤: M001 (문서 분류, 원격 미지정)

## 목적과 배경
기존 RHWP 편집 기능 위에 사용자의 동국규정 MCP를 연결하여 실제 인용 점검·관련 조문·재무 검토 질문을 제공한다. 사용자는 연계 설계 검토 후 기능 구현을 이어서 지시했다.

## 범위
포함: 서버측 MCP stdio/Streamable HTTP 어댑터, 제한된 status/citations/lookup/finance API, 공통 패널의 근거 화면, 근거 포함 요청문, 로컬 작업실·인증된 Slack 편집기 연결, 설정 안내·자동 테스트·합성 실연결 검증.
제외: 자동 지급/승인, 사용자 확인 없는 문서 수정, 서비스 배포·PR merge. 실제 AI 공급자는 비동기 질의 중이며 미선택 시 MCP 기능을 먼저 완성하고 현재 요청문 생성 경로를 유지한다.

## 설계 방향
- 브라우저는 같은 출처 API를 호출하고 서버가 SDK MCP client를 소유한다. MCP 주소·명령·토큰은 서버 설정만 사용한다.
- 허용 도구는 get_service_info, verify_rule_citations, lookup_dongguk_rule, review_finance_case로 제한한다. 검토 요청 전 범위 확인과 명시적인 클릭이 필요하다.
- 로컬 API는 Host/Origin/JSON/요청량·크기 제한을 검증한다. Slack API는 기존 세션과 문서 접근권한을 재확인한다.
- 응답은 structuredContent의 성공 여부와 내부 상태를 모두 확인한다. 부분·미확정·누락을 성공한 업무 판단으로 바꾸지 않는다.
- 기존 source snapshot 검증, 입력 변경·초기화·늦은 응답 보호를 새 근거에도 적용한다. 파일 원본과 RHWP engine은 유지한다.
- 인용 도구 20,000자 한도를 안내하고 초과 입력을 조용히 자르지 않는다. 이번 버전은 사용자가 검토할 범위를 줄여 확인한다.
- 사용자 환경에는 로컬 MCP checkout을 연결한 비공개 설정으로 실제 동작을 확인한다. 공개 코드·기록에는 개인 경로·인증정보·실문서를 포함하지 않는다.

## 문서 위치 판단
README.md는 진입 안내, docs/d-hwp.md와 docs/d-hwp-mcp.md는 공식 사용자/연동 안내, mydocs/plans·working·report는 작업 기록으로 사용한다. 기존 문서 루트를 유지한다.

## 예상 변경 파일
src/shared/rules.ts, src/server/rules-mcp.ts 및 API, src/assistant/rules-panel.ts 및 panel/workflows, src/desk·editor 연결, scripts/serve-desk.mjs, package/lock, tests, docs, 단계 보고서.

## 단계와 검증
1. MCP 계약·어댑터: 입력 검증, 허용 도구, 오류/시간 제한, stdio·HTTP 합성 테스트.
2. API·화면 연결: 권한·출처 검증, 실제 결과 표시·요청문 포함, 변경/오류/경합 브라우저 테스트.
3. 기존 회귀·실연결·문서·게시: 타입/빌드/unit/slack/security/viewer/desk, 합성 문장 실제 MCP, 시각 확인, 원격 SHA와 PR 확인.

## 리스크와 실행 근거
MCP 장애·빈 결과·부분 조회를 표시하고 편집 기능은 유지한다. 현재 인용 검증은 최신 개정본 기준이며 과거 적용 판단·캠퍼스 자동필터를 제공하지 않는다. 내부 지식팩은 별도 설정 기능이다.
사용자의 계속 구현 및 이전 commit/push 지시에 따라 필요한 개발·검증·게시를 진행한다. PR #2가 열려 있어 origin/publish/task1에서 local/task3을 만들고 publish/task3 → publish/task1의 후속 PR로 게시한다. 기존 devel로 기능을 되돌리지 않는다.
