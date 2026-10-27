# D-HWP 첫 버전 수행계획서

GitHub Issue: [#1](https://github.com/buenosiempre-cmd/d-hwp/issues/1)
마일스톤: M001 (문서상 분류, 원격 마일스톤 미지정)

## 목적과 배경
RHWP for Slack의 고정 엔진을 재사용하여 동국 한글문서 도우미를 구현한다. 문서 편집과 AI 검토 준비를 한 화면에서 이어 가되 실제 AI API 호출은 분리한다.

## 범위
포함: D-HWP 로컬 문서 작업실, 기존 Slack 편집기의 AI 업무 패널, 전체 텍스트 가져오기·부분 붙여넣기, 4개 업무 요청문, 미리보기·복사·Markdown 저장, 초기화, 테스트와 실행 안내.
제외: 실제 Slack 설치/공용 배포, AI API 자동전송, 업무 승인/법률 판단, 그룹웨어 자동입력, 실문서 수집.

## 설계 방향
- postmelee/rhwp-slack main을 fork하여 core/editor/Studio 0.8.7 고정 조합 유지.
- src/assistant에 순수 요청문 생성 및 DOM 패널, src/desk에 Slack 계정 없이 로컬에서 여는 작업실을 둔다.
- src/editor는 기존 인증/저장 경로를 유지하고 같은 업무 패널만 추가한다.
- 문서와 프롬프트는 메모리에만 두며 직접 복사/다운로드 이외 전송·영속 저장하지 않는다.
- 전체 문서 GetTextFile('TEXT','')만 사용한다. saveblock을 선택 범위 추출로 사용하지 않는다.
- 표/이미지 의미가 텍스트에서 누락될 수 있음을 UI에서 안내하고 원문과 대조한다.
- 이번 fork 초기 task는 upstream 안정 main에서 시작하고 fork main 대상으로 PR을 만든다. inherited devel은 main보다 6개 커밋 뒤이므로 이를 기준으로 기능을 되돌리지 않는다.

## 문서 위치 판단
| 파일 | 분류/독자 | 위치 | 대안 | 이유 |
|---|---|---|---|---|
| README.md | 공개 개발 진입점 | 루트 | site | 실행과 현재 범위 안내 |
| docs/d-hwp.md | 사용자/운영 안내 | 기존 docs | mydocs/manual | 기존 공식 문서 루트 사용, 업무 절차와 데이터 경계 설명 |
| task 문서 | 작업 추적 | mydocs/plans, working, report | docs | 제품 문서와 작업 기록 구분 |

## 예상 변경 파일
src/assistant/*, src/desk/*, src/editor/main.ts 및 UI, scripts의 로컬 작업실 빌드/서버, package.json, 테스트, README, docs/d-hwp.md, 단계/최종 보고서.

## 잠정 단계와 검증
1. 요청문 모델·입력 검증·단위 테스트.
2. 업무 패널·로컬 문서 작업실·Slack 편집기 연결 및 빌드.
3. 브라우저 시나리오·기존 회귀·실행 문서·최종 보고와 push/PR.

타입 검사, 단위/Slack/보안 테스트, 프로덕션·개발 빌드, 실제 SDK 문서 가져오기·재열기·출력·초기화와 모바일 화면, git diff --check를 확인한다.

## 리스크
문서 호환성은 upstream 한계를 유지한다. 실제 Slack 임베드·운영 배포·AI 응답 품질은 이 작업의 검증 범위 밖이다. 공개 저장소에는 내부 대화·사용자 문서·인증정보를 넣지 않는다.

## 실행 근거
2026-10-28 사용자가 RHWP fork 기반 개발을 바로 진행하고 본인 GitHub에 커밋·푸시하도록 지시했다. 개발과 필요한 검증/작업기록은 이 지시 범위로 수행한다. 원격 merge·운영 배포는 수행하지 않는다.
