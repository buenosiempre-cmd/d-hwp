# Stage 3 — 규정 연동 검증과 사용 안내

GitHub Issue: [#3](https://github.com/buenosiempre-cmd/d-hwp/issues/3)
구현계획서: [task_m001_3_impl.md](../plans/task_m001_3_impl.md)
Stage: 3

## 단계 목적

기존 RHWP 기능 회귀와 실제 동국규정 MCP 연결을 확인하고 사용 가능한 시제품으로 게시한다.

## 산출물

| 파일 | 변경 요약 |
|---|---|
| README.md, docs/d-hwp.md, docs/d-hwp-mcp.md | 실행·설정·전송·근거 해석·현재 범위 안내 |
| .env.example | 서버측 MCP 설정, 재무/Slack opt-in 기본값 |
| docs/images/d-hwp-mcp-desktop.png, d-hwp-mcp-mobile.png | 합성 문서·실제 규정 조회 화면 |
| mydocs/report/task_m001_3_report.md, mydocs/orders/20261028.md | 최종 수용 기준과 작업 상태 |

## 본문 변경 정도 / 본문 무손실 여부

실문서나 인증정보를 공개하지 않았다. 개인 경로를 담은 로컬 설정은 Git 제외를 확인했다. 문서 파일·RHWP 0.8.7은 유지하며 규정 조회는 명시적으로 선택한 텍스트·질문만 전송한다.

## 검증 결과

- 최종 로컬 테스트 **476/476**: unit 37, security 82, Slack 237, viewer 39, conversion 10, desk 71. Node 24.21.0 / npm 11.19.0.
- typecheck, build:desk(프로덕션 포함), build:dev, cloud bundle/--warm-code, git diff --check 통과.
- 초회 뷰어 검사에서 미리보기 포트 충돌 3건 발생. 미리보기를 분리한 뒤 전체 39개를 다시 실행하여 통과했다.
- 실제 MCP v0.12.0 stdio: 서비스 정보, 여비규정 제999조 NOT_FOUND 1건, 규정 검색 partial, 사실관계 없는 재무 needs_input 확인.
- 실제 재무: 합성 직원 국내출장·기준일·캠퍼스·회계·직군 조건으로 여비규정 제3조 조회, applicable_rule/개정본 3350/본문 1개/retrieved 확인. 시행일·경과조치 검토 한계는 함께 표시한다.
- 실제 브라우저→로컬 API→MCP→결과→근거 포함 요청문까지 확인. 원형 근거 data 보존, desktop 1600/mobile 390 가로 넘침 없음·pageerror 0. 실문서·외부 AI 사용 없음.

## 잔여 위험

실제 Slack 설치·공용 서버 배포·AI 공급자 호출·한국법령 실조회·내부 지식팩은 확인하지 않았다. 자동 지급/업무 승인/문서 자동 수정은 제공하지 않는다.

## 다음 단계 영향

publish/task3을 게시하고 선행 PR #2의 publish/task1을 대상으로 후속 PR을 만든다. 원격 HEAD 일치와 CI 결과는 PR 및 전달 보고에서 확인한다.

## 승인 요청

사용자의 개발·커밋·푸시 지시 범위로 게시한다. merge와 운영 배포는 수행하지 않는다.
