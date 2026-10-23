import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import type {MetadataStore} from '../../src/server/cloud/metadata';
import {DurableTasks,type Work} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents} from '../../src/server/cloud/events';
import {HttpSlackApi,type Method} from '../../src/server/slack-api';
import {UserError} from '../../src/server/errors';
import {attachSlackDiagnostics} from '../../src/server/slack-diagnostics';
import {traceTask} from '../../src/server/cloud/telemetry';
import type {Card} from '../../src/server/documents';
import {actor,config,file,bytes,FakeApi} from './support';
function fixture(wrap?:(raw:MetadataStore)=>MetadataStore){
 const dir=mkdtempSync(join(tmpdir(),'rhwp-last-share-')),state=new State(join(dir,'state.sqlite'),'TTEST');
 const raw=new SqliteMetadata(state),store=wrap?wrap(raw):raw,fake=new FakeApi();let shared=['CTEST','CPRIVATE'],unavailable=false,downloads=0;
 let intercept:((method:Method,args:Record<string,string>)=>Promise<Response|undefined>)|undefined;
 const calls:{method:Method;args:Record<string,string>}[]=[],records:Record<string,unknown>[]=[],terminal:Record<string,unknown>[]=[],notices:Record<string,unknown>[]=[],published:string[]=[];
 const api=new HttpSlackApi('xoxb-synthetic-test',async(url,init)=>{
  const u=new URL(String(url)),method=u.pathname.split('/').at(-1)! as Method,args=Object.fromEntries(init?.body?new URLSearchParams(String(init.body)):u.searchParams);calls.push({method,args});
  const response=await intercept?.(method,args);if(response)return response;
  if(method==='files.info'){
   if(unavailable&&args.file==='FTEST')return Response.json({ok:false,error:'file_not_found'});
   const shares:{public:Record<string,unknown>;private:Record<string,unknown>}={public:{},private:{}};
   for(const channel of shared)shares[channel==='CPRIVATE'?'private':'public'][channel]=[{team_id:'TTEST',ts:'123.456'}];
   return Response.json({ok:true,file:{...file,id:args.file,shares}});
  }
  const result=fake.response(method,args);if(method==='conversations.info')result.channel={...(result.channel as object),id:args.channel,is_private:args.channel==='CPRIVATE'};return Response.json(result);
 });
 const tasks=new DurableTasks(store,{async publish(id){published.push(id);}},Date.now,60_000,r=>terminal.push(r));
 const app=new CloudApplication(config,api,store,tasks,{download:async()=>{downloads++;return bytes;}}),events=new CloudEvents(app,'UBOT',r=>notices.push(r));
 return {raw,store,app,tasks,calls,records,terminal,notices,
  setUnavailable(v:boolean){unavailable=v;},setShares(v:string[]){shared=v;},setIntercept(v:typeof intercept){intercept=v;},downloads(){return downloads;},
  put<T>(kind:string,id:string,value:T){return raw.atomic(kind,id,()=>({value,result:undefined}));},
  async enqueue(fileId='FTEST',eventId=randomUUID(),kind:'file_unshared'|'file_deleted'='file_unshared'){await events.enqueue(eventId,{kind,fileId});return published.at(-1)!;},
  run(id:string){return tasks.execute(id,(s,c)=>traceTask(s,c,()=>events.execute(s,c),r=>records.push(r)),(s,c)=>events.terminal(s,c));},
  async snapshot(){return Object.fromEntries(await Promise.all(['cards','observed','tickets','sessions','revocations'].map(async kind=>[kind,await raw.list(kind)])));},
  close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
type Fixture=ReturnType<typeof fixture>;
function card(derived=false,channelId='CTEST'):Card{return {id:randomUUID(),actor:{...actor,channelId},fileId:derived?'FREVISION':'FTEST',rootFileId:'FTEST',name:file.name,size:file.size,createdAt:Date.now(),revision:derived?1:0,pdf:'ready',imageState:'ready'};}
const infos=(f:Fixture)=>f.calls.filter(c=>c.method==='files.info').length,resolutions=(f:Fixture)=>f.records.filter(r=>r.event==='unshare_resolution');
async function seed(f:Fixture){const cards=['CTEST','CPRIVATE'].flatMap(ch=>[card(false,ch),card(true,ch)]);for(const c of cards)await f.put('cards',c.id,c);for(const ch of ['CTEST','CPRIVATE'])await f.put('observed',ch,{team:'TTEST',file:'FTEST',channel:ch,parent:'123.456'});return cards;}
test('HTTP file_not_found finishes once with explicit deferred cleanup and unchanged metadata',async()=>{
 const f=fixture();try{await seed(f);const before=await f.snapshot();f.setUnavailable(true);const eventId=randomUUID(),id=await f.enqueue('FTEST',eventId);await f.run(id);await f.run(id);await f.enqueue('FTEST',eventId);await f.run(id);
  const w=(await f.raw.get<Work>('tasks',id))!;assert.equal(w.state,'done');assert.equal(w.generation,1);assert.equal(w.failureCode,undefined);assert.equal(infos(f),1);assert.deepEqual(await f.snapshot(),before);assert.equal(f.terminal.length,0);assert.equal(f.notices.length,0);
  assert.equal(resolutions(f).length,1);assert.equal(resolutions(f)[0].result,'visibility_unavailable');assert.equal(resolutions(f)[0].cleanup,'deferred');assert.ok(f.records.some(r=>r.event==='stage_finished'&&r.stage==='slack_files_info'&&r.ok===false&&r.slackError==='file_not_found'&&r.httpStatus===200));assert.ok(f.records.some(r=>r.event==='task_finished'&&r.ok===true));assert.equal(f.calls.some(c=>c.method.startsWith('chat.')),false);
 }finally{f.close();}
});
for(const relation of ['observed-only','source-only','root-only'] as const)test(`${relation} preserves all records on visibility loss`,async()=>{
 const f=fixture();try{if(relation==='observed-only')await f.put('observed','target',{file:'FTEST',channel:'CTEST'});else{const c=card(relation==='root-only');await f.put('cards',c.id,c);}const before=await f.snapshot();f.setUnavailable(true);const id=await f.enqueue();await f.run(id);assert.equal(infos(f),1);assert.deepEqual(await f.snapshot(),before);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'done');}finally{f.close();}
});
test('source, save, tickets and sessions fail closed; reshare rechecks current membership',async()=>{
 const f=fixture();try{const cards=await seed(f),bearers:string[]=[],tickets:string[]=[],sessions=[];for(const c of cards){const b=await f.app.sessions.exchange(f.app.sessions.issue(c.id,c.actor));bearers.push(b);sessions.push(await f.app.sessions.require(b));tickets.push(await f.app.sessions.issue(c.id,c.actor));}
  f.setUnavailable(true);await f.run(await f.enqueue());for(const [i,c] of cards.entries()){await assert.rejects(f.app.authorize(c.id,c.actor),{code:'slack_rejected'});await assert.rejects(f.app.ensureSource(c.id,c.actor),{code:'slack_rejected'});await assert.rejects(f.app.sessions.require(bearers[i]),{code:'slack_rejected'});await assert.rejects(f.app.sessions.exchange(tickets[i]),{code:'slack_rejected'});await assert.rejects(f.app.save(sessions[i],randomUUID(),'hwp',bytes),{code:'slack_rejected'});}
  assert.equal(f.downloads(),0);assert.equal(f.calls.some(c=>c.method==='files.getUploadURLExternal'),false);assert.equal((await f.raw.list('tickets')).length,0);f.setUnavailable(false);
  for(const [i,c] of cards.entries()){await f.app.authorize(c.id,c.actor);await f.app.sessions.require(bearers[i]);const fresh=await f.app.sessions.exchange(f.app.sessions.issue(c.id,c.actor));await f.app.sessions.require(fresh);}
  f.setIntercept(async method=>method==='conversations.members'?Response.json({ok:true,members:[],response_metadata:{next_cursor:''}}):undefined);for(const b of bearers)await assert.rejects(f.app.sessions.require(b),{code:'access_denied'});
 }finally{f.close();}
});
test('stale failed lookup preserves concurrently re-shared card and new session',async()=>{
 const f=fixture();let release!:()=>void;try{await seed(f);let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});let held=false;
  f.setIntercept(async method=>{if(method==='files.info'&&!held){held=true;entered();await gate;return Response.json({ok:false,error:'file_not_found'});}return undefined;});const id=await f.enqueue(),pending=f.run(id);await started;
  const fresh=card();await f.put('cards',fresh.id,fresh);const bearer=await f.app.sessions.exchange(f.app.sessions.issue(fresh.id,fresh.actor));const before=await f.snapshot();release();await pending;assert.deepEqual(await f.snapshot(),before);await f.app.sessions.require(bearer);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'done');await f.run(await f.enqueue());await f.app.sessions.require(bearer);assert.equal((await f.raw.get<Card&{removed?:boolean}>('cards',fresh.id))!.removed,undefined);
 }finally{release?.();f.close();}
});
test('delayed unshare preserves currently shared private channel and its sessions',async()=>{
 const f=fixture();try{const cards=await seed(f),bearers=[];for(const c of cards)bearers.push(await f.app.sessions.exchange(f.app.sessions.issue(c.id,c.actor)));f.setUnavailable(true);await f.run(await f.enqueue());f.setUnavailable(false);f.setShares(['CPRIVATE']);await f.run(await f.enqueue());
  for(const [i,c] of cards.entries()){if(c.actor.channelId==='CTEST'){assert.equal((await f.raw.get<Card&{removed:boolean}>('cards',c.id))!.removed,true);await assert.rejects(f.app.sessions.require(bearers[i]));}else{assert.equal((await f.raw.get<Card&{removed?:boolean}>('cards',c.id))!.removed,undefined);await f.app.sessions.require(bearers[i]);}}
  assert.equal(await f.raw.get('observed','CTEST'),undefined);assert.notEqual(await f.raw.get('observed','CPRIVATE'),undefined);
 }finally{f.close();}
});
for(const code of ['invalid_auth','missing_scope','access_denied','file_deleted','not_visible','internal_error'])test(`${code} still reaches terminal failure without deferred outcome`,async()=>{
 const f=fixture();try{await seed(f);const before=await f.snapshot();f.setIntercept(async method=>method==='files.info'?Response.json({ok:false,error:code}):undefined);const id=await f.enqueue();const permanent=['invalid_auth','missing_scope','file_deleted'].includes(code);if(!permanent){await assert.rejects(f.run(id));await assert.rejects(f.run(id));}await f.run(id);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'failed');assert.equal(infos(f),permanent?1:3);assert.equal(f.terminal.length,1);assert.equal(resolutions(f).length,0);assert.deepEqual(await f.snapshot(),before);}finally{f.close();}
});
for(const scenario of ['forged','wrong-class','wrong-code','wrong-http','network','partial','429','503'] as const)test(`${scenario} is not trusted visibility loss`,async()=>{
 const f=fixture();try{await seed(f);const before=await f.snapshot();f.setIntercept(async(method,args)=>{
  if(method!=='files.info')return undefined;
  if(scenario==='forged')throw Object.assign(new UserError('slack_rejected','file_not_found'),{httpStatus:200,slackError:'file_not_found'});
  if(scenario==='wrong-class')throw attachSlackDiagnostics(new Error('file_not_found'),200,'file_not_found');
  if(scenario==='wrong-code')throw attachSlackDiagnostics(new UserError('access_denied','file_not_found'),200,'file_not_found');
  if(scenario==='wrong-http')return Response.json({ok:false,error:'file_not_found'},{status:201});
  if(scenario==='network')throw new TypeError('synthetic network unavailable');
  if(scenario==='partial')return Response.json({ok:true,file:{...file,id:args.file,has_more_shares:true}});
  return Response.json({ok:false,error:'file_not_found'},{status:scenario==='429'?429:503,headers:{'retry-after':'0'}});
 });await assert.rejects(f.run(await f.enqueue()));assert.equal(resolutions(f).length,0);assert.deepEqual(await f.snapshot(),before);}finally{f.close();}
});
test('invalid file ID cannot defer a related error',async()=>{const f=fixture();try{await f.put('observed','invalid',{file:'invalid',channel:'CTEST'});f.setIntercept(async method=>method==='files.info'?Response.json({ok:false,error:'file_not_found'}):undefined);await assert.rejects(f.app.invalidate('invalid',true));assert.equal(resolutions(f).length,0);}finally{f.close();}});
for(const stage of ['preflight','post-lookup','atomic'] as const)test(`${stage} metadata errors remain outside Slack catch`,async()=>{
 let reads=0;const f=fixture(raw=>({get:raw.get.bind(raw),list:async<T>(kind:string,limit?:number)=>{if(kind==='cards'&&++reads===(stage==='preflight'?1:2)&&stage!=='atomic')throw new Error('synthetic store failure');return raw.list<T>(kind,limit);},atomic:async(kind,key,fn)=>{if(stage==='atomic'&&kind==='cards')throw new Error('synthetic store failure');return raw.atomic(kind,key,fn);}}));try{await seed(f);f.setShares([]);await assert.rejects(f.run(await f.enqueue()),/synthetic store failure/);assert.equal(resolutions(f).length,0);}finally{f.close();}
});
test('unavailable outcome has no cross-file or cross-store changes',async()=>{const f=fixture(),other=fixture();try{await seed(f);const unrelated={...card(),fileId:'FOTHER',rootFileId:'FOTHER'};await f.put('cards',unrelated.id,unrelated);await seed(other);const a=await f.snapshot(),b=await other.snapshot();f.setUnavailable(true);await f.run(await f.enqueue());assert.deepEqual(await f.snapshot(),a);assert.deepEqual(await other.snapshot(),b);assert.equal(other.calls.length,0);}finally{f.close();other.close();}});
test('untracked and deleted events still skip sharing lookup',async()=>{const f=fixture();try{f.setUnavailable(true);await f.run(await f.enqueue());assert.equal(infos(f),0);const cards=await seed(f);await f.run(await f.enqueue('FTEST',randomUUID(),'file_deleted'));assert.equal(infos(f),0);assert.equal(resolutions(f).length,0);for(const c of cards)assert.equal((await f.raw.get<Card&{removed:boolean}>('cards',c.id))!.removed,true);}finally{f.close();}});
test('telemetry excludes hostile messages, tokens, file and channel IDs',async()=>{const f=fixture();try{await seed(f);f.setIntercept(async method=>{if(method==='files.info')throw attachSlackDiagnostics(new UserError('slack_rejected','secret-marker https://files.slack.com/private?token=secret-marker'),200,'file_not_found');return undefined;});await f.run(await f.enqueue());const text=JSON.stringify(f.records);for(const secret of ['secret-marker','xoxb-','FTEST','CPRIVATE'])assert.equal(text.includes(secret),false);assert.equal(resolutions(f).length,1);}finally{f.close();}});
