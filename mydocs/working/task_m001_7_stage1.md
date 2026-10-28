# Task #7 Stage 1 — 실제 문서 Markdown 변환

RHWP 0.8.7의 getTextFileUnicode로 HWP/HWPX 원문을 추출하고 일반 Markdown 문단으로 변환한다. 원문에서 HTML·외부 이미지·링크 실행 구문을 만들지 않도록 이스케이프한다. 표 셀은 평문이며 레이아웃·그림·OCR를 보존한다고 주장하지 않는다.

출력 2 MiB 상한, UTF-8/프레임 무결성, 기존 격리 프로세스와 취소·시간 제한을 적용했다. Node 24.21.0에서 신규 및 프레임·실패 분류 검사 13개와 기존 PDF/PNG 실렌더 10개, 총 23개 통과. 실제 엔진 합성 HWP/HWPX 검사이며 실제 Slack 검증은 아니다.
