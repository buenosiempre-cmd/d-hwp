# D-HWP · 동국 한글문서 도우미

**Slack에 올린 HWP·HWPX를 PDF, PNG 이미지, 원문 Markdown으로 변환합니다.**

동국대학교 구성원의 문서 업무 개선을 위한 CoP 시제품입니다. [RHWP for Slack](https://github.com/postmelee/rhwp-slack)을 포크해 동국대학교 업무 흐름에 맞추고 있으며, [rhwp](https://github.com/edwardkim/rhwp) core/editor/Studio **0.8.7**을 사용합니다. 기존 RHWP 문서 편집 기능도 유지합니다.

현재 설치 대상은 **동국대 재무팀 Slack**입니다. 사용자 소유 앱의 자격 증명 설정과 실제 Slack 설치·동작 확인은 별도 진행 사항입니다. 저장소 코드나 로컬 검사 통과만으로 설치가 완료된 것은 아닙니다. 학교 공식 서비스임을 뜻하지 않습니다.

## Slack에서 사용하기

1. 사용할 채널에 D-HWP 앱을 초대하고 HWP·HWPX 파일을 올립니다. 채널 ID를 미리 등록할 필요가 없습니다.
2. 파일 메시지 메뉴에서 **동국 한글문서 변환**을 선택하거나 D-HWP를 멘션합니다. 자동 감지가 켜진 채널에서는 업로드로 시작할 수 있습니다.
3. 결과 카드에서 **PDF 열기**, **PNG 이미지 (앞 10쪽)**, **원문 Markdown 만들기**를 선택합니다. 결과는 Slack의 해당 스레드에 공유합니다.
4. 수정이 필요하면 **문서 편집 (RHWP)**으로 열고 새 편집본을 저장합니다. 원본 파일을 덮어쓰지 않습니다.

| 명령 | 결과 |
|---|---|
| `/dhwp pdf <Slack 파일 링크>` | PDF 변환 |
| `/dhwp png <Slack 파일 링크>` | 앞 10쪽까지 PNG 이미지 |
| `/dhwp md <Slack 파일 링크>` | 원문 텍스트를 담은 `.md` 파일; `markdown`도 가능 |
| `/dhwp open <Slack 파일 링크>` | 문서 카드와 RHWP 편집 연결; `edit`도 가능 |
| `/dhwp help` | 사용법 |
| `/dhwp settings` | 관리자용 채널 설정 |

기본 미리보기는 PDF와 첫 3쪽 이미지입니다. 추가 이미지는 앞 10쪽까지 제공합니다. **원문 Markdown은 문서에서 추출한 텍스트이며 AI 요청문과 다릅니다.** AI 호출 없이 생성하고, 제목·표·줄바꿈·그림·서명·쪽 배치를 원본과 동일하게 복원하지는 않습니다. 스캔 그림의 OCR는 지원하지 않습니다.

새 앱은 `/dhwp`를 등록합니다. 서버는 기존 `/rhwp` 요청도 호환 처리하지만 새 manifest에 중복 등록하지 않아 기존 rhwp 앱의 명령을 가로채지 않습니다.

## 설치·실행

운영자는 [Slack 설치·배포 안내](docs/d-hwp-slack.md)에 따라 **사용자 소유 Slack 앱**, HTTPS 주소, 별도 실행 프로세스와 설정 파일을 준비합니다. 단일 워크스페이스 실행 경로는 다음과 같습니다.

```sh
# Node 24.21.0 / npm 11.19.0, Python 3
npm ci --ignore-scripts --no-audit --no-fund
npm exec playwright install chromium
npm run build
node scripts/check-slack-runtime.mjs

# 저장소 밖 0600 설정 파일을 준비한 뒤 실행
node --env-file=/absolute/private/d-hwp-slack.env --import tsx scripts/slack-preflight.ts
node --env-file=/absolute/private/d-hwp-slack.env --import tsx src/server/main.ts
```

필수 키·앱 manifest 적용 순서·초대에 따른 채널 활성화·launchd 및 터널 연결은 설치 안내에 설명합니다. 비밀값은 Git·채팅·빌드 산출물에 넣지 않습니다. 여유 공간이 작은 기존 운영 Mac에서는 새 의존성·브라우저 설치 전에 현재 자산을 확인하세요.

## 처리 범위와 정보 보호

- 입력은 파일당 **20 MiB·200쪽**까지입니다. HWP3·암호화 파일은 지원하지 않습니다.
- PDF는 최대 50 MiB, PNG는 앞 10쪽 범위, Markdown은 최대 2 MiB입니다. 무제한 이미지·ZIP 변환은 포함하지 않습니다.
- Slack 원본은 변환 서버로 내려받아 메모리에서 처리하고 결과를 Slack에 업로드합니다. 요청자·채널·원본 파일 접근 권한을 다시 확인합니다.
- 원본 문서와 변환 결과를 Git이나 애플리케이션 로그에 기록하지 않습니다. 운영 상태 DB에는 작업 연결·중복 처리 등 메타데이터를 보관합니다.
- 한컴과 모든 서식·출력이 같다고 보장하지 않습니다. 교내 대표 서식으로 결과를 대조한 뒤 업무에 사용하세요.

## 보조 기능

RHWP 편집기의 AI 업무 패널은 요약·공문 교정·재무 검토 준비·인수인계 요청문을 만듭니다. AI API가 답변을 생성하는 기능은 아직 연결하지 않았습니다. 선택적인 [규정 MCP 연동](docs/d-hwp-mcp.md)은 사용자가 전송 내용을 확인하고 실행할 때 동작합니다.

Slack 없이 내 컴퓨터의 파일을 열려면 `npm run desk`로 로컬 작업실을 사용할 수 있습니다. 기본 주소는 `http://127.0.0.1:4175/desk/`입니다. [로컬 작업실 안내](docs/d-hwp.md)는 보조 사용 경로이며 Slack 앱 설치를 대신하지 않습니다.

## 개발과 검증

```sh
npm run typecheck
npm test
npm run test:slack
npm run test:security
npm run test:viewer
# 로컬 작업실 변경이 있는 경우
npm run build:desk
npm run test:desk
```

로컬 검사는 합성 문서·Slack API 응답을 사용합니다. 실제 앱 설치, 채널에서의 요청, PDF·PNG·Markdown 업로드와 RHWP 편집은 실제 Slack에서 별도로 확인합니다.

- [Slack 설치·배포 안내](docs/d-hwp-slack.md)
- [규정 MCP 설정](docs/d-hwp-mcp.md)
- [이번 Slack 구현 계획](mydocs/plans/task_m001_7.md)
- [기반 프로젝트 개발 문서](docs/README.md): upstream 운영 이력은 D-HWP 배포 설정으로 재사용하지 않습니다.

## 출처와 라이선스

RHWP for Slack과 rhwp 원저작권을 유지합니다. [MIT License](LICENSE)와 엔진·라이브러리·폰트의 [제3자 고지](THIRD_PARTY_NOTICES.md)를 확인하세요. `site/`와 기존 운영 문서의 계정·토큰·주소는 upstream 운영자의 자원이며 D-HWP에서 사용하지 않습니다.

버그나 제안은 [D-HWP Issues](https://github.com/buenosiempre-cmd/d-hwp/issues)에 남겨 주세요. 실제 업무 문서·인증정보는 공개 이슈에 첨부하지 않습니다.
