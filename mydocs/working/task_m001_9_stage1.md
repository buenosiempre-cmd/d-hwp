# Task #9 Stage 1 — 변환 기능

## 구현

별도 격리 런타임에 TXT와 선택 쪽 PNG 모드를 추가했다. `convertText`는 실제 RHWP Unicode 원문을 UTF-8로 반환한다. `convertSelectedPageImages`는 1~200쪽 중 최대 10쪽을 정렬·중복 제거한 뒤 정확히 해당 쪽만 반환한다. 실제 쪽수를 벗어나면 전체 요청을 거부한다. `convertPageZip`은 결과 PNG를 고정 ASCII 이름·고정 날짜·CRC32·STORE 형식으로 묶는다. 추가 패키지는 없다.

TXT 2 MiB, PNG 5 MiB/쪽·합계 25 MiB, ZIP 26 MiB 제한과 기존 시간·큐·문서 제한을 적용했다. 기존 PDF·앞 3/10쪽 PNG·Markdown 경로를 보존했다. 선택 쪽의 앞선 종이 geometry를 유지해 단일 쪽 재시도 시에도 픽셀 결과가 일치한다.

## 검증

Node 24.21.0에서 변환 캐시를 재빌드했다.

- 신규 `tests/conversion/exports.test.mjs`: 10/10. HWP/HWPX TXT 실제 원문·표 셀 일치, 80쪽 시험 문서의 12·40·80쪽 추출, ZIP 내부 파일·CRC 일치, 요청값 복사, 초과 범위·악성 프레임·크기·취소 검사.
- 기존 `markdown.test.mjs` 7개, `render.test.mjs` 10개 통과.
- `conversion-frames.test.mjs` 4개, `conversion-failures.test.mjs` 2개 보안 검사 통과. 이 6개는 전체 security suite와 중복이므로 총수를 합산하지 않는다.

실제 사용자 문서나 Slack 채널에 파일을 전송하지 않았다.
