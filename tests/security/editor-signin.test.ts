import test from 'node:test';
import {createServer} from 'node:http';
import {browserSignInRoutes} from '../../src/server/installations/browser-routes';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {OAuthStates} from '../../src/server/installations/state';
import {EditorSignIn} from '../../src/server/installations/signin';
import {InstallationError} from '../../src/server/installations/store';
import type {Tenants} from '../../src/server/installations/tenants';
import {documentMessage} from '../../src/server/document-message';
const cardId='11111111-1111-4111-a111-111111111111';
const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),kid:'test',alg:'RS256',use:'sig'},verifyKey=createLocalJWKSet({keys:[jwk]});
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rhwp-signin-')),state=new State(join(dir,'registry.sqlite'),'TTEST'),states=new OAuthStates(new SqliteMetadata(state));
  let claims:Record<string,unknown>={},allowed=true,active=true,nonce='',issued=0,authorizedUser='';
  const tenants={async resolve(team:string,generation?:string){assert.equal(team,'TTEST');if(!active||(generation&&generation!=='g1'))throw new InstallationError();return {installation:{generation:'g1'},documents:{store:{async get(){return {id:cardId,actor:{channelId:'CTEST'}};}},async authorize(_id:string,actor:{userId:string}){authorizedUser=actor.userId;if(!allowed)throw new Error('no membership');},sessions:{async issue(){issued++;return 't'.repeat(43);}}}};}} as unknown as Tenants;
  const service=new EditorSignIn({appId:'ATEST',clientId:'123.456',clientSecret:'synthetic-secret',origin:'https://api.example.com',editorOrigin:'https://studio.example.com'},states,tenants,async(url,init)=>{
    assert.equal(String(url),'https://slack.com/api/openid.connect.token');assert.equal(new URLSearchParams(String(init?.body)).get('redirect_uri'),'https://api.example.com/browser/callback');
    const jwt=await new SignJWT({nonce,'https://slack.com/team_id':'TTEST','https://slack.com/user_id':'UREADER',...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(String(claims.iss??'https://slack.com')).setAudience(String(claims.aud??'123.456')).setSubject('UREADER').setIssuedAt().setExpirationTime(Number(claims.exp??Math.floor(Date.now()/1000)+300)).sign(keys.privateKey);
    return Response.json({ok:true,id_token:jwt,access_token:'xoxp-synthetic-not-stored'});
  },verifyKey);
  return {service,states,setClaims(value:Record<string,unknown>){claims=value;},deny(){allowed=false;},revoke(){active=false;},get issued(){return issued;},get user(){return authorizedUser;},async start(reconnect?:string){const start=await service.start('TTEST',cardId,reconnect),u=new URL(start.url);nonce=u.searchParams.get('nonce')!;assert.equal(u.searchParams.get('scope'),'openid profile');assert.equal(u.searchParams.get('response_mode'),'form_post');return {state:u.searchParams.get('state')!,binding:start.binding,code:'synthetic-code'};},close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
test('signed OpenID identity, not installer identity, is checked against current document membership',async()=>{
  const f=await fixture();try{const input=await f.start(),url=await f.service.finish(input);assert.equal(f.user,'UREADER');assert.equal(f.issued,1);assert.equal(new URL(url!).origin,'https://studio.example.com');assert.ok(url!.includes('workspace=TTEST'));await assert.rejects(f.service.finish(input),InstallationError);}finally{f.close();}
});
test('wrong issuer/audience/nonce/workspace, expired JWT and revoked installation cannot mint editor tickets',async()=>{
  for(const claims of [{iss:'https://evil.example.com'},{aud:'other'},{nonce:'forged'},{'https://slack.com/team_id':'TOTHER'},{'https://slack.com/user_id':'UOTHER'},{exp:1}]){
    const f=await fixture();try{const input=await f.start();f.setClaims(claims);await assert.rejects(f.service.finish(input),InstallationError);assert.equal(f.issued,0);}finally{f.close();}
  }
  const f=await fixture();try{const input=await f.start();f.revoke();await assert.rejects(f.service.finish(input),InstallationError);assert.equal(f.issued,0);}finally{f.close();}
});
test('valid Slack login without document membership is denied; cancellation issues nothing',async()=>{
  const f=await fixture();try{const input=await f.start();f.deny();await assert.rejects(f.service.finish(input),InstallationError);assert.equal(f.issued,0);const cancel=await f.start();assert.equal(await f.service.finish({...cancel,error:'access_denied'}),undefined);assert.equal(f.issued,0);}finally{f.close();}
});
test('external beta message has authenticated browser action without embed metadata; internal default is preserved',()=>{
  const card={id:cardId,name:'문서.hwp',actor:{teamId:'TTEST',channelId:'CTEST',userId:'UTEST'},pdf:'pending',fileId:'FTEST'} as any;
  const beta=documentMessage(card,'https://api.example.com','browser');assert.equal(beta.metadata,undefined);const actions=(beta.blocks as any[]).flatMap(b=>b.type==='actions'?b.elements:[]),button=actions.find(a=>a.action_id==='rhwp_browser_edit');assert.equal(button.text.text,'문서 편집 (RHWP)');assert.ok(button.url.includes('/browser/open?workspace=TTEST&document='));assert.equal(button.url.includes('ticket'),false);
  assert.ok(documentMessage(card,'https://api.example.com').metadata);
});

test('both callback transports enforce real state binding, one-use consumption and signed identity',async()=>{
  for(const method of ['GET','POST']){
    const f=await fixture(),route=browserSignInRoutes(f.service);
    const server=createServer((req,res)=>{void route(req,res,()=>res.writeHead(404).end());});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr!=='string');
    const url=`http://127.0.0.1:${addr.port}/browser/callback`;
    try{
      const input=await f.start(),params=new URLSearchParams({state:input.state,code:input.code}).toString();
      const send=(binding?:string)=>fetch(url+(method==='GET'?'?'+params:''),{method,redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded',...(binding?{Cookie:'__Host-rhwp-signin-state='+binding}:{})},...(method==='POST'?{body:params}:{})});
      assert.equal((await send()).headers.get('location'),'/browser/result?reason=login_expired');assert.equal((await send('x'.repeat(43))).headers.get('location'),'/browser/result?reason=login_expired');assert.equal(f.issued,0);
      const response=await send(input.binding);assert.equal(response.status,303);assert.equal(f.issued,1);assert.equal(f.user,'UREADER');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');assert.equal(response.headers.get('Cache-Control'),'no-store');
      assert.equal((await send(input.binding)).headers.get('location'),'/browser/result?reason=login_expired');assert.equal(f.issued,1);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
  }
});

 test('reconnect nonce is bound to the OIDC state and invalid values cannot start a login',async()=>{
  const f=await fixture();try{
    for(const invalid of ['', 'short', 'a'.repeat(44), 'https://other.example'])await assert.rejects(f.service.start('TTEST',cardId,invalid),InstallationError);
    const nonce='r'.repeat(43),input=await f.start(nonce),url=await f.service.finish(input);
    assert.equal(new URLSearchParams(new URL(url!).hash.slice(1)).get('reconnect'),nonce);
    assert.equal(new URL(url!).search,'');
    const ordinary=await f.service.finish(await f.start());assert.ok(!ordinary!.includes('reconnect'));
  }finally{f.close();}
});

test('recovery reasons distinguish expired login, rejected identity and unavailable document without issuing tickets',async()=>{
 const f=await fixture();try{
  const first=await f.start();f.setClaims({nonce:'forged'});
  await assert.rejects(f.service.finish(first),{reason:'signin_failed'});assert.equal(f.issued,0);
  await assert.rejects(f.service.finish(first),{reason:'login_expired'});assert.equal(f.issued,0);
  f.setClaims({});const inaccessible=await f.start();f.deny();
  await assert.rejects(f.service.finish(inaccessible),{reason:'document_unavailable'});assert.equal(f.issued,0);
  const reinstalled=await f.start();f.revoke();
  await assert.rejects(f.service.finish(reinstalled),{reason:'document_unavailable'});assert.equal(f.issued,0);
 }finally{f.close();}
});
