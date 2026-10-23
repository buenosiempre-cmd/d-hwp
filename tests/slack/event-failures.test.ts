import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import type {MetadataStore,Change} from '../../src/server/cloud/metadata';
import {DurableTasks,type Work,type TaskSpec} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents,type Input} from '../../src/server/cloud/events';
import {UserError} from '../../src/server/errors';
import {attachSlackDiagnostics} from '../../src/server/slack-diagnostics';
import {isPermanentEventFailure} from '../../src/server/cloud/task-failures';
import {HttpSlackApi,readBounded} from '../../src/server/slack-api';
import {actor,config,FakeApi} from './support';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rhwp-event-failure-')),state=new State(join(dir,'db.sqlite'),'TTEST');let time=Date.now();
 const store=new SqliteMetadata(state,()=>time),api=new FakeApi(),published:{id:string;at?:number}[]=[],terminal:Record<string,unknown>[]=[],notices:Record<string,unknown>[]=[];
 const tasks=new DurableTasks(store,{async publish(id,at){published.push({id,at});}},()=>time,60_000,r=>terminal.push(r));
 const app=new CloudApplication(config,api,store,tasks),events=new CloudEvents(app,'UBOT',r=>notices.push(r));
 let sequence=0;
 return {store,api,tasks,app,events,published,terminal,notices,advance(n:number){time+=n;},
  async enqueue(kind:Input['kind']='app_mention',who=actor){await events.enqueue('E'+sequence++,{kind,actor:{...who},files:['FTEST'],fileId:'FTEST'});return published.filter(p=>p.at===undefined).at(-1)!.id;},
  run(id:string){return tasks.execute(id,(s,c)=>events.execute(s,c),(s,c)=>events.terminal(s,c));},
  close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
const rejected=(code:string)=>attachSlackDiagnostics(new UserError('slack_rejected','private Slack details'),200,code);
function fileFailure(f:ReturnType<typeof fixture>,code:string){f.api.handler=async(method,args)=>{if(method==='files.info')throw rejected(code);return f.api.response(method,args);};}
const posts=(f:ReturnType<typeof fixture>)=>f.api.calls.filter(c=>c.method==='chat.postEphemeral');

test('only trusted Slack diagnostics shorten event attempts; unknown and forged fields do not',()=>{
 for(const code of ['missing_scope','invalid_auth','not_authed','token_revoked','token_expired','account_inactive','file_deleted']){
  assert.equal(isPermanentEventFailure({kind:'event'},rejected(code)),true);assert.equal(isPermanentEventFailure({kind:'prepare'},rejected(code)),false);
 }
 for(const code of ['file_not_found','not_visible','access_denied','no_permission','ratelimited','internal_error','fatal_error','service_unavailable','unknown'])assert.equal(isPermanentEventFailure({kind:'event'},rejected(code)),false);
 const forged=Object.assign(new UserError('slack_rejected','xoxb-forged'),{slackError:'missing_scope',httpStatus:200});assert.equal(isPermanentEventFailure({kind:'event'},forged),false);
 assert.equal(isPermanentEventFailure({kind:'event'},attachSlackDiagnostics(new Error('foreign'),200,'missing_scope')),false);
});
test('permanent event failure commits before notice and redelivery never repeats file lookup',async()=>{
 const f=fixture();try{
  const id=await f.enqueue();let sends=0;
  f.api.handler=async(method,args)=>{
   if(method==='files.info')return new HttpSlackApi('xoxb-private',async()=>new Response(JSON.stringify({ok:false,error:'missing_scope'}))).call('files.info',{file:'FPRIVATE'});
   if(method==='chat.postEphemeral'){sends++;assert.equal((await f.store.get<Work>('tasks',id))!.state,'failed');}
   return f.api.response(method,args);
  };
  await f.run(id);await f.run(id);
  assert.equal(sends,1);assert.equal(f.api.calls.filter(c=>c.method==='files.info').length,1);assert.equal((await f.store.get<Work>('tasks',id))!.failureCode,'slack_rejected');
  assert.equal(f.terminal[0]?.slackError,'missing_scope');assert.equal(f.terminal[0]?.attempt,1);assert.equal(f.notices[0]?.status,'sent');
  for(const value of ['private Slack','xoxb-private','FPRIVATE','문서.hwp','files.slack.com'])assert.equal(JSON.stringify(posts(f)).includes(value),false);
 }finally{f.close();}
});
test('Slack size_limit commits one failed event with byte diagnostics and never replays the lookup',async()=>{
 for(const kind of ['app_mention','file_shared'] as const){
  const f=fixture();try{
   const id=await f.enqueue(kind);let requests=0,cancelled=0;
   f.api.handler=async(method,args)=>{
    if(method==='files.info')return new HttpSlackApi('synthetic',async()=>{
     requests++;
     return new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{'content-length':String(4*1024*1024+1)}});
    }).call(method,args);
    if(method==='chat.postEphemeral')assert.equal((await f.store.get<Work>('tasks',id))!.state,'failed');
    return f.api.response(method,args);
   };
   await f.run(id);await f.run(id);
   const work=(await f.store.get<Work>('tasks',id))!;
   assert.equal(work.state,'failed');assert.equal(work.generation,1);assert.equal(work.failureCode,'size_limit');
   assert.equal(requests,1);assert.equal(cancelled,1);assert.equal(f.terminal.length,1);
   assert.equal(f.terminal[0].attempt,1);assert.equal(f.terminal[0].errorCode,'size_limit');assert.equal(f.terminal[0].httpStatus,200);
   assert.equal(f.terminal[0].responseBytesRead,0);assert.equal(f.terminal[0].responseLimitBytes,4*1024*1024);
   assert.equal(f.terminal[0].responseContentLengthBytes,4*1024*1024+1);
   assert.equal(posts(f).length,kind==='app_mention'?1:0);
   assert.equal(f.api.calls.some(c=>['chat.postMessage','files.getUploadURLExternal','files.completeUploadExternal'].includes(c.method)),false);
  }finally{f.close();}
 }
});
test('only bounded Slack response size errors shorten event retries, not downloads or forged fields',async()=>{
 const bounded=await readBounded(new Response('xx'),1).catch(error=>error);
 const forged=Object.assign(new UserError('size_limit','synthetic'),{httpStatus:200,responseLimitBytes:1});
 const transport=new HttpSlackApi('synthetic',async()=>{throw forged;});
 await assert.rejects(transport.call('files.info',{}));
 for(const error of [bounded,forged,new UserError('size_limit','synthetic'),attachSlackDiagnostics(new UserError('size_limit','synthetic'),200)]){
  assert.equal(isPermanentEventFailure({kind:'event'},error),false);
 }
 const api=new HttpSlackApi('synthetic',async()=>new Response(null,{headers:{'content-length':String(4*1024*1024+1)}}));
 const error=await api.call('files.info',{}).catch(error=>error);
 assert.equal(isPermanentEventFailure({kind:'event'},error),true);
 for(const kind of ['prepare','preview','images'])assert.equal(isPermanentEventFailure({kind},error),false);
});
test('transient HTTP, transport and Slack logical failures retain queued retries and can recover',async()=>{
 for(const failure of ['503','429','transport','timeout','internal_error'] as const){
  const f=fixture();try{
   const id=await f.enqueue('file_shared');let failing=true,requests=0;
   f.api.handler=async(method,args)=>{
    if(method==='files.info')return new HttpSlackApi('synthetic',async()=>{
     requests++;
     if(!failing)return Response.json({ok:true,file:{id:'FTEST',name:'not-a-document.txt'}});
     if(failure==='transport')throw new TypeError('synthetic transport');
     if(failure==='timeout')throw new DOMException('synthetic timeout','TimeoutError');
     if(failure==='internal_error')return Response.json({ok:false,error:failure});
     return new Response(null,{status:Number(failure),headers:{'retry-after':'0.001'}});
    }).call(method,args);
    return f.api.response(method,args);
   };
   await assert.rejects(f.run(id));
   assert.equal((await f.store.get<Work>('tasks',id))!.state,'queued');assert.equal(f.terminal.length,0);
   assert.equal(requests,['503','429'].includes(failure)?3:1);
   failing=false;await f.run(id);
   const work=(await f.store.get<Work>('tasks',id))!;assert.equal(work.state,'done');assert.equal(work.generation,2);
   assert.equal(f.terminal.length,0);
  }finally{f.close();}
 }
});
test('visibility retries stay bounded and final notice runs once without sharing or converting files',async()=>{
 const f=fixture();try{
  const id=await f.enqueue();fileFailure(f,'file_not_found');
  await assert.rejects(f.run(id));await assert.rejects(f.run(id));assert.equal(posts(f).length,0);
  await f.run(id);await f.run(id);assert.equal(posts(f).length,1);assert.equal(f.api.calls.filter(c=>c.method==='files.info').length,3);
  assert.equal((await f.store.get<Work>('tasks',id))!.state,'failed');assert.equal(f.api.calls.some(c=>['chat.postMessage','files.getUploadURLExternal','files.completeUploadExternal'].includes(c.method)),false);
 }finally{f.close();}
});
test('deadline recovers a lost event attempt; stale worker cannot retry or send another notice',async()=>{
 const f=fixture();try{
  const id=await f.enqueue(),watch=f.published.find(p=>p.at!==undefined)!;let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const pending=f.tasks.execute(id,async(_s,c)=>{entered();await gate;await c.checkpoint();},(s,c)=>f.events.terminal(s,c));await started;
  f.advance(15*60_000);await f.run(watch.id);assert.equal(posts(f).length,1);assert.equal((await f.store.get<Work>('tasks',id))!.state,'failed');
  release();await assert.rejects(pending);await f.run(id);await f.run(watch.id);assert.equal(posts(f).length,1);
  assert.equal(f.api.calls.some(c=>c.method==='files.info'),false);
 }finally{f.close();}
});
test('automatic and other events have no new terminal notice or deadline delivery',async()=>{
 const f=fixture();try{
  for(const kind of ['file_shared','channel_joined','home','file_deleted','file_unshared','retry_preview','more_pages'] as const){
   const id=await f.enqueue(kind),work=(await f.store.get<Work>('tasks',id))!;assert.equal(work.spec.terminalNoticeRequested,undefined);
   await f.events.terminal(work.spec,{id,attempt:3,failureCode:'slack_rejected'});
  }
  assert.equal(f.published.some(p=>p.at!==undefined),false);assert.equal(posts(f).length,0);
 }finally{f.close();}
});
test('duplicate and legacy signed events retain their original task specification',async()=>{
 const f=fixture();try{
  const input:Input={kind:'app_mention',actor,files:['FTEST']};await f.events.enqueue('EDUP',input);await f.events.enqueue('EDUP',input);
  const work=(await f.store.list<Work>('tasks')).map(([,w])=>w).find(w=>!w.watchdogFor)!;assert.equal(work.spec.terminalNoticeRequested,true);
  const oldCard=createHash('sha256').update('TTEST:EOLD').digest('hex');await f.store.atomic('inputs',oldCard,()=>({value:input,result:undefined}));
  await f.tasks.enqueue('event:'+oldCard,{teamId:'TTEST',cardId:oldCard,kind:'event'});await f.events.enqueue('EOLD',input);
  assert.equal((await f.store.list<Work>('tasks')).filter(([,w])=>w.watchdogFor).length,1);
  await assert.rejects(f.tasks.reserve('bad',{teamId:'TTEST',cardId:'card',kind:'preview',terminalNoticeRequested:true}));
 }finally{f.close();}
});
test('parallel terminal callbacks and ambiguous send failures consume one send attempt',async()=>{
 const f=fixture();try{
  const id=await f.enqueue(),work=(await f.store.get<Work>('tasks',id))!;
  f.api.handler=async(method,args)=>{if(method==='chat.postEphemeral')throw new Error('ambiguous transfer result');return f.api.response(method,args);};
  const ctx={id,attempt:3,failureCode:'slack_rejected'};await Promise.all([f.events.terminal(work.spec,ctx),f.events.terminal(work.spec,ctx)]);await f.events.terminal(work.spec,ctx);
  assert.equal(posts(f).length,1);assert.equal((await f.store.list<any>('event_notices'))[0]?.[1].state,'failed');
  assert.equal(f.notices.some(r=>r.status==='failed'),true);assert.equal(JSON.stringify(await f.store.list('event_notices')).includes('ambiguous transfer'),false);
 }finally{f.close();}
});
test('a recorded attempt survives process loss and cannot be posted by replacement callbacks',async()=>{
 const f=fixture();try{
  const id=await f.enqueue(),work=(await f.store.get<Work>('tasks',id))!,key=createHash('sha256').update('event-notice:'+id).digest('hex');
  await f.store.atomic('event_notices',key,()=>({value:{state:'attempted',attemptedAt:Date.now()},result:undefined}));
  await new CloudEvents(f.app,'UBOT').terminal(work.spec,{id,attempt:3,failureCode:'task_deadline'});assert.equal(posts(f).length,0);
 }finally{f.close();}
});
test('current channel policy and actor membership prevent private notices without file access',async()=>{
 for(const scenario of ['off','member_removed','bot_removed','wrong_workspace','bot_request'] as const){
  const f=fixture();try{
   const id=await f.enqueue(),work=(await f.store.get<Work>('tasks',id))!;
   if(scenario==='off')await f.store.atomic('channels','CTEST',()=>({value:{mode:'off'},result:undefined}));
   if(scenario==='wrong_workspace'||scenario==='bot_request')await f.store.atomic<Input,void>('inputs',work.spec.cardId,current=>({value:{...current!,actor:{...actor,teamId:scenario==='wrong_workspace'?'TOTHER':'TTEST',userId:scenario==='bot_request'?'UBOT':'UTEST'}},result:undefined}));
   f.api.handler=async(method,args)=>{
    const response=f.api.response(method,args);if(scenario==='member_removed'&&method==='conversations.members')return {...response,members:[]};
    if(scenario==='bot_removed'&&method==='conversations.info')return {...response,channel:{...(response.channel as object),is_member:false}};return response;
   };
   await f.events.terminal(work.spec,{id,attempt:3,failureCode:'slack_rejected'});assert.equal(posts(f).length,0);assert.equal(f.api.calls.some(c=>c.method==='files.info'),false);
  }finally{f.close();}
 }
});
test('event final persistence failure and expired ownership cannot invoke terminal callback',async()=>{
 const f=fixture();try{
  const id=await f.enqueue();let notices=0;
  const rejecting:MetadataStore={get:f.store.get.bind(f.store),list:f.store.list.bind(f.store),async atomic<T,R>(kind:string,key:string,change:(current:T|undefined)=>Change<T,R>){return f.store.atomic<T,R>(kind,key,current=>{const result=change(current);if((result.value as Work|undefined)?.state==='failed')throw new Error('storage unavailable');return result;});}};
  await assert.rejects(new DurableTasks(rejecting,{async publish(){}},Date.now).execute(id,async()=>{throw rejected('missing_scope');},async()=>{notices++;}));assert.equal(notices,0);
  const expired=await f.tasks.enqueue('expired',{teamId:'TTEST',cardId:'card',kind:'event'});
  await assert.rejects(f.tasks.execute(expired,async()=>{f.advance(60_001);throw rejected('missing_scope');},async()=>{notices++;}));assert.equal(notices,0);
 }finally{f.close();}
});
test('notice callback failure cannot change permanent task failure or trigger business replay',async()=>{
 const f=fixture();try{
  const id=await f.enqueue();let calls=0;const run=async()=>{calls++;throw rejected('missing_scope');};const notice=async()=>{throw new Error('notice unavailable');};
  await f.tasks.execute(id,run,notice);await f.tasks.execute(id,run,notice);assert.equal(calls,1);assert.equal((await f.store.get<Work>('tasks',id))!.state,'failed');
 }finally{f.close();}
});

test('authenticated worker acknowledges permanent event failure with 204 after durable commit and notice',async()=>{
 const {workerServer}=await import('../../src/server/cloud/worker');const f=fixture();
 const id=await f.enqueue();fileFailure(f,'missing_scope');
 const server=workerServer({execute:async(taskId)=>f.run(taskId)},async()=>{}, {audience:'https://worker.run.app',serviceAccount:'worker@example.iam.gserviceaccount.com',verify:async token=>token==='valid'});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');
 const send=()=>fetch(`http://127.0.0.1:${address.port}/internal/tasks`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer valid'},body:JSON.stringify({id})});
 try{
  assert.equal((await send()).status,204);assert.equal((await f.store.get<Work>('tasks',id))!.state,'failed');assert.equal(posts(f).length,1);
  assert.equal(f.terminal[0]?.slackError,'missing_scope');assert.equal(f.terminal[0]?.httpStatus,200);
  assert.equal((await send()).status,204);assert.equal(posts(f).length,1);assert.equal(f.api.calls.filter(c=>c.method==='files.info').length,1);
 }finally{await new Promise<void>(r=>server.close(()=>r()));f.close();}
});
