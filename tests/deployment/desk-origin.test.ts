import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request, type IncomingHttpHeaders} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scryptSync} from 'node:crypto';
import {resolveDeskOrigin} from '../../src/server/desk-public-origin.ts';

const script = fileURLToPath(new URL('../../scripts/serve-desk.mjs', import.meta.url));
const tsx = import.meta.resolve('tsx');
const publicOrigin = 'https://desk.example.test';
const password = 'synthetic-cop-password';
const logoutPlaceholder = '<a id="desk-logout" class="text-button" href="/auth/logout" hidden>로그아웃</a>';

test('desk origin keeps the local default and accepts only exact HTTPS origins with authentication', () => {
  assert.deepEqual(resolveDeskOrigin({port:4175}), {origin:'http://127.0.0.1:4175',host:'127.0.0.1:4175',isPublic:false});
  assert.deepEqual(resolveDeskOrigin({port:4175,publicOrigin,authFile:'/synthetic/auth.json'}), {origin:publicOrigin,host:'desk.example.test',isPublic:true});
  assert.equal(resolveDeskOrigin({port:4175,publicOrigin:'https://desk.example.test:8443',authFile:'auth.json'}).host, 'desk.example.test:8443');
  for (const port of [0,-1,65536,1.5,NaN]) assert.throws(() => resolveDeskOrigin({port}), /^Error: Invalid PORT$/);
  for (const value of ['', ' ', 'http://desk.example.test', '//desk.example.test', 'https://desk.example.test/',
    'https://desk.example.test/desk', 'https://desk.example.test?x=1', 'https://desk.example.test#x',
    'https://secret:password@desk.example.test', 'https://DESK.example.test', 'https://desk.example.test:443',
    ' https://desk.example.test', 'https://desk.example.test\n', 'https://[']) {
    assert.throws(() => resolveDeskOrigin({port:4175,publicOrigin:value,authFile:'auth.json'}), /^Error: Invalid DHWP_DESK_PUBLIC_ORIGIN$/);
  }
  for (const authFile of [undefined,'',' ']) {
    assert.throws(() => resolveDeskOrigin({port:4175,publicOrigin,authFile}), /^Error: Public desk requires DHWP_DESK_AUTH_FILE$/);
  }
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'dhwp-deploy-test-'));
  await mkdir(resolve(root,'dist/desk'), {recursive:true});
  await writeFile(resolve(root,'dist/desk/index.html'), '<!doctype html><title>Synthetic desk</title>' + logoutPlaceholder);
  await writeFile(resolve(root,'dist/test.js'), '/* synthetic protected asset */');
  await writeFile(resolve(root,'dist/static-manifest.json'), JSON.stringify({version:'fixture',files:{'test.js':{identity:{file:'test.js',size:31,etag:'"fixture"'}}}}));
  await writeFile(resolve(root,'LICENSE'), 'Synthetic license notice');
  const authFile = resolve(root,'auth.json');
  const salt = Buffer.alloc(16, 7);
  await writeFile(authFile, JSON.stringify({version:1,salt:salt.toString('hex'),passwordHash:scryptSync(password,salt,32).toString('hex')}), {mode:0o600});
  return {root,authFile,close:() => rm(root,{recursive:true,force:true})};
}

async function start(root: string, env: NodeJS.ProcessEnv = {}) {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0,'127.0.0.1',resolve));
  const address = probe.address(); assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath,['--import',tsx,script],{
    cwd:root,env:{PATH:process.env.PATH,PORT:String(port),...env},stdio:['ignore','pipe','pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data',chunk => stdout += chunk);
  child.stderr.on('data',chunk => stderr += chunk);
  const exited = new Promise<number | null>((resolve,reject) => {child.once('exit',resolve);child.once('error',reject);});
  const ready = new Promise<void>(resolve => child.stdout.once('data',() => resolve()));
  return {
    port, child, exited, stdout:() => stdout, stderr:() => stderr,
    async ready() {
      await Promise.race([ready,exited.then(() => {throw new Error('Synthetic desk startup failed: ' + stderr);})]);
    },
    async close() { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; },
  };
}

