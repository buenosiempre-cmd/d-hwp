# Stage 1 — AI 업무 요청문 모델

GitHub Issue: [#1](https://github.com/buenosiempre-cmd/d-hwp/issues/1)
구현계획서: [task_m001_1_impl.md](../plans/task_m001_1_impl.md)

## 단계 목적
문서 요약, 공문 교정, 재무 검토 준비, 인수인계 요청을 원문 보존과 명시적인 검토 기준으로 구성한다.

## 산출물
- src/assistant/workflows.ts: 4종 업무, 입력 경계, JSON 참고자료, 파일명 정규화.
- tests/unit/d-hwp-workflows.test.ts: 원문 보존·최대 길이·잘못된 입력·제어문자/경로·출력 경계 6개 테스트.

## 본문 보존
문서명·추가 맥락·원문을 JSON으로 인코딩해 복원 가능하게 유지한다. 공백이나 줄바꿈을 삭제하지 않고 초과 입력은 오류로 반환한다. 요청문은 AI 출력/정확성을 보증하지 않는다.

## 검증 결과
node --import tsx --test tests/unit/d-hwp-workflows.test.ts: 6/6 통과.
해당 파일 strict TypeScript 검사 통과(담당 에이전트 검증). git diff --check 통과.

## 잔여 위험 / 다음 단계
AI 실제 응답 품질은 미검증. 다음 단계에서 패널·실제 문서 추출·복사·다운로드 흐름을 연결한다.

## 실행 근거
사용자 개발·커밋·푸시 지시에 따라 Stage 2를 이어 간다.
