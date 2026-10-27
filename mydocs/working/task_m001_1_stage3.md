# Stage 3 — 회귀 검증과 사용 안내

GitHub Issue: [#1](https://github.com/buenosiempre-cmd/d-hwp/issues/1)
구현계획서: [task_m001_1_impl.md](../plans/task_m001_1_impl.md)

## 단계 목적
새 작업실과 기존 Slack 편집기의 문서 보존·데이터 경계·모바일 사용을 검증하고 재현 가능한 실행 안내를 제공한다.

## 산출물
| 파일 | 변경 요약 |
|---|---|
| tests/desk/assistant-panel.spec.ts | 입력 변경, 늦은 결과, 실패한 재가져오기, 문서 상태 검증, 복사·다운로드 29개 |
| tests/desk/desk.spec.ts | HWP/HWPX 실제 편집·재열기, 닫기/교체, 오류, 용량/쪽수, 모바일 9개 |
| tests/desk/server.spec.ts | CSP, Host, 메서드, 경로 접근, 라이선스 응답 1개 |
| tests/viewer/d-hwp-assistant.spec.ts | 실제 SDK 가져오기와 기존 문서 상태 보존 1개 |
| playwright.desk.config.ts, CI, scripts/check.mjs | 새 시나리오를 전체 검사에 포함 |
| README.md, docs/d-hwp.md, docs/images/ | 실행·데이터 경로·기능 한계·합성 문서 화면 |

## 본문과 API 보존
기존 viewer 테스트는 제품명이 바뀐 title 기대값만 수정했다. 신규 기능 검증은 별도 파일로 추가했다. LICENSE·제3자 고지, upstream 엔진 고정값과 기존 Slack 인증·저장 API는 유지했다.

## 검증 결과
Node 24.21.0 / npm 11.19.0에서 확인했다. 아래 총 423개는 중복 재실행을 제외한 테스트 수다.

| 명령 | 결과 | 확인 사항 |
|---|---|---|
| npm run typecheck | 통과 | 앱·서버·테스트 TypeScript |
| npm test | 21/21 | 요청문 6개 포함 순수 모델·기존 단위 검사 |
| npm run test:slack | 237/237 | 기존 Slack 흐름 회귀 |
| npm run test:security | 77/77 | 기존 인증·권한·보안 경계 회귀 |
| npm run build:desk, npm run build:dev | 통과 | production·development Studio와 독립 작업실 |
| npm exec playwright test | 39/39 | 기존 편집·저장·출력 및 D-HWP 패널 |
| node --test tests/conversion/*.test.mjs | 10/10 | 실제 HWP/HWPX 변환·큐·취소·복구 |
| npm run test:desk | 39/39 | 패널 29 + 작업실 9 + 서버 1 |
| npm exec playwright test tests/viewer/d-hwp-assistant.spec.ts | 1/1 재확인 | 마지막 공통 패널 수정 후 Slack 호스트 재확인 |
| git diff --check | 통과 | 공백 오류 없음 |

데스크톱과 모바일 스크린샷을 시각 확인했다. HWP/HWPX 편집본을 실제 다운로드하고 새로 열어 수정 문자열이 남는지 검증했다. 테스트 문서는 기존 합성 fixture이며 실제 사용자 문서를 사용하지 않았다. 편집기 시나리오의 네트워크 요청은 로컬 자산 요청만 허용되는지 검사했다.

## 잔여 위험
실제 Slack embeds 설치·교내 서식·AI 응답 품질·현업 소요시간 개선은 미검증이다. Docker 컨테이너는 로컬에서 실행하지 않았고 기존 CI 작업에 남긴다. 원격 CI 결과는 게시 후 별도로 확인한다.

## 다음 단계와 실행 근거
사용자의 개발·커밋·푸시 지시 범위로 최종 보고서와 함께 커밋하고 publish/task1에 게시한다. main을 대상으로 PR을 만들며 자동 merge·이슈 close·서비스 배포는 하지 않는다.
