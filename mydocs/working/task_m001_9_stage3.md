# Task #9 Stage 3 — 검증과 게시

README·Slack 설치 안내·기능 개선 검토를 docs/에 반영했다. 실행 사전 검사에 TXT·선택 쪽 PNG·ZIP 함수와 변환 번들 포함 여부를 추가했다. 별도 HTML 검토 보고서는 작업 폴더의 `d-hwp-upgrade-review.html`로 제공한다.

## 최종 로컬 검사

- `npm run typecheck`: 전체 3개 tsconfig 통과.
- `npm test`: 37/37.
- `npm run test:slack`: 285/285.
- `npm run test:security`: 91/91.
- 실제 conversion: 신규 10개 + 기존 Markdown 7개 + PDF/PNG 10개 = 27/27. 별도 실행한 프레임·오류 보안 6개는 위 91개와 중복.
- `node scripts/check-slack-runtime.mjs`: 7/7. 변환 캐시 해시·신규 기능 포함 확인. credentials나 Slack 설치 상태는 검사하지 않음.
- 합성 HWPX에서 실제 생성한 ZIP을 시스템 `unzip -t`로 독립 검사: 2개 PNG 정상.
- `git diff --check`: 통과.

## 게시와 설치 구분

게시 브랜치는 `origin/publish/task9`, 기준은 `publish/task7`이다. 커밋 후 원격 SHA를 확인하고 PR을 생성·연결한다. 새 GitHub CI 결과는 로컬 검사와 구분해 확인한다. 기존 Task #7의 push/PR CI는 모두 성공했다.

실제 Slack 설치는 브라우저의 신규 권한 부여 확인 대기 상태다. 실제 사용자에게 파일이나 메시지를 보내지 않았고, 기존 RHWP·규정 MCP·웹 작업실 프로세스도 변경하지 않았다. 이전에 준비한 Slack 실행 사본에는 이번 변경을 자동 반영하지 않았으므로 설치 시 새 검증 커밋을 포함한 릴리스를 사용해야 한다.
