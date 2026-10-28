# Task #11 Stage 2 — Slack Markdown 패키지

기존 Markdown 버튼과 /dhwp md를 구조 Markdown ZIP으로 연결했다. 로컬·Cloud 모두 공통 내보내기 권한/원본 해시/동시 요청/영수증 복구 경로를 사용한다. 새 key markdown-v2를 사용해 이전 .md 영수증을 구조 패키지로 재사용하지 않는다. 결과 파일 이름은 원본명_Markdown.zip이다.

파일에는 원본과 이미지도 포함된다. 같은 스레드에 첨부하며 다운로드 전에 권한을 재확인한다. ZIP 결과의 문서 크기/보고서 버전/ZIP signature를 검증하고 자격 증명이 없는 격리 변환 워커에서 구조를 처리한다. 패키지 payload와 서명된 업로드 URL을 상태 DB에 저장하지 않는다.

합성 Slack API 검사로 새 파일의 실제 ZIP 바이트와 내부 구성, 로컬/Cloud legacy 영수증 분리, 권한 회수, 응답 유실, 동시 요청 및 재시작 복구를 확인했다. 실제 Slack 사용자에게 시험 메시지를 보내지 않았다.
