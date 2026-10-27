# Stage 3.1 — 컨테이너 검증 파일 구성 수정

GitHub Issue: [#3](https://github.com/buenosiempre-cmd/d-hwp/issues/3)
구현계획서: [task_m001_3_impl.md](../plans/task_m001_3_impl.md)
Stage: 3.1

## 단계 목적

PR #4의 컨테이너 CI에서 발견한 검증 이미지 구성 누락을 수정한다.

## 산출물

| 파일 | 변경 요약 |
|---|---|
| Dockerfile | smoke 대상에 scripts/serve-desk.mjs 포함 |
| 최종 보고서·오늘 할일 | 원격 발견 및 보완 근거 기록 |

## 본문 변경 정도 / 본문 무손실 여부

검증용 이미지의 파일 구성만 변경했다. release 이미지·앱 동작·문서 처리 로직은 변경하지 않는다.

## 검증 결과

- [최초 PR CI](https://github.com/buenosiempre-cmd/d-hwp/actions/runs/40552958555)의 컨테이너에서 security 81/82. 새 malformed URL 검사가 로컬 서버 시작 단계에서 실패했다.
- Dockerfile smoke COPY에 serve-desk.mjs가 없음을 확인했다. 해당 스크립트의 src/SDK/tsx 의존성은 기존 runtime 구성에 있다.
- 임시 smoke 파일 구성에서 같은 테스트의 실패를 재현했다. 파일을 추가한 뒤 동일 테스트 1/1 통과.
- git diff --check 통과. Docker 실행 도구가 로컬에 없어 Linux read-only 전체 이미지는 수정 커밋의 GitHub CI로 재검증한다.

## 잔여 위험

전체 원격 재검증 완료 여부는 PR의 최신 CI를 확인한다.

## 다음 단계 영향

같은 publish/task3 및 PR #4에 수정 커밋을 게시한다. 테스트를 생략하거나 검증 조건을 약화하지 않는다.

## 승인 요청

사용자의 구현·커밋·푸시 지시 범위 내 CI 수정으로 진행한다.
