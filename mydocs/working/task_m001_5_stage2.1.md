# Stage 2.1 — 실제 HTTPS 로그인 폼 보완

별도 HTTPS 터널과 인증 서버 연결은 성공했다. 외부의 실제 Chromium 로그인 폼에서 `Referrer-Policy: no-referrer`가 POST Origin을 null로 만들어 엄격한 CSRF 검증에 거절되는 문제를 발견했다.

인증 HTML에만 `Referrer-Policy: same-origin`을 적용해 정상 native form의 Origin을 유지한다. 다른 출처에는 referrer를 보내지 않으며 정확한 Origin 검증은 그대로 유지한다. 수정 후 인증 단위 7/7 통과. 실제 외부 브라우저 재검증과 해당 fault injection 회귀는 Stage 3에 기록한다.

Cloudflare CLI가 기본 설정의 터널 ID를 먼저 사용하므로 새 hostname의 초기 CNAME을 별도 설정·명시적 UUID로 교정했다. 기존 hostname의 레코드와 기존 터널은 수정하지 않았다. 외부 Python 기본 UA는 Cloudflare 1010으로 거절되므로 일반 브라우저와 명시적 점검 UA로 검증하며 계정 보안 정책을 변경하지 않았다.
