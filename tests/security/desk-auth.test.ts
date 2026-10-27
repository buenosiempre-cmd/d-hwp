import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtemp, writeFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, scryptSync} from 'node:crypto';
import {createDeskAuth} from '../../src/server/desk-auth.ts';

const origin='https://cop.example.test';
async function fixture(t: TestContext) {
  const dir=await mkdtemp(join(tmpdir(),'desk-auth-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const authFile=join(dir,'auth.json'),password=randomBytes(24).toString('base64url'),salt=randomBytes(16);
  await writeFile(authFile,JSON.stringify({version:1,salt:salt.toString('hex'),passwordHash:scryptSync(password,salt,32).toString('hex')}),{mode:0o600});
  const auth=await createDeskAuth({origin,authFile});
  const server=createServer(async(req,res)=>{
    if(!await auth.handle(req,res,new URL(req.url!,origin)))res.writeHead(200).end('private content');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const address=server.address();assert(address&&typeof address==='object');
  const call=(path:string,method='GET',headers:Record<string,string>={},body='')=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:string}>((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:address.port,path,method,headers},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:data}));});req.on('error',reject);req.end(body);
  });
  const login=(value=password,extra:Record<string,string>={})=>call('/auth/login','POST',{'Origin':origin,'Content-Type':'application/x-www-form-urlencoded',...extra},new URLSearchParams({password:value}).toString());
  return {authFile,password,call,login};
}

test('private pilot requires auth for assets, health and API; login is the only public page',async t=>{
  const {call}=await fixture(t);
  for(const path of ['/desk/','/static/v/studio/index.html','/licenses/MIT.txt','/unknown']){const r=await call(path);assert.equal(r.status,303);assert.equal(r.headers.location,'/auth/login');assert(!r.body.includes('private content'));}
  for(const path of ['/api/assistant/rules','/healthz'])assert.equal((await call(path)).status,401);
  const page=await call('/auth/login');assert.equal(page.status,200);assert.match(page.body,/type="password"/);
  assert.equal((await call('/auth/login','HEAD')).body,'');
});

test('valid login uses a secure opaque session; wrong password and forged cookie fail',async t=>{
  const {call,login,password}=await fixture(t);
  const bad=await login('wrong');assert.equal(bad.status,401);assert(!bad.headers['set-cookie']);
  const ok=await login();assert.equal(ok.status,303);assert.equal(ok.headers.location,'/desk/');
  const cookie=ok.headers['set-cookie']![0];
  for(const flag of ['Secure','HttpOnly','SameSite=Strict','Path=/','Max-Age=28800'])assert(cookie.includes(flag));
  assert(!cookie.includes(password));
  const pair=cookie.split(';')[0];
  assert.equal((await call('/healthz','GET',{Cookie:pair})).status,200);
  assert.equal((await call('/desk/','GET',{Cookie:'__Host-dhwp_session='+randomBytes(32).toString('base64url')})).status,303);
  assert.equal((await call('/desk/','GET',{Cookie:pair+'; '+pair})).status,303);
  assert.equal((await call('/auth/login','GET',{Cookie:pair})).status,303);
});

test('login/logout require exact origin and logout revokes a copied session',async t=>{
  const {call,login}=await fixture(t);
  for(const value of ['', 'null','https://evil.test',origin+'.evil.test'])assert.equal((await login(undefined,{Origin:value})).status,403);
  assert.equal((await login(undefined,{'Content-Type':'application/json'})).status,415);
  assert.equal((await call('/auth/login','PUT')).status,405);
  const cookie=(await login()).headers['set-cookie']![0].split(';')[0];
  assert.equal((await call('/auth/logout','POST',{Cookie:cookie,Origin:'https://evil.test'})).status,403);
  assert.equal((await call('/desk/','GET',{Cookie:cookie})).status,200);
  const out=await call('/auth/logout','POST',{Cookie:cookie,Origin:origin});assert.equal(out.status,303);assert.match(out.headers['set-cookie']![0],/Max-Age=0/);
  assert.equal((await call('/desk/','GET',{Cookie:cookie})).status,303);
});

test('sessions expire after eight hours and never survive a new auth instance',async t=>{
  const {call,login,authFile}=await fixture(t);
  const cookie=(await login()).headers['set-cookie']![0].split(';')[0];
  t.mock.timers.enable({apis:['Date'],now:Date.now()+8*60*60*1000+1});
  assert.equal((await call('/desk/','GET',{Cookie:cookie})).status,303);
  t.mock.timers.reset();
  const auth=await createDeskAuth({origin,authFile});
  const fakeReq={method:'GET',headers:{cookie},url:'/healthz'} as import('node:http').IncomingMessage;
  let code=0;const res={writeHead(status:number){code=status;return this;},end(){}} as unknown as import('node:http').ServerResponse;
  assert.equal(await auth.handle(fakeReq,res,new URL('/healthz',origin)),true);assert.equal(code,401);
});

test('oversized and duplicate passwords fail without reflecting supplied values',async t=>{
  const {call,login}=await fixture(t);
  assert.equal((await login('a'.repeat(1100))).status,413);
  const reply=await call('/auth/login','POST',{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},'password=secret1&password=secret2');assert.equal(reply.status,401);assert(!reply.body.includes('secret1'));
});

test('global attempts cannot be bypassed with forwarded IP headers',async t=>{
  const {login}=await fixture(t);
  for(let i=0;i<60;i++)assert.equal((await login('',{'X-Forwarded-For':`10.0.0.${i}`})).status,401);
  const limited=await login();assert.equal(limited.status,429);assert.equal(limited.headers['retry-after'],'900');
});

test('bad/loose auth files and non-HTTPS authentication fail closed',async t=>{
  const {authFile}=await fixture(t);
  await assert.rejects(createDeskAuth({origin:'http://127.0.0.1:4000',authFile}),/requires HTTPS/);
  await writeFile(authFile,'{}');await assert.rejects(createDeskAuth({origin,authFile}),/Invalid desk authentication configuration/);
  if(process.platform!=='win32'){await chmod(authFile,0o644);await assert.rejects(createDeskAuth({origin,authFile}),/Invalid desk authentication configuration/);}
});
