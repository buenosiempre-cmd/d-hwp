# 제3자 구성 요소와 라이선스 고지

rhwp for Slack의 자체 코드·문서에는 MIT License를 적용합니다. 외부 구성 요소는 아래 원저작자의 조건을 따릅니다. 이 문서는 출처 안내이며 각 구성 요소의 라이선스 원문을 대체하지 않습니다.

## rhwp 엔진과 편집기

- rhwp / rhwp-studio / `@rhwp/core` / `@rhwp/editor`: **0.8.7**, MIT, Copyright (c) 2025–2026 Edward Kim.
- 고정 소스: `1a76570e833917d15817415a53c09ad61ab3203f`.
- [원본 MIT License](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/LICENSE).
- [upstream 제3자 라이선스 목록](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/THIRD_PARTY_LICENSES.md).
- [폰트 출처와 라이선스 목록](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/assets/fonts/FONTS.md).

빌드에는 upstream의 LICENSE·THIRD_PARTY_LICENSES.md·폰트 고지를 포함합니다. Studio, CanvasKit 및 폰트에 앱의 MIT License를 일괄 적용하지 않습니다. OFL·GUST·각 배포처의 개별 폰트 조건을 유지하세요.

## 앱의 직접 실행 의존성

버전과 라이선스는 현재 설치된 패키지 메타데이터와 lockfile 기준입니다. 전이 의존성과 빌드 도구에도 각 패키지의 원래 고지가 적용됩니다.

| 패키지 | 버전 | 라이선스 | 원본 프로젝트 |
|---|---|---|---|
| @google-cloud/firestore | 9.1.0 | Apache-2.0 | [Google Cloud Node](https://github.com/googleapis/google-cloud-node) |
| @google-cloud/tasks | 7.1.1 | Apache-2.0 | [Google Cloud Node](https://github.com/googleapis/google-cloud-node) |
| google-auth-library | 11.1.0 | Apache-2.0 | [Google Cloud Node](https://github.com/googleapis/google-cloud-node) |
| @playwright/test | 1.63.0 | Apache-2.0 | [Playwright](https://github.com/microsoft/playwright) |
| @slack/bolt | 5.1.0 | MIT | [Bolt for JavaScript](https://github.com/slackapi/bolt-js) |
| @modelcontextprotocol/sdk | 1.32.1 | MIT | [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| jose | 6.2.12 | MIT | [jose](https://github.com/panva/jose) |
| saxes | 6.0.0 | ISC | [saxes](https://github.com/lddubeau/saxes) |
| xmlchars (saxes 전이 의존성) | 2.2.0 | MIT | [xmlchars](https://github.com/lddubeau/xmlchars) |
| tsx | 4.23.13 | MIT | [tsx](https://github.com/privatenumber/tsx) |

서버·컨테이너 배포 시 패키지와 함께 제공되는 LICENSE·NOTICE를 유지합니다. Chromium 및 Node.js 배포물의 고지도 각 배포물에 포함된 조건을 따릅니다.

## 로고·시연 자료·외부 문서

화면·영상에 보이는 Slack UI와 상표, rhwp 로고, 외부 기관 문서는 각 권리자의 자료입니다. 앱의 MIT License가 이들 자료에 대한 별도 권리를 부여한다는 뜻은 아닙니다. 자체 서비스로 배포할 때는 운영자·연락처·정책을 자신의 내용으로 바꾸고 사용할 자산의 조건을 확인하세요.

앱의 라이선스와 서비스의 개인정보 처리·이용 안내는 서로 다른 문서입니다.

## 독립 품질 비교 도구

Kordoc 4.19.1 (MIT, [chrisryugj/kordoc](https://github.com/chrisryugj/kordoc))을 로컬 합성 문서 비교에 사용합니다. 운영 서버 의존성이 아니며 비교 실행 시 사용자가 별도로 설치한 모듈 경로를 명시합니다.
