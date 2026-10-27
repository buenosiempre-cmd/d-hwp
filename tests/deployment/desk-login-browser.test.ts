import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scryptSync} from 'node:crypto';
import {chromium, type Browser} from '@playwright/test';

const origin = 'https://cop.example.test';
const password = 'synthetic-browser-login-password';
const cookieName = '__Host-dhwp_session';
const script = fileURLToPath(new URL('../../scripts/serve-desk.mjs', import.meta.url));

async function serverFixture() {
  const root = await mkdtemp(resolve(tmpdir(),'dhwp-login-browser-'));
  await mkdir(resolve(root,'dist/desk'),{recursive:true});
  await writeFile(resolve(root,'dist/desk/index.html'), '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Synthetic desk</title><h1>Synthetic authenticated desk</h1><a id="desk-logout" class="text-button" href="/auth/logout" hidden>로그아웃</a></html>');
  const authFile = resolve(root,'auth.json');
  const salt = Buffer.alloc(16,9);
  await writeFile(authFile,JSON.stringify({version:1,salt:salt.toString('hex'),passwordHash:scryptSync(password,salt,32).toString('hex')}),{mode:0o600});
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
  const address = probe.address();assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath,['--import',import.meta.resolve('tsx'),script],{
    cwd:root,env:{PATH:process.env.PATH,PORT:String(port),DHWP_DESK_PUBLIC_ORIGIN:origin,DHWP_DESK_AUTH_FILE:authFile},stdio:['ignore','pipe','pipe'],
  });
  let stderr = '';
  child.stderr.on('data',chunk => stderr += chunk);
  const exited = new Promise<number | null>((resolve,reject) => {child.once('exit',resolve);child.once('error',reject);});
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;await rm(root,{recursive:true,force:true});
  };
  try {
    await Promise.race([
      new Promise<void>(resolve => child.stdout.once('data',() => resolve())),
      exited.then(() => {throw new Error('Synthetic authentication server failed to start');}),
    ]);
  } catch (error) {await close();throw error;}
  return {port,close,stderr:() => stderr};
}

// Raw HTTP deliberately has no cookie jar and never follows redirects. Only
// Chromium handles native navigation, Origin, Secure cookies and Set-Cookie.
async function forward(port: number, path: string, method: string, headers: Record<string,string>, body: Buffer | null) {
  return new Promise<{status:number;headers:Record<string,string>;body:Buffer}>((resolve,reject) => {
    const req = request({hostname:'127.0.0.1',port,path,method,headers:{...headers,host:new URL(origin).host}},res => {
      const chunks:Buffer[] = [];
      res.on('data',chunk => chunks.push(Buffer.from(chunk)));
      res.on('error',reject);
      res.on('end',() => {
        const outgoing:Record<string,string> = {};
        for (const [name,value] of Object.entries(res.headers)) {
          if (value !== undefined && !['connection','keep-alive','transfer-encoding','content-length'].includes(name)) outgoing[name] = Array.isArray(value) ? value.join('\n') : value;
        }
        resolve({status:res.statusCode!,headers:outgoing,body:Buffer.concat(chunks)});
      });
    });
    req.setTimeout(5000,() => req.destroy(new Error('Synthetic authentication forwarding timed out')));
    req.on('error',reject);req.end(body);
  });
}

async function browserFixture(port: number, forceNoReferrer = false) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(5000);
    const posts:{path:string;origin:string | undefined}[] = [];
    const failures:unknown[] = [];
    // CDP keeps interception active across native 303 redirects; page.route
    // only intercepts the first request in a fulfilled redirect chain.
    const session = await context.newCDPSession(page);
    session.on('Fetch.requestPaused',async paused => {
      try {
        const incoming = paused.request;
        const url = new URL(incoming.url);
        if (url.origin !== origin) {await session.send('Fetch.failRequest',{requestId:paused.requestId,errorReason:'BlockedByClient'});return;}
        const headers:Record<string,string> = {};
        for (const [name,value] of Object.entries(incoming.headers)) headers[name.toLowerCase()] = String(value);
        if (incoming.method === 'POST') posts.push({path:url.pathname,origin:headers.origin});
        const response = await forward(port,url.pathname+url.search,incoming.method,headers,incoming.postData === undefined ? null : Buffer.from(incoming.postData));
        // Reproduce the original response policy without editing production code.
        if (forceNoReferrer && incoming.method === 'GET' && url.pathname === '/auth/login') response.headers['referrer-policy'] = 'no-referrer';
        await session.send('Fetch.fulfillRequest',{requestId:paused.requestId,responseCode:response.status,
          responseHeaders:Object.entries(response.headers).map(([name,value]) => ({name,value})),body:response.body.toString('base64')});
      } catch (error) {
        failures.push(error);
        await session.send('Fetch.failRequest',{requestId:paused.requestId,errorReason:'Failed'}).catch(() => {});
      }
    });
    await session.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
    return {browser,context,page,posts,failures};
  } catch (error) {await browser.close();throw error;}
}