async function send(port: number, path: string, options: {method?:string;headers?:Record<string,string>;body?:string} = {}) {
  return new Promise<{status:number;headers:IncomingHttpHeaders;body:string}>((resolve,reject) => {
    const req = request({hostname:'127.0.0.1',port,path,method:options.method || 'GET',headers:options.headers},res => {
      let body = '';
      res.setEncoding('utf8');res.on('data',chunk => body += chunk);
      res.on('end',() => resolve({status:res.statusCode!,headers:res.headers,body}));
      res.on('error',reject);
    });
    req.setTimeout(3000,() => req.destroy(new Error('Synthetic desk request timed out')));
    req.on('error',reject);req.end(options.body);
  });
}

test('local desk keeps unauthenticated loopback behavior, exact Host/Origin guards and minimal health',{timeout:10_000},async () => {
  const files = await fixture();
  const server = await start(files.root);
  try {
    await server.ready();
    const origin = `http://127.0.0.1:${server.port}`;
    const health = await send(server.port,'/healthz');
    assert.equal(health.status,200); assert.deepEqual(JSON.parse(health.body),{ok:true});
    assert.equal(health.headers['cache-control'],'no-store');
    assert.equal(health.headers['strict-transport-security'],undefined);
    assert.match(String(health.headers['content-security-policy']),new RegExp(`form-action ${origin.replaceAll('.','\\.')}(?:;|$)`));
    assert.equal((await send(server.port,'/healthz',{method:'HEAD'})).body,'');
    assert.equal((await send(server.port,'/healthz',{method:'POST'})).status,405);
    assert.equal((await send(server.port,'/')).headers.location,'/desk/');
    const desk = await send(server.port,'/desk/');
    assert.equal(desk.status,200);assert.ok(desk.body.includes(logoutPlaceholder),'local markup keeps logout hidden');
    assert.equal((await send(server.port,'/healthz',{headers:{Host:'evil.example','X-Forwarded-Host':new URL(origin).host}})).status,403);
    assert.equal((await send(server.port,'https://evil.example/healthz')).status,403);
    const api = {method:'POST',body:'{"operation":"status"}',headers:{'Content-Type':'application/json',Origin:origin}};
    assert.equal((await send(server.port,'/api/assistant/rules',{...api,headers:{...api.headers,Origin:'https://evil.example'}})).status,403);
    assert.equal((await send(server.port,'/api/assistant/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:api.body})).status,403);
    assert.equal((await send(server.port,'/api/assistant/rules',api)).status,200);
    assert.equal(server.stderr(),'');
  } finally {await server.close();await files.close();}
});

test('public desk fails closed before listening without a valid private authentication file',{timeout:10_000},async () => {
  const files = await fixture();
  try {
    const invalidFile = resolve(files.root,'invalid-auth.json');
    await writeFile(invalidFile,'{}',{mode:0o600});
    for (const extra of [
      {DHWP_DESK_PUBLIC_ORIGIN:publicOrigin},
      {DHWP_DESK_PUBLIC_ORIGIN:publicOrigin,DHWP_DESK_AUTH_FILE:resolve(files.root,'missing-auth.json')},
      {DHWP_DESK_PUBLIC_ORIGIN:publicOrigin,DHWP_DESK_AUTH_FILE:invalidFile},
      {DHWP_DESK_PUBLIC_ORIGIN:'https://secret:password@desk.example.test',DHWP_DESK_AUTH_FILE:files.authFile},
    ]) {
      const server = await start(files.root,extra);
      try {
        assert.notEqual(await server.exited,0);
        assert.equal(server.stdout(),'');
        assert.doesNotMatch(server.stderr(),/secret:password|missing-auth\.json|invalid-auth\.json/);
      } finally {await server.close();}
    }
  } finally {await files.close();}
});

test('public origin gates health, assets and APIs, preserves HTTPS headers and rejects proxy header overrides',{timeout:10_000},async () => {
  const files = await fixture();
  const server = await start(files.root,{DHWP_DESK_PUBLIC_ORIGIN:publicOrigin,DHWP_DESK_AUTH_FILE:files.authFile});
  const headers = {Host:new URL(publicOrigin).host};
  try {
    await server.ready();
    assert.equal((await send(server.port,'/healthz')).status,403,'loopback Host must not bypass the public Host guard');
    assert.equal((await send(server.port,'/healthz',{headers:{Host:'evil.example','X-Forwarded-Host':headers.Host,'X-Forwarded-Proto':'https'}})).status,403);
    const login = await send(server.port,'/auth/login',{headers});
    assert.equal(login.status,200);
    assert.equal(login.headers['strict-transport-security'],'max-age=31536000');
    assert.equal(login.headers['cache-control'],'private, no-store');
    const csp = String(login.headers['content-security-policy']);
    for (const directive of ['script-src','worker-src','style-src','font-src','connect-src','img-src','frame-src','frame-ancestors','form-action']) {
      assert.ok(csp.includes(`${directive} ${publicOrigin}`),directive);
    }
    assert.doesNotMatch(csp,/127\.0\.0\.1|localhost|evil\.example/);
    for (const path of ['/desk/','/static/fixture/test.js','/licenses/MIT.txt']) {
      const denied = await send(server.port,path,{headers});
      assert.equal(denied.status,303,path);assert.equal(denied.headers.location,'/auth/login');
      assert.doesNotMatch(denied.body,/Synthetic desk|synthetic protected asset|Synthetic license notice/);
    }
    assert.equal((await send(server.port,'/healthz',{headers})).status,401);
    assert.equal((await send(server.port,'/api/assistant/rules',{method:'POST',headers:{...headers,Origin:publicOrigin,'Content-Type':'application/json'},body:'{"operation":"status"}'})).status,401);
    const loggedIn = await send(server.port,'/auth/login',{method:'POST',headers:{...headers,Origin:publicOrigin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password}).toString()});
    assert.equal(loggedIn.status,303);assert.equal(loggedIn.headers.location,'/desk/');
    const cookie = loggedIn.headers['set-cookie']?.[0]?.split(';')[0];assert.ok(cookie);
    const authenticated = {...headers,Cookie:cookie};
    const health = await send(server.port,'/healthz',{headers:authenticated});
    assert.equal(health.status,200);assert.deepEqual(JSON.parse(health.body),{ok:true});
    assert.equal(health.headers['cache-control'],'private, no-store');
    assert.equal((await send(server.port,'/healthz',{method:'HEAD',headers:authenticated})).body,'');
    const desk = await send(server.port,'/desk/',{headers:authenticated});
    assert.equal(desk.status,200);assert.ok(desk.body.includes(logoutPlaceholder.replace(' hidden','')));
    assert.ok(!desk.body.includes(logoutPlaceholder),'public markup exposes the logout link');
    const asset = await send(server.port,'/static/fixture/test.js',{headers:authenticated});
    assert.equal(asset.status,200);assert.match(asset.body,/synthetic protected asset/);
    assert.equal(asset.headers['cache-control'],'private, no-store','static handler cannot restore public immutable caching');
    const cached = await send(server.port,'/static/fixture/test.js',{headers:{...authenticated,'If-None-Match':'"fixture"'}});
    assert.equal(cached.status,304);assert.equal(cached.headers['cache-control'],'private, no-store');
    assert.equal((await send(server.port,'https://evil.example/healthz',{headers:authenticated})).status,403);
    const api = {method:'POST',body:'{"operation":"status"}',headers:{...authenticated,Origin:publicOrigin,'Content-Type':'application/json'}};
    assert.equal((await send(server.port,'/api/assistant/rules',{...api,headers:{...api.headers,Origin:'https://evil.example','X-Forwarded-Host':headers.Host}})).status,403);
    const reply = await send(server.port,'/api/assistant/rules',api);
    assert.equal(reply.status,200);assert.equal(reply.headers['cache-control'],'private, no-store');
    assert.equal(JSON.parse(reply.body).error.code,'NOT_CONFIGURED');
    for (const html of ['<title>Missing logout</title>',logoutPlaceholder+logoutPlaceholder]) {
      await writeFile(resolve(files.root,'dist/desk/index.html'),html);
      const invalid = await send(server.port,'/desk/',{headers:authenticated});
      assert.equal(invalid.status,500);assert.doesNotMatch(invalid.body,/Invalid desk|markup|desk-origin|\/private\//);
    }
    await send(server.port,'/auth/logout',{method:'POST',headers:{...authenticated,Origin:publicOrigin}});
    assert.equal((await send(server.port,'/healthz',{headers:authenticated})).status,401);
    assert.equal(server.stderr(),'');
  } finally {await server.close();await files.close();}
});
