# Task #7 Stage 3 — Slack 설치 준비와 게시

README를 Slack 문서 변환 중심으로 다시 작성하고 docs/d-hwp-slack.md에 새 앱 bootstrap/final manifest, 외부 0600 설정, 별도 HTTPS·4195 포트, 초대 기반 활성화, 고정 실행 사본 및 원복을 기록했다. 자격 증명·네트워크를 읽지 않는 runtime 검사 7개 모두 통과했다. manifest의 새 명령은 /dhwp이며 기존 앱과 충돌하지 않는다.

실제 Slack 앱 관리에서 동국대 재무팀 워크스페이스와 D-HWP manifest를 선택하고 Create and Install 직전의 권한 검토 화면까지 준비했다. 이 버튼은 파일 읽기·쓰기 등 새 접근권한을 부여하므로 브라우저 도구의 작업 시점 확인 규칙에 따른 사용자 확인이 필요하다. 앱 생성·설치·bot token 발급·실제 Slack 업로드는 아직 완료되지 않았다.

추가 Markdown 완료 응답 유실·동시 요청·상태 DB 재시작 복구 검사 2개 통과했다. 기존 file ID/영수증으로 재확인하며 중복 업로드·중복 complete가 발생하지 않는다. Git 원격 게시와 PR URL은 최종 대화에서 실제 확인 후 안내한다.
