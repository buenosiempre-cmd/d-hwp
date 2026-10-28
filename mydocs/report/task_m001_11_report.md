# D-HWP 구조 Markdown 품질 개선 결과

Issue [#11](https://github.com/buenosiempre-cmd/d-hwp/issues/11)

## 결과

단순 Unicode 본문에서 빠지던 머리말·꼬리말·각주·미주·수식·누름틀 정보·그림 설명·링크 주소를 구조 Markdown으로 보완했다. 병합/중첩 표의 좌표와 셀 내용, 원본과 그림, HWP 해석 구조, 대조 보고서를 ZIP으로 함께 제공한다. 기존 Markdown 버튼과 /dhwp md를 새 패키지에 연결했다.

사용자가 물은 Kordoc 참조 여부는 실제 실행으로 확인했다. 연결된 MCP와 로컬 4.19.1로 같은 합성 HWP/HWPX를 비교했고, 새 D-HWP는 독립 표식 28개 모두를 포함했다. Kordoc은 이 fixture에서 누름틀 안내/설명/이름과 그림 설명, HWPX 링크 주소가 빠졌다. 이 비교는 범용 정확도 측정이 아니며 운영 Kordoc/OCR 연동을 추가한 것은 아니다. 재현 스크립트와 [처리 범위](../../docs/d-hwp-markdown.md)를 남겼다.

## 검증과 한계

Typecheck, unit 37, Slack 287, security 101, conversion의 서로 다른 56개(총 481개)와 runtime 사전 검사 7개를 통과했다. 독립 리뷰에서 발견된 속성 이름 충돌 및 반복 문구 대조 문제도 회귀 검사와 재검증으로 해결했다. 원본·그림 바이트/해시와 병합 좌표, 권한 회수·재시작·응답 유실 복구를 검사했다.

모든 문서가 무누락으로 이해된다는 보장은 하지 않는다. XML 대응은 파싱된 텍스트에 대한 검사이며 그림 OCR·시각 의미·엔진이 읽지 못한 바이너리는 별도 확인 대상이다. 번호 목록의 실제 표기, 일부 변경 이력·미지원 구조도 검토 표시를 확인해야 한다. 한도 초과는 임의 절단 대신 실패 처리한다.

실제 동국대 재무팀 Slack 앱 설치, 사용자 채널에서 파일 전송, 대표 교내 양식의 대조는 남아 있다. 앞서 요청한 앱 권한 확인이 필요하며 새 검증 릴리스로 설치해야 한다. 사용자 원문·토큰·산출물을 Git에 넣지 않았다.

## 게시 경로

- 작업 브랜치 local/task11
- 원격 게시 대상 [publish/task11](https://github.com/buenosiempre-cmd/d-hwp/tree/publish/task11)
- PR 기준 publish/task9
- 상세 검증 [Stage 3](../working/task_m001_11_stage3.md)
- HTML 보고서: 작업 폴더 d-hwp-markdown-quality.html

원격 게시 SHA 및 CI 상태는 push 후 최종 전달에서 확인한다.
