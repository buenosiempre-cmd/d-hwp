# D-HWP 구성원 기능 업그레이드 결과

Issue [#9](https://github.com/buenosiempre-cmd/d-hwp/issues/9)

## 결과

원문 TXT, 필요한 쪽의 PNG ZIP, Slack 카드의 형식·쪽 선택 메뉴를 구현했다. 기존 PDF·앞 3/10쪽 PNG 갤러리·원문 Markdown·RHWP 편집과 초대 기반 채널 활성화는 유지했다. 실제 Slack 앱 설치는 신규 권한 부여 확인 대기 중이다.

선택 쪽은 1~200 중 최대 10개이며 `1,3-5,12` 문법을 지원한다. TXT 2 MiB, PNG 5 MiB/쪽·합계 25 MiB, ZIP 26 MiB다. 잘못된 쪽은 조용히 생략하지 않고 요청을 거부한다. 같은 문서의 같은 형식·쪽은 기존 파일을 다시 안내한다.

## 검토 판단

별도 유료 서비스 없이 바로 쓸 수 있는 원문 재사용과 필요한 쪽 공유를 우선했다. 이는 설문 결과가 아닌 현재 기능 공백과 행정 문서 활용 흐름에 따른 판단이다. 다음 후보는 전체 원문 검색·문서 정보, 선택 문단과 동국규정 MCP 근거의 연결이다. 표 Excel·OCR·실제 AI 요약은 정확도와 전송 경로 확인이 필요해 구현 기능으로 표시하지 않았다. 자세한 판단은 [기능 개선 검토](../../docs/d-hwp-upgrades.md)에 기록했다.

## 검증 근거와 한계

Node 24.21.0에서 typecheck, unit 37개, Slack 285개, security 91개, 순수 conversion 27개를 통과했다. 80쪽 합성 문서의 12·40·80쪽, HWP/HWPX Unicode 원문, ZIP 내부 파일·CRC와 시스템 압축 해제 검사를 확인했다. 권한 회수·모달 변조·만료·원문 변경·이관 카드·동시 요청·완료 응답 유실·재시작 후 재요청을 검사했다.

독립 리뷰에서 hash가 없는 이관 카드의 과거 결과 재사용 문제를 발견해 수정했다. 첫 내보내기 전에 기준 hash를 고정하고 이미 할당된 미검증 영수증이 있으면 다른 선택을 통한 우회도 차단한다.

원본·변환 파일·토큰·서명 URL을 Git이나 상태 DB에 넣지 않았다. 상태에는 파일 ID·검증된 permalink·선택과 업로드 진행 메타데이터를 보관한다. 실제 워크스페이스 설치·전송·편집 결과는 아직 확인하지 않았다.

## 게시 경로

- 작업 브랜치: `local/task9`
- 원격 게시 대상: [`publish/task9`](https://github.com/buenosiempre-cmd/d-hwp/tree/publish/task9)
- PR 기준: `publish/task7`
- 기존 Task #7 CI: [push 성공](https://github.com/buenosiempre-cmd/d-hwp/actions/runs/40609571218), [PR 성공](https://github.com/buenosiempre-cmd/d-hwp/actions/runs/40609577154)

원격 게시 SHA와 새 CI 상태는 push 후 최종 전달에서 별도로 확인한다. PR merge와 이슈 close는 수행하지 않는다.
