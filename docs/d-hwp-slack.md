# D-HWP Slack 설치·배포 안내

D-HWP는 Slack의 HWP·HWPX 파일을 PDF, 앞 10쪽 PNG 갤러리, 원문 Markdown·TXT, 선택 쪽 PNG ZIP으로 변환하는 CoP 시제품입니다. RHWP 편집과 새 편집본 저장도 유지합니다. 설치 대상은 동국대 재무팀 Slack이며, **사용자 소유 앱의 자격 증명 설정과 실제 설치 검증은 아직 필요합니다.** 이 문서는 설치 준비 절차이며 운영 완료 기록이 아닙니다.

## 1. 별도 Slack 앱과 주소 준비

기존 rhwp 앱·D-HWP 로컬 작업실·규정 MCP 서비스를 변경하거나 중지하지 않습니다. 다음 구성을 별도로 준비합니다.

| 항목 | D-HWP Slack 구성 |
|---|---|
| Slack 앱 | 사용자 소유 **D-HWP · 동국 한글문서 도우미** |
| 명령 | 신규 `/dhwp`; `/rhwp`는 서버 호환 처리만 유지 |
| HTTPS | 예: `https://dhwp-slack.example.org`처럼 별도 hostname |
| 로컬 수신 | `127.0.0.1:4195` 예시. 실제 비어 있는 포트인지 먼저 확인 |
| 실행 | Node 24.21.0, 별도 launchd label과 고정 릴리스 작업 디렉터리 |
| 상태 | 릴리스 밖 D-HWP Slack 전용 SQLite 파일 |
| 사용 채널 | 앱을 초대하면 활성화. 요청자도 해당 채널에 참여해야 함 |

위 도메인은 자리표시자입니다. 기존 4185 작업실·3845 MCP 등 다른 서비스의 포트와 구분합니다. 사용할 채널에 앱을 초대하면 바로 활성화하므로 채널 ID를 미리 등록하지 않습니다. `SLACK_CHANNEL_IDS`는 비워 둡니다.

현재 서버는 **HTTP Events API** 방식입니다. Socket Mode를 켜거나 app-level token을 추가하는 것으로 이 서버가 Socket Mode로 바뀌지는 않습니다. HTTPS 터널은 `/slack/events`, `/editor/`, `/static/`, `/api/editor/` 등을 이 서버로 전달합니다.

Slack의 서버 요청은 웹 로그인 화면을 통과할 수 없습니다. `/slack/events` 앞에 작업실 비밀번호 로그인이나 대화형 Access 로그인을 적용하지 않습니다. 이 경로에는 Bolt의 Slack 서명·시각·앱·워크스페이스 검증이 적용되고, 문서 API에는 별도의 일회성 ticket·세션·파일 권한 검사가 적용됩니다.

## 2. 앱 만들기와 manifest 적용

