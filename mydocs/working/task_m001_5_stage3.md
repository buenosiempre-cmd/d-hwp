# Stage 3 완료 — 실제 배포와 검증

배포 주소: https://d-hwp.kr-univ-rules.com/desk/

실행 소스: 10feff474aad23d6732ff99c234f6c92c7394139. 깨끗한 소스에서 만든 105개 파일의 release digest는 54658eead90080a9c9bd6d8e3b0248823771ed840118b08653d1aded64aa438a다. 활성화 전 payload SHA-256을 모두 재확인했다.

외부 HTTPS Chromium으로 native 로그인 303, 합성 HWP 2페이지 열기·편집·다운로드, 실제 MCP v0.12.0 상태·여비규정 제3조 검색·재무 검토를 확인했다. 모바일 가로 넘침 없음, 브라우저 오류 0, 로그아웃 뒤 health 401을 확인했다. 여비규정 근거는 규정 184/개정본 3350으로 표시됐다. 검토 결과는 업무 승인이나 지급 가능 판단이 아니다.

별도 launchd 프로세스를 종료한 뒤 KeepAlive가 새 PID로 재시작하고 이전 세션은 401, 신규 로그인·health는 정상임을 확인했다. 기존 MCP와 기존 터널은 계속 실행 중이다. 런타임에 비공개 팩, 상류 쿠키, 한국법령 키가 없음을 상태 응답으로 확인했다.

자동 검사: 로컬 typecheck, unit 37, security 89, deployment 7, desk 71 통과(204개). 배포 코드 CI: https://github.com/buenosiempre-cmd/d-hwp/actions/runs/40596647323. 이전 Stage 1-2 CI도 viewer/container 모두 통과했다.

실제 폼 no-referrer 실패를 재현하는 fault injection과 정상 로그인·로그아웃의 브라우저 회귀 2개를 추가했다. 디스크 부족 시 이번 작업의 임시 패키징 출력과 사용하지 않는 Wrangler 점검 설치만 정리했다. 운영 실행본·MCP snapshot·라이선스와 별도 인증 파일은 유지했다.

한계: 공용 비밀번호 시제품이며 개별 이메일 인증·명단 관리는 아직 없다. 비밀번호는 소유자 전용 로컬 파일에만 전달했다. Mac 전원·로그인·네트워크에 의존한다. 상류 비공개자료와 법령 연결 미설정은 해당 결과에 명시된다. RHWP 엔진과 Slack 명령은 유지되며 기존 PR을 병합하지 않았다.
