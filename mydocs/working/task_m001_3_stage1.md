# Stage 1 — 규정 MCP 계약과 서버 어댑터

GitHub Issue: [#3](https://github.com/buenosiempre-cmd/d-hwp/issues/3)
구현계획서: [task_m001_3_impl.md](../plans/task_m001_3_impl.md)
Stage: 1

## 단계 목적

동국규정 MCP v0.12.0에 서버에서 연결하고 제한된 요청·응답 계약으로 문서 검토 기능을 제공한다.

## 산출물

| 파일 | 변경 요약 |
|---|---|
| src/shared/rules.ts | status/citations/lookup/finance 계약, 허용 입력·글자 수 검증 |
| src/server/rules-mcp.ts | SDK stdio·Streamable HTTP, 환경설정·도구 허용목록, 시간·크기·동시 요청 제한 |
| tests/unit/rules-mcp.test.ts, tests/fixtures/rules-mcp.mjs | 합성 MCP 연결·오류·취소·초과 응답 검사 |
| package.json, package-lock.json, tsconfig.json, THIRD_PARTY_NOTICES.md | SDK 1.32.1 고정, 로컬 설정 로딩, Node TS import 지원·출처 |

## 본문 변경 정도 / 본문 무손실 여부

원문 입력은 임의로 자르지 않는다. RHWP 0.8.7 엔진·라이선스·문서 포맷은 변경하지 않았다.

## 검증 결과

```bash
npm run typecheck
npm test
git diff --check
```

- OK — 프로젝트 타입 검사 통과, 단위 테스트 34/34 통과(신규 MCP 어댑터 11개 포함).
- OK — 실제 SDK를 사용한 stdio·HTTP 합성 테스트: 허용 도구, 금융 기능 opt-in, 인증정보 비노출, 리다이렉트 거부, 1 MiB 응답 제한, 20초 timeout 확인.
- OK — Node 24.21.0 기본 TypeScript 로딩 확인.

## 잔여 위험

- 호출 제한 20초 이후 stdio 프로세스 종료 대기 시간이 추가될 수 있다.
- 서버 운영자가 선택한 MCP 접근 범위는 별도 설정이며 개인별 권한 자동 연동은 제공하지 않는다.

## 다음 단계 영향

공유 계약을 로컬/Slack HTTP 경계와 공통 검토 화면에 연결한다. 중첩 partial·needs_input 등의 상태를 보존해야 한다.

## 승인 요청

사용자의 연속 구현·커밋·푸시 지시에 따라 다음 단계까지 진행한다. 별도 배포·merge는 범위에 포함하지 않는다.
