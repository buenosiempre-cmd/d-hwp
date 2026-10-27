# D-HWP CoP 배포

문서 데스크는 Node 24.21.0 한 프로세스에서 UI, Studio 자산, 규정 API를 함께 제공한다. HTTPS 앞단에는 사용자 소유 Cloudflare Tunnel을 사용한다. 기존 Slack 서버와 별도 프로세스다.

## CoP 접속

첫 시제품은 공용 비밀번호로 접속을 제한한다. 구성원별 이메일 인증은 아직 구성하지 않았다. 비밀번호를 받은 사람은 접속할 수 있으므로 관리자가 CoP 구성원에게만 직접 전달한다. 명단 변경 시 비밀번호를 바꾸고 서비스를 재시작한다. 개인별 권한 회수·접속 감사가 필요하면 별도의 이메일 인증 정책으로 전환해야 한다.

비밀번호는 scrypt 해시로 설정 파일에 저장한다. 세션은 메모리에만 보관하며 8시간 후, 로그아웃 또는 서비스 재시작 시 만료된다. 쿠키는 Secure, HttpOnly, SameSite=Strict를 적용한다. UI·정적 자산·API·health 모두 인증을 요구한다. 로그인 폼만 공개한다. 로그인 시도는 서비스 전체에서 15분당 60회로 제한한다.

## 빌드와 설정

```sh
npm ci --ignore-scripts
npm run build:desk
npm run typecheck
npm run test:security
npm run test:deployment
npm run test:desk
node scripts/package-desk.mjs --out /absolute/new-release-directory
node scripts/create-desk-auth.mjs --out /absolute/new-private-auth-directory
```

인증 생성기는 새 폴더에 `auth.json`과 `access.txt`를 소유자 전용 권한으로 만든다. 비밀번호를 stdout에 출력하지 않는다. 두 파일 모두 Git·공유 보고서·공개 저장소에 넣지 않는다.

| 환경설정 | 용도 |
|---|---|
| `PORT` | loopback 수신 포트, 기본 4175 |
| `DHWP_DESK_PUBLIC_ORIGIN` | 정확한 HTTPS origin. 경로·마지막 `/`·query·credential 불가 |
| `DHWP_DESK_AUTH_FILE` | 공개 origin에서 필수. 권한 0600 인증 JSON 절대경로 |
| `DHWP_RULES_MCP_COMMAND` | 별도 고정 MCP를 실행하는 Node 절대경로 |
| `DHWP_RULES_MCP_ARGS` | `["/absolute/mcp/src/index.js","--profile","finance"]` 형태 JSON |
| `DHWP_RULES_FINANCE_ENABLED` | 재무 검토를 사용할 때만 `true` |

설정 없이 `npm run desk`는 기존 로컬 작업실로 동작한다. 공개 origin은 인증 파일 없이 시작할 수 없다. Host 및 API·로그인 Origin은 설정된 값과 정확히 일치해야 한다. `X-Forwarded-*`로 origin을 대체하지 않는다. HTTP는 loopback에서만 수신하며 외부 연결은 HTTPS 터널로 받는다.

배포본은 `server.cjs`, `dist/desk`, `dist/studio`, static manifest와 라이선스만 포함한다. 실행에는 별도 `node_modules`가 필요 없다. `release-manifest.json`에 소스 SHA, 각 파일 hash, 빌드 상태를 기록한다. `sourceDirty: false`인 커밋 기반 패키지를 배포한다. 인증·환경·사용자 문서·MCP는 번들에 포함하지 않는다.

## MCP 분리

동국규정 MCP v0.12.0의 고정 커밋에서 전체 `src/`, `package.json`, `npm-shrinkwrap.json`, `LICENSE`만 추출하고 `npm ci --omit=dev --ignore-scripts`로 독립 설치한다. 기존 MCP 운영 디렉터리나 비공개 자료를 복사하지 않는다.

서비스는 `/usr/bin/env -i`로 환경을 비우고 허용한 설정만 전달한다. MCP용 HOME도 별도 빈 폴더로 둔다. `DONGGUK_MCP_NO_CACHE=1`로 디스크 캐시를 끈다. 이 배포의 `finance` 프로필은 공개 규정과 내장 검토 흐름만 사용하며 상류 로그인 쿠키, 내부 재무팩·실무자료, 한국법령 키는 연결하지 않는다. 자료 미연결·적용 미확인 결과는 판단 근거의 한계로 표시한다.

## 지속 실행과 원복

macOS에서는 실행본을 `~/Library/Application Support/D-HWP/releases/<commit>/`에 두고 `current` 심볼릭 링크로 선택한다. 별도 launchd 서비스 `com.bueno.d-hwp`가 고정 Node 바이너리와 `current/server.cjs`를 실행한다. `com.bueno.d-hwp-tunnel`이 별도 터널을 유지한다. 두 서비스는 RunAtLoad·KeepAlive를 사용한다.

Mac 전원, 사용자 로그인 및 네트워크가 유지되어야 접속할 수 있다. 독립 클라우드 서버의 가용성을 제공하는 구성이 아니다. 로그는 시작·장애 진단만 남기고 비밀번호·문서 본문·규정 요청을 기록하지 않는다.

인증 우회, 반복적인 5xx, 핵심 문서 열기/MCP 실패를 발견하면 새 배포를 중지한다. 첫 릴리스는 D-HWP 터널과 서비스만 중지하면 된다. 이전 릴리스가 있으면 검증된 이전 경로로 `current`를 원자적으로 교체한 후 앱만 재시작한다. 기존 동국규정 MCP 서비스와 터널은 수정하지 않는다.

```sh
launchctl bootout gui/$(id -u)/com.bueno.d-hwp-tunnel
launchctl bootout gui/$(id -u)/com.bueno.d-hwp
# 이전 current 연결을 복원한 뒤 앱 plist와 터널 plist를 bootstrap
```

인증 후 `/healthz`는 `{"ok":true}`만 반환한다. 배포 점검은 비인증 UI 303·API 401, 인증된 UI와 health 200, 실제 규정 상태 조회, 합성 HWP 열기·편집·다운로드, 재시작 후 세션 만료를 포함한다. 비밀번호 변경은 새 인증 폴더를 생성하고 서비스의 파일 경로를 바꾼 뒤 재시작한다.

Cloudflare 명령과 ingress 구성은 [공식 locally managed tunnel 안내](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)를 따른다. 구성원별 이메일 정책 전환 시 [Access 정책](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)을 기준으로 허용 목록과 원본 서버 인증을 함께 검증한다.
