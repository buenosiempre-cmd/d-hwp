import {randomBytes, scrypt as derive, timingSafeEqual, createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {promisify} from 'node:util';
import type {IncomingMessage, ServerResponse} from 'node:http';

const scrypt = promisify(derive);
const COOKIE = '__Host-dhwp_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 1024;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));

function page(message = '', logout = false): string {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>D-HWP · CoP 접속</title><style>body{margin:0;background:#f6f5f1;color:#202d39;font:17px/1.65 system-ui,sans-serif}main{max-width:430px;margin:12vh auto;padding:36px;background:white;border:1px solid #e6e1d7;border-radius:20px}h1{font-size:32px;margin:12px 0}small{color:#b05420;font-weight:700}p{color:#556371}label{display:block;margin:24px 0 8px}input,button{box-sizing:border-box;width:100%;padding:14px;border:1px solid #a7afb4;border-radius:9px;font:inherit}button{margin-top:18px;background:#a6441f;color:white;border:0;cursor:pointer}a{color:#8d3b1e}.message{color:#a12d20;min-height:1.5em}@media(max-width:520px){main{margin:8vh 16px;padding:24px}}</style><main><small>동국대학교 CoP 시제품</small><h1>동국 한글문서 도우미</h1><p>${logout?'공용 기기에서는 작업을 마친 뒤 로그아웃해 주세요.':'CoP 구성원에게 전달받은 접속 비밀번호를 입력해 주세요.'}</p><form method="post" action="${logout?'/auth/logout':'/auth/login'}">${logout?'':'<label for="password">접속 비밀번호</label><input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password" autofocus>'}<button type="submit">${logout?'로그아웃':'접속하기'}</button></form><p class="message" role="status">${escape(message)}</p>${logout?'<a href="/desk/">작업으로 돌아가기</a>':'<p>문서 편집은 브라우저에서 이루어집니다. 접속은 8시간 후 만료됩니다.</p>'}</main></html>`;
}

/** Small private pilot gate. No passwords, request bodies or sessions are logged/persisted. */
export async function createDeskAuth({origin, authFile}: {origin: string; authFile: string}) {
  if (new URL(origin).protocol !== 'https:') throw new Error('Desk authentication requires HTTPS');
  let config: {version?: unknown; salt?: unknown; passwordHash?: unknown};
  try {
    const info = await stat(authFile);
    if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
    config = JSON.parse(await readFile(authFile, 'utf8'));
    if (!config || config.version !== 1 || typeof config.salt !== 'string' || !/^[a-f0-9]{32}$/.test(config.salt) || typeof config.passwordHash !== 'string' || !/^[a-f0-9]{64}$/.test(config.passwordHash)) throw new Error();
  } catch { throw new Error('Invalid desk authentication configuration'); }
  const salt = Buffer.from(config.salt as string, 'hex');
  const expected = Buffer.from(config.passwordHash as string, 'hex');
  const sessions = new Map<string, number>();
  let attempts: number[] = [];
  let verifying = false;
  function session(req: IncomingMessage): string | undefined {
    const values = String(req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(COOKIE + '='));
    if (values.length !== 1) return;
    const value = values[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return;
    const key = digest(value), expires = sessions.get(key);
    if (!expires || expires <= Date.now()) { sessions.delete(key); return; }
    return key;
  }
  function html(req: IncomingMessage, res: ServerResponse, status: number, message = '', logout = false) {
    // A no-referrer document makes a native form POST use Origin: null.
    // Keep the same-origin Origin header for CSRF validation without leaking
    // a referrer to any different origin.
    res.setHeader('Referrer-Policy','same-origin');
    res.writeHead(status, {'Content-Type':'text/html; charset=utf-8'}).end(req.method === 'HEAD' ? undefined : page(message, logout));
  }
  function json(res: ServerResponse, status: number, code: string) {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({ok:false,error:{code,message:'CoP 접속 인증이 필요합니다.'}}));
  }
  return {
    isAuthenticated(req: IncomingMessage): boolean { return Boolean(session(req)); },
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      const key = session(req);
      if (url.pathname === '/auth/login' || url.pathname === '/auth/logout') {
        const logout = url.pathname === '/auth/logout';
        if (req.method === 'GET' || req.method === 'HEAD') {
          if (key && !logout) res.writeHead(303, {Location:'/desk/'}).end();
          else html(req,res,200,'',logout);
          return true;
        }
        if (req.method !== 'POST') { res.writeHead(405,{Allow:'GET, HEAD, POST'}).end(); return true; }
        if (req.headers.origin !== origin) { json(res,403,'ORIGIN_DENIED'); return true; }
        if (logout) {
          if (key) sessions.delete(key);
          res.setHeader('Set-Cookie',`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`);
          res.writeHead(303,{Location:'/auth/login'}).end(); return true;
        }
        if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(String(req.headers['content-type'] ?? ''))) { json(res,415,'INVALID_CONTENT_TYPE'); return true; }
        attempts = attempts.filter(time => time > Date.now() - 15 * 60 * 1000);
        // Global limit is deliberate: forwarded IP headers never grant extra attempts.
        if (verifying || attempts.length >= 60) { res.setHeader('Retry-After','900'); html(req,res,429,'접속 요청이 많습니다. 잠시 뒤 다시 시도해 주세요.'); return true; }
        attempts.push(Date.now());
        if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { json(res,413,'PAYLOAD_TOO_LARGE'); return true; }
        verifying = true;
        const chunks: Buffer[] = []; let size = 0;
        const timer = setTimeout(() => req.destroy(),5000);
        try {
          for await (const chunk of req) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > MAX_BODY) { json(res,413,'PAYLOAD_TOO_LARGE'); return true; }
            chunks.push(bytes);
          }
          const values = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).getAll('password');
          if (values.length !== 1 || !values[0] || values[0].length > 256) { html(req,res,401,'접속 비밀번호를 확인해 주세요.'); return true; }
          const actual = await scrypt(values[0],salt,32) as Buffer;
          if (!timingSafeEqual(actual,expected)) { html(req,res,401,'접속 비밀번호를 확인해 주세요.'); return true; }
          for (const [token, expires] of sessions) if (expires <= Date.now()) sessions.delete(token);
          if (sessions.size >= 256) sessions.delete(sessions.keys().next().value!);
          const token = randomBytes(32).toString('base64url');
          sessions.set(digest(token),Date.now()+SESSION_MS);
          res.setHeader('Set-Cookie',`${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS/1000}`);
          res.writeHead(303,{Location:'/desk/'}).end();
        } catch { if (!res.destroyed && !res.writableEnded) json(res,400,'INVALID_REQUEST'); }
        finally { clearTimeout(timer); verifying = false; }
        return true;
      }
      if (key) return false;
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') json(res,401,'AUTH_REQUIRED');
      else res.writeHead(303,{Location:'/auth/login'}).end();
      return true;
    },
  };
}
