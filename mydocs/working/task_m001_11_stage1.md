# Task #11 Stage 1 — 구조 추출과 독립 대조

HWPX 원본 ZIP/XML을 spine 순서로 파싱하고 HWP는 RHWP exportHwpxWithReport의 해석본을 사용한다. 본문·표 좌표/병합/중첩·주석·머리말·글상자·수식 원문·필드/링크와 포함 개체를 보존한다. 모르는 텍스트·속성과 XML 대조에서 찾지 못한 엔진 본문은 보충 섹션에 기록한다.

ZIP CRC·길이·경로·압축 해제 한도, XML 외부 entity/DTD 금지·깊이/노드/속성 한도와 전체 출력 제한을 적용했다. 원문 Markdown/HTML 문법을 이스케이프하며 지원하는 래스터만 해시 파일 이름으로 참조한다. 원본, HWP의 해석 구조, 그림, document.md, report.json을 패키지로 묶는다.

복합 합성 문서는 엔진 API로 각 기능을 작성하고 생성 여부를 별도로 검증한다. 기존 Unicode 추출의 누락을 재현한 다음 실제 변환 결과의 표식·순서·표 좌표·원본/이미지 SHA256을 검사했다. 파서 단위 13개, ZIP/XML 보안 10개, 실제 통합 6개, 패키지 프레임 10개가 신규 검사다.

Kordoc MCP와 로컬 4.19.1을 실제 실행했다. 보존 옵션을 켠 같은 합성 HWP/HWPX에서 Kordoc은 누름틀 안내/설명/이름과 그림 설명, HWPX 링크 주소를 출력하지 않았다. 새 D-HWP의 독립 내용 표식 28개는 양쪽 모두 확인했다. 재현 스크립트 scripts/audit-markdown-kordoc.mjs를 추가했다. 운영 Kordoc/OCR 의존성은 추가하지 않았다.