[Slack 앱 관리](https://api.slack.com/apps)에서 **Create New App → From a manifest**를 선택하고 사용자가 관리하는 재무팀 워크스페이스를 고릅니다. manifest는 동작 중인 서버가 없어도 앱을 먼저 만들 수 있게 두 단계로 생성합니다.

```sh
node scripts/slack-manifest.mjs --bootstrap
```

출력된 JSON을 앱 생성 화면에 붙여 넣습니다. bootstrap은 아직 연결되지 않은 Events·Interactivity·명령 주소를 생략합니다. 이후 앱을 해당 워크스페이스에 설치하고, **Basic Information**의 App ID·Signing Secret과 **OAuth & Permissions**의 Bot User OAuth Token을 권한 제한 설정 파일에 보관합니다. 설치 승인 정책에 따라 워크스페이스 관리자의 승인이 필요할 수 있습니다. [Slack manifest 공식 안내](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)

서버와 터널을 준비한 다음 실제 HTTPS origin으로 최종 manifest를 생성합니다.

```sh
node scripts/slack-manifest.mjs --origin https://dhwp-slack.example.org
```

앱의 **App Manifest**에 적용하고 `/dhwp`, Events, Interactivity가 모두 해당 origin의 `/slack/events`인지 확인합니다. scopes가 바뀌었으면 앱을 재설치해 승인합니다. 현재 bot 권한은 `commands`, `chat:write`, `files:read`, `files:write`, `channels:read`, `groups:read`, `app_mentions:read`, `reactions:write`입니다. 채널 메시지 전체 이력을 읽는 권한은 사용하지 않습니다.

RHWP를 Slack 안에서 편집하려면 앱 설정의 **Work Object Previews**에서 Work Objects/file entity를 활성화하고 편집기 hostname을 허용합니다. `allow-same-origin`도 확인합니다. manifest 생성만으로 이 설정이 완료되었다고 간주하지 않습니다. 자기 워크스페이스의 비배포 앱은 embeds를 사용할 수 있고, Marketplace 배포 앱은 별도 초대 조건이 있습니다. [Slack embeds 공식 안내](https://docs.slack.dev/messaging/work-objects-embeds/)

기존 rhwp 앱을 제거할 필요는 없습니다. 새 manifest는 `/dhwp`만 등록합니다. 같은 `/rhwp`를 새 앱에도 등록하면 최근 설치 앱이 호출되는 Slack 규칙 때문에 기존 앱 사용에 영향을 줄 수 있습니다. [명령 충돌 규칙](https://docs.slack.dev/interactivity/implementing-slash-commands/)

## 3. 비밀 설정과 상태 파일

저장소 밖에 새 설정 파일을 만들고 권한을 `0600`으로 제한합니다. 아래 예시의 빈 값과 자리표시자를 **새 사용자 소유 앱**의 값으로 채웁니다. 채팅·Git·명령 출력에 실제 값을 남기지 않습니다.

```dotenv
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
SLACK_APP_ID=
SLACK_TEAM_ID=
SLACK_WORKSPACE_HOST=
SLACK_CHANNEL_IDS=
SLACK_ADMIN_USER_IDS=
APP_ORIGIN=https://dhwp-slack.example.org
HOST=127.0.0.1
PORT=4195
STATE_DB_PATH=/absolute/private/d-hwp-slack/state.sqlite
SLACK_REACTIONS_ENABLED=true
DHWP_RULES_SLACK_ENABLED=false
DHWP_RULES_FINANCE_ENABLED=false
```

`SLACK_WORKSPACE_HOST`는 `https://` 없이 workspace의 `.slack.com` hostname을 사용합니다. 관리자 ID는 쉼표로 구분합니다. `SLACK_CHANNEL_IDS`는 과거 초기 설정과의 호환용 선택 항목입니다. 빈 값으로 시작해도 앱을 초대하면 해당 채널이 활성화되며, 이후 App Home/관리자 설정을 사용할 수 있습니다. 규정 MCP는 문서 변환에 필수 사항이 아니므로 별도 접근 범위를 설정하기 전에는 비활성화합니다. 다른 서비스의 `.env`, 쿠키, 개인 자료팩, 법령 인증정보를 가져오지 않습니다.

`EDITOR_ORIGIN`을 생략하면 편집기·Studio·API를 `APP_ORIGIN` 하나로 제공합니다. 별도 정적 호스트는 이 최초 설치에 필요하지 않습니다.

## 4. 빌드와 실행

처음 설치하는 환경에서는 Node **24.21.0**, npm **11.19.0**, Python 3을 준비합니다. 기존 Mac의 여유 공간이 부족하면 무조건 `npm ci`·Chromium 재설치를 실행하지 말고 기존 버전과 자산부터 확인합니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm exec playwright install chromium
npm run build
node scripts/check-slack-runtime.mjs
```

`check-slack-runtime.mjs`는 네트워크·환경 파일·Slack credentials를 사용하지 않는 사전 검사입니다. Node/엔진 버전, Chromium 실행 파일 존재, 정적 자산 및 변환 자산·폰트 해시를 검사합니다. 브라우저 실행·실제 변환·Slack 설치 완료를 대신하지 않습니다. `lowDiskSpace`가 `true`면 릴리스 복사와 변환용 임시 공간을 먼저 확보합니다.

릴리스 작업 디렉터리에서 아래 명령을 실행합니다. 설정 파일 경로는 실제 외부 경로로 바꿉니다.

```sh
node --env-file=/absolute/private/d-hwp-slack.env --import tsx scripts/slack-preflight.ts
node --env-file=/absolute/private/d-hwp-slack.env --import tsx src/server/main.ts
```

첫 명령은 `auth.test`로 설치된 bot·워크스페이스와 일부 production 자산을 확인하며 원문 응답이나 토큰을 출력하지 않습니다. 둘째 명령은 `127.0.0.1:4195`에서 시작합니다. launchd에는 위 Node의 **고정 절대경로**, 같은 arguments, 고정 릴리스 `WorkingDirectory`, D-HWP Slack 전용 label과 로그 경로를 지정합니다. `PATH`에서 우연히 찾은 다른 Node 버전이나 개발 중인 checkout에 의존하지 않습니다.

## 5. 공간을 아끼는 별도 릴리스

이 단일 워크스페이스 경로에는 Docker 이미지, Firestore, Cloud Tasks가 필요하지 않습니다. 실행용 최소 파일 범위는 다음과 같습니다.

- `package.json`, `package-lock.json`, `LICENSE`, `THIRD_PARTY_NOTICES.md`
- `src/server/`, `src/shared/`, `src/conversion/` 및 실행에 필요한 고정 `node_modules/`
- `dist/editor/`, `dist/studio/`, `dist/static-manifest.json`
- `.cache/conversion/` 전체: print·변환 child 번들, runtime manifest, 폰트
- `scripts/slack-preflight.ts`, `scripts/check-slack-runtime.mjs`

빌드를 마쳤다면 큰 `.cache/studio-source`, `.cache/studio.tar`, `tests`, `site`, `dist/desk`, 기존 사용자 `.env`와 상태 DB는 이 실행 사본에 필요하지 않습니다. Markdown·TXT·선택 쪽 이미지 변환은 PDF 변환 child 번들에 포함되며 별도 엔진을 설치하지 않습니다.

Chromium과 Node는 기존의 **고정된 전용 설치 경로**를 참조해 중복 설치를 피할 수 있습니다. macOS/APFS에서 별도 릴리스 파일을 만들 때 copy-on-write clone을 사용할 수 있으나, 파일시스템 지원과 실제 추가 사용량을 확인해야 합니다. 개발 checkout을 가리키는 심볼릭 링크나 수정이 전파되는 hard link를 immutable 릴리스로 취급하지 않습니다. 실행 버전·원본 커밋·자산 해시를 기록하고 새 릴리스 단위로 교체합니다.

실행 프로세스에는 입력 크기·쪽수·시간·큐 제한과 자격 증명을 제외한 변환 child가 있습니다. 이 Mac 경로는 컨테이너 격리나 OS 메모리 하드 상한을 제공하지 않습니다. 현재 Chromium sandbox 옵션도 활성화하지 않았으므로 소규모 CoP 운영 범위와 실제 자원 사용량을 확인합니다.

## 6. 실제 Slack 수용과 원복

1. 사용할 채널에 새 D-HWP 앱을 초대하고 요청자도 참여합니다. 사전 채널 ID 등록 없이 활성화되는지 확인합니다.
2. 합성 HWP·HWPX 파일로 PDF, 첫 3쪽·앞 10쪽 PNG, 원문 Markdown·TXT, `1,3-5,12` 선택 쪽 PNG ZIP을 같은 스레드에서 확인합니다. 12쪽 이상인 합성 문서를 사용하세요.
3. Markdown·TXT 안의 원문과 ZIP 내부 선택 쪽을 확인합니다. 그림·표·줄바꿈 한계도 원본과 비교하고, 없는 쪽·11개 이상 선택·만료된 선택 창이 거부되는지 확인합니다.
4. RHWP 편집을 열고 새 편집본을 저장한 뒤 Slack 결과와 재열기를 확인합니다.
5. 앱이 참여하지 않은 채널·권한 회수·삭제된 원본은 거절되는지 확인합니다. 원본 내용·토큰이 로그에 남지 않는지 확인합니다.
6. 별도 프로세스를 재시작한 뒤 상태 복구와 같은 요청의 중복 업로드 방지를 확인합니다.

장애가 있으면 신규 D-HWP Slack 프로세스·터널 연결만 중지하거나 직전 검증 릴리스로 되돌립니다. 기존 rhwp 앱, 다른 작업실, 규정 MCP 서비스와 사용자 Slack 파일은 유지합니다. Mac 전원·로그인 세션·네트워크에 따른 가용성 한계를 운영 기록에 남깁니다.

실제 앱 생성·설치·HTTPS 요청·업로드 결과가 확인되면 그 증거와 미검증 항목을 별도 배포 기록에 남깁니다. 이 안내만으로 실제 배포 성공을 표시하지 않습니다.
