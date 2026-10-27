# Stage 2 — 문서 검토 화면과 인증 API 연결

GitHub Issue: [#3](https://github.com/buenosiempre-cmd/d-hwp/issues/3)
구현계획서: [task_m001_3_impl.md](../plans/task_m001_3_impl.md)
Stage: 2

## 단계 목적

로컬 작업실과 Slack 편집기에 실제 규정 검토, 전송 동의, 출처·한계 표시와 근거를 포함한 요청문을 연결한다.

## 산출물

| 파일 | 변경 요약 |
|---|---|
| src/assistant/rules-client.ts, rules-panel.ts, rules-view.ts | 명시적 전송·검토·취소, 인용/규정/재무 결과와 원문 출처 |
| src/assistant/panel.ts, panel.css, workflows.ts | 문서 snapshot·근거 무효화, 선택한 근거 포함 요청문 |
| src/server/rules-api.ts, rules-mcp.ts, editor-routes.ts | 입력 제한, 동시 요청, HTTP 취소의 MCP 전달, Slack 권한 재검사 |
| src/desk/main.ts, index.html, src/editor/main.ts, scripts/serve-desk.mjs | 두 실행 경로 연결·전송 안내, 로컬 Host/Origin·예외 처리 |
| tests/unit, tests/security/rules-api.test.ts, tests/desk | 계약·API·UI 회귀 시나리오와 실제 응답 형태 fixture |

## 본문 변경 정도 / 본문 무손실 여부

문서를 자동 수정하지 않는다. 요청·근거는 임의로 자르지 않는다. 입력·문서가 바뀌면 이전 근거와 출력은 폐기하며, 문서 가져오기 완료 후에도 전송 동의를 다시 받는다.

## 검증 결과

```bash
npm run typecheck
npm test
npm run test:security
npm run test:slack
npm run build:desk
npm run build:dev
npm run test:desk
git diff --check
```

- OK — 타입 검사와 프로덕션·개발·작업실 빌드 통과.
- OK — 단위 37/37, 보안 82/82, Slack 237/237, 작업실 71/71 통과.
- OK — 동의 없는 전송 차단, 문서 가져오기 경합·늦은 응답 폐기, 잘못된 URL에 서버 생존.
- OK — HTTP·stdio 취소 시 실제 연결/프로세스 종료 후 슬롯 회수, 새 요청 성공.
- OK — 실제 MCP와 동일한 nested applicable_rule/get_rule_content/실패 응답, 인용 metadata 중복 카드 방지.
- OK — 컨테이너와 동일한 cloud CJS bundle 두 개 생성 및 --warm-code 로딩 통과.

## 잔여 위험

Slack 연동은 서버 opt-in과 MCP 접근 범위 설정이 필요하다. 실제 Slack 운영 설치는 별도다. 실제 AI API는 연결하지 않았으며 요청문 준비 기능이다.

## 다음 단계 영향

실제 MCP 합성 시나리오와 전체 RHWP 회귀, 최종 화면·사용 안내·게시를 확인한다.

## 승인 요청

사용자의 연속 구현·커밋·푸시 지시에 따라 최종 검증·게시까지 진행한다.
