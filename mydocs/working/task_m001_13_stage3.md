# Task #13 Stage 3 — 최종 검증과 게시

- 전체 3개 tsconfig의 typecheck 통과.
- Unit 37, security 106, conversion 75, Slack 290개 통과 후 Cloud 영수증 회귀 1개 추가. 영향 파일 4/4 재검증. 서로 다른 Slack 검사는 291개이며 전체 합계는 509개다.
- 공개 고정 코퍼스 8/8 통과. 최종 parser 번들에서 동적 쪽 번호의 검토 코드까지 확인했다.
- 실제 OCR 프로필 무결성과 HWP/HWPX 패키지 두 형식을 확인했다. 단순 adapter만 시험한 결과가 아니다.
- Runtime 오프라인 사전 검사 7개 통과. 실제 Slack 설치·토큰·이벤트 도달을 증명하지는 않는다.
- 독립 감사 → 수정 → 재검증에서 추가 차단 결함이 없었다. OCR 장애 복구 후 같은 카드 재처리와 전체 Worker 경로도 확인했다.
- 새 CI에 공개 코퍼스 gate를 추가했다. Docker smoke는 network-none/read-only/4 GiB 환경의 실제 구조 Markdown 패키지 변환도 검사한다. 기본 이미지에는 외부 OCR 런타임·모델이 없으므로 Linux OCR 실행까지 검증했다고 표시하지 않는다.

기준 PR #12의 push·PR CI는 viewer/container 모두 성공했다. 이번 publish/task13의 CI와 원격 SHA는 push 후 확인한다. 실제 Slack 앱은 필수 자격 증명 3개가 비어 있고 전용 프로세스가 시작되지 않았다. 원문·비밀값을 Git에 넣지 않았으며 기존 RHWP·규정 MCP·웹 작업실 서비스를 변경하지 않았다.