test('native browser login and logout preserve Origin, secure session cookies and authenticated health',{timeout:30_000},async () => {
  const server = await serverFixture();
  let browser:Browser | undefined;
  try {
    const fixture = await browserFixture(server.port);browser = fixture.browser;
    const {page,context,posts,failures} = fixture;
    const loginPage = await page.goto(origin+'/desk/');
    assert.equal(page.url(),origin+'/auth/login');
    await page.getByLabel('접속 비밀번호',{exact:true}).fill(password);
    const loginResponse = page.waitForResponse(response => response.url() === origin+'/auth/login' && response.request().method() === 'POST');
    await page.getByRole('button',{name:'접속하기',exact:true}).click();
    assert.equal((await loginResponse).status(),303,'native same-origin login must not become Origin: null / 403');
    await page.waitForURL(origin+'/desk/');
    assert.equal(loginPage?.headers()['referrer-policy'],'same-origin');
    assert.deepEqual(posts,[{path:'/auth/login',origin}]);
    const session = (await context.cookies(origin)).find(cookie => cookie.name === cookieName);
    assert.ok(session);
    assert.equal(session.secure,true);assert.equal(session.httpOnly,true);
    assert.equal(session.sameSite,'Strict');assert.equal(session.path,'/');
    assert.equal(session.domain,new URL(origin).hostname);
    assert.ok(session.expires > Date.now()/1000+7*60*60 && session.expires <= Date.now()/1000+8*60*60+5);
    assert.equal(await page.evaluate('document.cookie'),'','HttpOnly cookie is unavailable to page scripts');
    assert.deepEqual(await page.evaluate('fetch("/healthz", {credentials:"same-origin"}).then(async r => ({status:r.status,body:await r.json()}))'),{status:200,body:{ok:true}});
    const logoutPage = page.waitForResponse(response => response.url() === origin+'/auth/logout' && response.request().method() === 'GET');
    await page.getByRole('link',{name:'로그아웃',exact:true}).click();
    assert.equal((await logoutPage).headers()['referrer-policy'],'same-origin');
    const logoutResponse = page.waitForResponse(response => response.url() === origin+'/auth/logout' && response.request().method() === 'POST');
    await page.getByRole('button',{name:'로그아웃',exact:true}).click();
    assert.equal((await logoutResponse).status(),303);
    await page.waitForURL(origin+'/auth/login');
    assert.deepEqual(posts,[{path:'/auth/login',origin},{path:'/auth/logout',origin}]);
    assert.equal((await context.cookies(origin)).some(cookie => cookie.name === cookieName),false);
    assert.equal(await page.evaluate('fetch("/healthz", {credentials:"same-origin"}).then(r => r.status)'),401);
    await context.addCookies([session]);
    assert.equal(await page.evaluate('fetch("/healthz", {credentials:"same-origin"}).then(r => r.status)'),401,'logout invalidates the server session, including a replayed former cookie');
    assert.deepEqual(failures,[]);
    assert.equal(server.stderr(),'');
  } finally {await browser?.close();await server.close();}
});

test('the former no-referrer login policy reproduces a native Origin null request and 403',{timeout:30_000},async () => {
  const server = await serverFixture();
  let browser:Browser | undefined;
  try {
    const fixture = await browserFixture(server.port,true);browser = fixture.browser;
    const {page,context,posts,failures} = fixture;
    await page.goto(origin+'/auth/login');
    await page.getByLabel('접속 비밀번호',{exact:true}).fill(password);
    const loginResponse = page.waitForResponse(response => response.url() === origin+'/auth/login' && response.request().method() === 'POST');
    await page.getByRole('button',{name:'접속하기',exact:true}).click();
    const denied = await loginResponse;
    assert.equal(denied.status(),403);
    assert.equal((await denied.json()).error.code,'ORIGIN_DENIED');
    assert.deepEqual(posts,[{path:'/auth/login',origin:'null'}]);
    assert.equal((await context.cookies(origin)).some(cookie => cookie.name === cookieName),false);
    assert.deepEqual(failures,[]);
    assert.equal(server.stderr(),'');
  } finally {await browser?.close();await server.close();}
});
