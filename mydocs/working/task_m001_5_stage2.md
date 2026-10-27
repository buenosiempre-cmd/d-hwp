# Stage 2 완료 — 분리된 실행 패키지

Node 24.21.0용 CJS 서버와 desk·Studio·WASM·폰트·라이선스를 allowlist로 묶는 package-desk를 추가했다. 환경 파일·MCP·개인 자료는 제외한다. 모든 파일 hash, 소스 SHA, sourceDirty를 manifest에 기록한다. 기존 출력 디렉터리를 덮어쓰지 않고 잘못된 manifest·외부 의존성·비정규 경로를 거부한다.

검증: 105개 파일 패키징, 104개 payload 파일 hash 및 manifest digest 일치, 덮어쓰기·잘못된 인자 거부, 외부/native 의존성 없는 번들 문법 확인. 최종 실행본은 깨끗한 커밋 후 다시 생성한다.

운영 준비: 사용자 소유 Mac에 별도 D-HWP launchd와 별도 Cloudflare tunnel을 구성했다. 기존 MCP 서비스 설정은 변경하지 않았다. MCP v0.12.0을 커밋 2009703081fc2616326644ae1ad34f68535d084f에서 추출하고 152개 잠금 의존성을 별도 설치했다. env -i/전용 HOME/NO_CACHE를 사용하는 finance 프로필에서 privatePacksConfigured=false, authenticatedUpstream=false, koreanLaw.configured=false를 실제 상태조회로 확인했다.

배포 후 HTTPS·재시작·실제 문서/MCP 확인은 Stage 3 보고에 기록한다. 운영 안내 위치는 계획대로 docs/d-hwp-deployment.md다.
