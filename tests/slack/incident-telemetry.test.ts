import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks,TerminalNoticeFailure,type Work} from '../../src/server/cloud/tasks';
import {workerServer} from '../../src/server/cloud/worker';
import {traceTask,traceDelivery,bindDelivery,deliveryFailure} from '../../src/server/cloud/telemetry';
import {errorDiagnostics} from '../../src/server/cloud/error-diagnostics';
import {attachSlackDiagnostics} from '../../src/server/slack-diagnostics';
import type {MetadataStore,Change} from '../../src/server/cloud/metadata';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents,type Input} from '../../src/server/cloud/events';
import {actor,config,FakeApi} from './support';

const secret='xoxb-synthetic private-document.hwp https://private.invalid/?token=private';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'incident-telemetry-')),state=new State(join(dir,'state.sqlite'),'TTEST');
 let time=1000;
 const store=new SqliteMetadata(state,()=>time),terminal:Record<string,unknown>[]=[],published:string[]=[];
 const tasks=new DurableTasks(store,{async publish(id){published.push(id);}},()=>time,60_000,r=>terminal.push(r));
 return {store,tasks,terminal,published,advance(milliseconds:number){time+=milliseconds;},close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
test('terminal failure retains safe original diagnostics and records failed despite successful HTTP delivery',async()=>{
 const f=fixture(),rows:Record<string,unknown>[]=[],spec={teamId:'TTEST',cardId:'private-card',kind:'event' as const};
 try{
  const id=await f.tasks.enqueue('one',spec),error=new Error(secret);
  error.stack='Error: '+secret+'\n    at privateFunction (/app/src/server/cloud/events.ts:52:11)';
  const original=errorDiagnostics(error,'task_failure');
  for(let attempt=1;attempt<=3;attempt++){
   await traceDelivery(undefined,async()=>{
    bindDelivery('d'.repeat(64));
    const promise=f.tasks.execute(id,(s,c)=>traceTask(s,c,async()=>{throw error;},r=>rows.push(r)));
    if(attempt<3)await assert.rejects(promise,e=>e===error);else await promise;
   },()=>attempt<3?503:204,r=>rows.push(r));
  }
  const saved=await f.store.get<Work>('tasks',id);
  assert.equal(saved?.state,'failed');assert.equal(saved?.failureDetails?.errorId,original.errorId);
  assert.equal(f.terminal.length,1);assert.equal(f.terminal[0].errorId,original.errorId);
  assert.deepEqual(f.terminal[0].stackFrames,original.stackFrames);
  assert.deepEqual(rows.filter(r=>r.event==='task_state_finished').map(r=>r.state),['failed']);
  assert.equal(rows.at(-1)?.statusCode,204);assert.equal(rows.at(-1)?.ok,true);
  for(const value of [secret,'privateFunction'])assert.equal(JSON.stringify([saved?.failureDetails,f.terminal,rows]).includes(value),false);
 }finally{f.close();}
});
test('empty mention keeps two 503 waits then one successful attachment notice, with no document work',async()=>{
 const f=fixture(),rows:Record<string,unknown>[]=[],api=new FakeApi(),app=new CloudApplication(config,api,f.store,f.tasks);
 let submits=0;app.submit=async()=>{submits++;throw new Error('Unexpected document submit');};
 const events=new CloudEvents(app,'UBOT');
 await events.enqueue('EEMPTY',{kind:'app_mention',actor:{...actor},files:[]});
 const id=f.published.at(-1)!,work=(await f.store.get<Work>('tasks',id))!;
 const server=workerServer(f.tasks,(s,c)=>traceTask(s,c,()=>events.execute(s,c),r=>rows.push(r)),{
  audience:'https://synthetic.run.app',serviceAccount:'synthetic@example.iam.gserviceaccount.com',verify:async t=>t==='valid',diagnosticSink:r=>rows.push(r),
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const statuses:number[]=[];
  for(let attempt=1;attempt<=3;attempt++){
   if(attempt===3)await f.store.atomic<Input,void>('inputs',work.spec.cardId,current=>({value:{...current!,receivedAt:Date.now()-31_000},result:undefined}));
   const response=await fetch(`http://127.0.0.1:${address.port}/internal/tasks`,{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({id})});
   statuses.push(response.status);await response.text();
  }
  assert.deepEqual(statuses,[503,503,204]);assert.equal(submits,0);
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'done');assert.equal((await f.store.get<Work>('tasks',id))?.generation,3);
  assert.deepEqual(rows.filter(r=>r.event==='event_input_observed').map(r=>[r.inputState,r.documentWork]),[
   ['awaiting_share','not_started'],['awaiting_share','not_started'],['attachment_required','not_started'],
  ]);
  const failed=rows.filter(r=>r.event==='task_finished'&&r.ok===false);
  assert.equal(failed.length,2);assert.ok(failed.every(r=>r.errorCode==='internal'&&r.diagnosticCode==='attachment_pending'));
  assert.deepEqual(rows.filter(r=>r.event==='event_input_notice_finished').map(r=>r.status),['sent']);
  const notices=api.calls.filter(call=>call.method==='chat.postEphemeral');assert.equal(notices.length,1);
  assert.equal(notices[0].args.text,'HWP/HWPX 파일과 함께 @rhwp를 멘션해 주세요. 이전 파일은 해당 메시지 메뉴의 한글 문서 열기로 요청할 수 있습니다.');
  assert.equal(api.calls.some(call=>['chat.postMessage','files.getUploadURLExternal','files.completeUploadExternal','files.info'].includes(call.method)),false);
  assert.equal(rows.some(r=>['pdf_prepared','slack_published','conversion_stage'].includes(String(r.event))),false);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));f.close();}
});
test('a later file arrival clears the earlier no-document-work observation without claiming conversion',async()=>{
 const f=fixture(),rows:Record<string,unknown>[]=[],api=new FakeApi(),app=new CloudApplication(config,api,f.store,f.tasks);
 let submits=0;app.submit=async()=>{submits++;return 'synthetic-card';};
 const events=new CloudEvents(app,'UBOT');
 try{
  await events.enqueue('ELATE',{kind:'app_mention',actor:{...actor},files:[]});
  const id=f.published.at(-1)!,work=(await f.store.get<Work>('tasks',id))!;
  const run=()=>f.tasks.execute(id,(s,c)=>traceTask(s,c,()=>events.execute(s,c),r=>rows.push(r)));
  await assert.rejects(run(),{message:'Awaiting file share event'});
  await f.store.atomic<Input,void>('inputs',work.spec.cardId,current=>({value:{...current!,files:['FTEST']},result:undefined}));
  await run();
  assert.equal(submits,1);
  assert.deepEqual(rows.filter(r=>r.event==='event_input_observed').map(r=>[r.inputState,r.documentWork]),[['awaiting_share','not_started'],['files_available','unknown']]);
  assert.equal(rows.some(r=>r.event==='pdf_prepared'||r.event==='slack_published'),false);
 }finally{f.close();}
});
test('worker logs routing failures outside business traces and separates Slack status from delivery status',async()=>{
 const rows:Record<string,unknown>[]=[],delivery='d'.repeat(64);
 const server=workerServer({async execute(){throw attachSlackDiagnostics(new Error(secret),200,'file_not_found');}},async()=>{},{
  audience:'https://synthetic.run.app',serviceAccount:'synthetic@example.iam.gserviceaccount.com',verify:async t=>t==='valid',diagnosticSink:r=>rows.push(r),
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const url=`http://127.0.0.1:${address.port}/internal/tasks`;
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({id:delivery})});
  assert.equal(response.status,503);
  const finished=rows.find(r=>r.event==='worker_delivery_finished')!;
  assert.equal(finished.deliveryId,delivery);assert.equal(finished.taskId,undefined);assert.equal(finished.diagnosticCode,'worker_delivery');
  assert.equal(finished.statusCode,503);assert.equal(finished.httpStatus,200);assert.equal(finished.ok,false);
  assert.equal(finished.errorCode,'internal');assert.equal(JSON.stringify(rows).includes(secret),false);
  const forbidden=await fetch(url,{method:'POST',headers:{Authorization:'Bearer invalid','Content-Type':'application/json'},body:JSON.stringify({id:delivery})});
  assert.equal(forbidden.status,403);assert.equal(rows.at(-1)?.deliveryId,undefined);
 }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test('state success is emitted after durable commit and watchdog cleanup never claims document success',async()=>{
 const f=fixture(),rows:Record<string,unknown>[]=[],spec={teamId:'TTEST',cardId:'private-card',kind:'preview' as const};
 try{
  const id=await f.tasks.enqueue('success',spec);
  await traceDelivery(undefined,()=>f.tasks.execute(id,async()=>{}),()=>204,r=>rows.push(r));
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'done');
  assert.deepEqual(rows.filter(r=>r.event==='task_state_finished').map(r=>[r.taskId,r.state]),[[id,'done']]);
  rows.length=0;await traceDelivery(undefined,()=>f.tasks.execute(id,async()=>{throw new Error('must not run');}),()=>204,r=>rows.push(r));
  assert.equal(rows.some(r=>r.event==='task_state_finished'),false);
  f.advance(15*60_000);
  await traceDelivery(undefined,()=>f.tasks.execute(f.published[0],async()=>{throw new Error('finished task must not run');}),()=>204,r=>rows.push(r));
  assert.equal(rows.some(r=>r.event==='task_state_finished'),false);
 }finally{f.close();}
});
test('metadata final-commit failure is observable after successful callback and never emits done',async()=>{
 const f=fixture(),rows:Record<string,unknown>[]=[];
 try{
  const spec={teamId:'TTEST',cardId:'private-card',kind:'event' as const},id=await f.tasks.enqueue('commit-fails',spec);
  const store:MetadataStore={
   get:(kind,key)=>f.store.get(kind,key),list:(kind,limit)=>f.store.list(kind,limit),
   atomic:<T,R>(kind:string,key:string,change:(current:T|undefined)=>Change<T,R>)=>f.store.atomic<T,R>(kind,key,current=>{
    const result=change(current);
    if(kind==='tasks'&&(result.value as Work|undefined)?.state==='done')throw new Error(secret);
    return result;
   }),
  };
  const tasks=new DurableTasks(store,{publish:async()=>{}},()=>1000);
  await traceDelivery(undefined,async()=>{
   bindDelivery('d'.repeat(64));
   try{await tasks.execute(id,(s,c)=>traceTask(s,c,async()=>{},r=>rows.push(r)));}
   catch(error){deliveryFailure(error);}
  },()=>503,r=>rows.push(r));
  assert.equal(rows.find(r=>r.event==='task_finished')?.ok,true);
  assert.equal(rows.at(-1)?.ok,false);assert.equal(rows.at(-1)?.taskId,id);
  assert.equal(rows.some(r=>r.event==='task_state_finished'&&r.state==='done'),false);
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'queued');
 }finally{f.close();}
});
test('legacy terminal metadata has no fabricated original stack and notice wrappers preserve error identity',async()=>{
 const f=fixture();
 try{
  const id=await f.tasks.enqueue('legacy',{teamId:'TTEST',cardId:'private-card',kind:'event'});
  await f.store.atomic<Work,void>('tasks',id,current=>({value:{...current!,state:'failed',generation:3,failureCode:'internal'},result:undefined}));
  await f.tasks.execute(id,async()=>{throw new Error('Must not repeat business work');});
  assert.deepEqual(f.terminal[0].stackFrames,[]);assert.equal(f.terminal[0].exceptionType,'Other');
  const original=new Error(secret),wrapper=new TerminalNoticeFailure(original);
  assert.equal(errorDiagnostics(wrapper).errorId,errorDiagnostics(original).errorId);
  assert.deepEqual(errorDiagnostics(wrapper).stackFrames,errorDiagnostics(original).stackFrames);
 }finally{f.close();}
});
