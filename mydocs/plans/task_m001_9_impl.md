# Task #9 구현계획

## 처리 흐름

기존 문서 카드의 `rhwp_export_options`에서 형식·쪽 선택 창을 연다. 서버가 문서 권한과 카드 메시지의 일치를 확인하고 요청자·팀·채널·카드·메시지에 연결한 5분 유효 선택 ID를 발급한다. 사용자는 TXT 또는 선택 PNG ZIP을 제출한다.

`document-exports.ts`에서 요청을 정규화한다. 카드별 `txt` 또는 `zip:1,3,4,5,12` 키로 독립 영수증을 보관한다. 기존 연속 이미지 갤러리에는 선택 결과를 합치지 않는다. 서로 다른 선택은 카드당 최대 20개이며 변환 전 실패는 슬롯을 회수한다. 이미 할당된 업로드 영수증은 불확실 응답에도 보존한다.

로컬은 진행 중 Promise와 SQLite metadata, Cloud는 카드 lease와 durable event를 사용한다. 원문 복원·접근·hash 검증, 변환 후 및 공유 직전 권한 확인을 적용한다. 업로드 bytes나 서명 URL은 상태 저장에서 제외하고 검증된 Slack 파일 ID·permalink만 남긴다. 결과 안내 직전에도 요청자의 권한을 확인한다.

## 모듈과 문서

- conversion: TXT/선택 쪽 모드, 프레임 검증, 결정적 ZIP. 기존 엔진 0.8.7 유지.
- server: ExportRequest, 선택 창, 로컬/Cloud 내보내기, 안내·오류 문구.
- 검증: 실제 합성 문서 변환, signed interaction, 권한 회수, 서로 다른 선택, 같은 선택 동시 요청과 재시작 영수증 복구.
- 사용자 문서: README, docs/d-hwp-slack.md, docs/d-hwp-upgrades.md. 내부 검증은 mydocs/에 둔다.

신규 명령 문법·Slack 권한·채널 allowlist는 추가하지 않는다. OCR·자동 AI 답변·표 Excel 변환은 이번 구현 범위에 없다.
