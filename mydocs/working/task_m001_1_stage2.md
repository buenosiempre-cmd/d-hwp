# Stage 2 — D-HWP 작업실과 문서 업무 도우미

GitHub Issue: [#1](https://github.com/buenosiempre-cmd/d-hwp/issues/1)
구현계획서: [task_m001_1_impl.md](../plans/task_m001_1_impl.md)

## 단계 목적
고정 RHWP 엔진을 이용하는 로컬 작업실과 기존 Slack 편집기에서 같은 문서 업무 도우미를 사용하도록 연결한다.

## 산출물
| 파일 | 변경 요약 |
|---|---|
| src/assistant/panel.ts, panel.css | 문서 가져오기·부분 입력·4종 요청문·복사·Markdown 저장·초기화 |
| src/desk/ | 실제 HWP/HWPX 편집, 새 파일 다운로드, 문서 교체 확인, 모바일 탭 |
| src/editor/ | 기존 Slack 편집기에 업무 패널과 D-HWP 이름 연결 |
| scripts/build-desk.mjs, serve-desk.mjs | 독립 빌드, loopback 서버, 프로그램·라이선스만 제공 |
| scripts/static-version.mjs, package.json, tsconfig.json | 공유 패널 변경의 정적 캐시 무효화, 실행 명령, 타입 검사 |

## API와 문서 보존
원본 엔진과 /rhwp 명령, 기존 Slack 인증·저장 흐름을 유지한다. 로컬 편집본은 별도 다운로드한다. 브라우저 다운로드 요청만으로 디스크 저장 성공을 단정하지 않으며 원본 파일을 덮어쓰지 않는다.

가져온 문서는 documentEpoch/changeSeq/SHA로 생성·복사·다운로드 직전 다시 검증한다. 늦게 도착한 가져오기·검증 결과는 입력 수정·초기화·문서 교체 뒤 반영하지 않는다. 재가져오기 실패 시 이전 가져온 내용을 최신으로 취급하지 않는다. 직접 붙여넣은 텍스트는 독립 입력으로 표시한다.

## 검증 결과
- Node 24.21.0 / npm 11.19.0에서 npm run typecheck 통과.
- npm run build:desk 및 npm run build:dev 통과. core/editor/Studio 0.8.7 유지.
- 실제 HWP/HWPX 수정 → 편집본 다운로드 → 재열기 시 수정 내용 유지 확인.
- 실제 SDK 텍스트 추출과 요청문 생성 뒤 원본 문서 상태 보존 확인.
- git diff --check 통과.

## 잔여 위험
실제 교내 서식 호환성·Slack 운영 환경·AI 응답 품질은 별도 검증이 필요하다. 이 단계는 AI 호출을 제공하지 않으며 요청문을 사용자가 확인하고 전달하는 방식이다.

## 다음 단계 영향과 실행 근거
사용자의 즉시 개발·커밋·푸시 지시 범위로 Stage 3의 회귀 테스트, 사용자 문서, 최종 보고와 원격 게시를 이어 간다. 공용 배포나 PR merge는 포함하지 않는다.
