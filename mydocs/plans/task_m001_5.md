# D-HWP CoP 인증 배포 수행계획서

Issue: [#5](https://github.com/buenosiempre-cmd/d-hwp/issues/5), M001

## 목적과 승인 근거

사용자의 “배포해” 및 “CoP 구성원 한정 — 접속 인증 필요” 지시에 따라 문서 데스크와 규정 MCP를 실제 HTTPS 주소로 제공한다. 기존 커밋·푸시 지시도 유지된다. 이 지시 범위의 구현, 검증, 배포 및 게시를 추가 단계 승인 없이 수행한다. 인증 방식과 허용 대상은 사용자의 후속 선택을 반영한다.

## 범위와 문서 위치

- 명시적 HTTPS origin, 인증 전 UI/API 차단, 보안 회귀 검사.
- Node 24 실행 번들과 고정 release, 별도 launchd/Cloudflare Tunnel 배포 및 원복.
- 공개된 교내 규정만 조회하는 분리된 MCP 실행 환경. 기존 운영 서비스와 비밀 설정은 재사용하지 않는다.
- 제품 운영 안내는 기존 공식 문서 루트 docs/의 d-hwp-deployment.md. 작업 추적은 mydocs/plans, working, report 및 orders. 사용자용 HTML 배포 보고서는 저장소 밖 workspace에 작성한다.
- RHWP 엔진 0.8.7, /rhwp, 원본 라이선스를 유지한다. 기존 PR 병합·이슈 종료·메시지 발송은 포함하지 않는다.

## 단계와 수용 기준

1. HTTPS origin/인증 기능과 검사: 인증 전 모든 앱 자원/API 차단, 불일치 Host/Origin 차단, 민감정보 응답·로그 누출 없음.
2. 실행 번들/운영 배포: 개발 checkout과 분리, 지속 실행 및 재시작, HTTPS 인증 후 UI/MCP 확인.
3. 회귀/보고/게시: 적절한 기존 검사, 실제 브라우저 확인, release와 원격 SHA 대조, 운영 한계와 원복 기록.

## 검증·원복

typecheck, 관련 단위·보안·desk 테스트, git diff --check를 수행한다. 실제 인증된 HTTPS에서 파일 열기와 규정 연결을 합성 문서로 확인한다. 장애 시 D-HWP 터널/서비스만 중지하거나 이전 release로 current를 되돌린다. Mac 로그인·전원·네트워크 의존성을 사용자에게 명확히 보고한다.
