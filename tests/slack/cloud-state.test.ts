import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {encodeMetadata} from '../../src/server/cloud/metadata';
import {SharedSessions} from '../../src/server/cloud/sessions';
import {DurableTasks,TaskBusy,LeaseLost,GoogleTaskPublisher,TerminalNoticeFailure} from '../../src/server/cloud/tasks';
import type {CloudTasksClient} from '@google-cloud/tasks';
import type {MetadataStore} from '../../src/server/cloud/metadata';
import {HttpSlackApi} from '../../src/server/slack-api';
import {traceTask} from '../../src/server/cloud/telemetry';
import {actor} from './support';
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rhwp-cloud-test-'));const path=join(dir,'state.sqlite');
  const a=new State(path,'TTEST'),b=new State(path,'TTEST'),other=new State(path,'TOTHER');let time=0;
  return {a:new SqliteMetadata(a,()=>time),b:new SqliteMetadata(b,()=>time),other:new SqliteMetadata(other,()=>time),now:()=>time,advance:(n:number)=>{time+=n;},close(){a.close();b.close();other.close();rmSync(dir,{recursive:true,force:true});}};
}
test('metadata rejects document buffers, bearer credentials and temporary transfer URLs',()=>{
  for(const value of [{bytes:Buffer.from('document')},{nested:{data:new Uint8Array([1])}},{text:'xoxb-secret'},{url:'https://files.slack.com/upload/v1/private'},{body:'document'},{token:'secret'},{n:NaN},new Date()])assert.throws(()=>encodeMetadata(value));
  assert.equal(encodeMetadata({fileId:'FTEST',messageTs:'123.456',optional:undefined}),' {"fileId":"FTEST","messageTs":"123.456"}'.trim());
});
test('atomic records are shared, workspace-isolated and roll back on callback failure',async()=>{
  const f=fixture();try{
    await f.a.atomic('cards','one',()=>({value:{fileId:'FTEST'},result:undefined}));
    assert.deepEqual(await f.b.get('cards','one'),{fileId:'FTEST'});assert.equal(await f.other.get('cards','one'),undefined);
    await assert.rejects(f.b.atomic('cards','one',()=>{throw new Error('rollback');}));assert.deepEqual(await f.a.get('cards','one'),{fileId:'FTEST'});
    const claims=await Promise.all([f.a,f.b].map(store=>store.atomic<boolean,boolean>('claims','event',old=>({value:true,result:!old}))));assert.deepEqual(claims,[true,false]);
    await f.a.atomic('temporary','one',()=>({value:{id:1},expiresAt:10,result:undefined}));f.advance(10);assert.equal(await f.b.get('temporary','one'),undefined);
  }finally{f.close();}
});
test('two server instances exchange a ticket only once, and sessions survive process-local state loss',async()=>{
  const f=fixture();try{
    let authorizations=0;const authorize=async()=>{authorizations++;};
    const first=new SharedSessions(f.a,authorize,f.now),second=new SharedSessions(f.b,authorize,f.now);
    const ticket=await first.issue('card',actor);
    const attempts=await Promise.allSettled([first.exchange(ticket),second.exchange(ticket)]);
    assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
    const bearer=(attempts.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<string>).value;
    assert.equal((await new SharedSessions(f.b,authorize,f.now).require(bearer)).cardId,'card');assert.ok(authorizations>=2);
    assert.equal(JSON.stringify(await f.a.list('sessions')).includes(bearer),false);
    f.advance(10*60_000);await assert.rejects(second.require(bearer),{code:'session_expired'});
  }finally{f.close();}
});
test('revocation during authorization cannot create a new valid session',async()=>{
  const f=fixture();try{
    let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
    const first=new SharedSessions(f.a,async()=>{entered();await gate;},f.now),second=new SharedSessions(f.b,async()=>{},f.now);
    const ticket=await first.issue('card',actor),exchange=first.exchange(ticket);await started;await second.invalidate('card');release();
    await assert.rejects(exchange,{code:'session_expired'});
    const valid=await second.exchange(await second.issue('card',actor));await first.invalidate('card');await assert.rejects(second.require(valid),{code:'session_expired'});
  }finally{f.close();}
});
test('current permissions are checked on every shared session use and absolute lifetime is bounded',async()=>{
  const f=fixture();try{
    let allowed=true;const sessions=new SharedSessions(f.a,async()=>{if(!allowed)throw new Error('revoked');},f.now);
    const bearer=await sessions.exchange(await sessions.issue('card',actor));allowed=false;await assert.rejects(sessions.require(bearer));allowed=true;
    for(let i=0;i<7;i++){f.advance(8*60_000);await sessions.require(bearer);}
    f.advance(4*60_000);await assert.rejects(sessions.require(bearer));
  }finally{f.close();}
});
test('enqueue persistence survives delivery failure and concurrent deliveries execute only once',async()=>{
  const f=fixture();try{
    let fail=true;const names:string[]=[];const publisher={async publish(id:string,notBefore?:number){if(notBefore===undefined)names.push(id);if(fail)throw new Error('unavailable');}};
    const first=new DurableTasks(f.a,publisher,f.now),second=new DurableTasks(f.b,publisher,f.now);
    const spec={teamId:'TTEST',cardId:'card',kind:'preview' as const};await assert.rejects(first.enqueue('request',spec));fail=false;
    const id=await second.enqueue('request',spec);assert.equal(names.length,1);
    let release!:()=>void,entered!:()=>void,calls=0;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const run=first.execute(id,async()=>{calls++;entered();await gate;});await started;
    await assert.rejects(second.execute(id,async()=>{calls++;}),TaskBusy);release();await run;
    await second.execute(id,async()=>{calls++;});assert.equal(calls,1);
    await assert.rejects(second.enqueue('request',{...spec,cardId:'other'}));
  }finally{f.close();}
});
test('an expired worker cannot checkpoint or mark another delivery complete',async()=>{
  const f=fixture();try{
    const publisher={async publish(){}};const first=new DurableTasks(f.a,publisher,f.now),second=new DurableTasks(f.b,publisher,f.now);
    const id=await first.enqueue('request',{teamId:'TTEST',cardId:'card',kind:'images'});
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
    const old=first.execute(id,async(_spec,ctx)=>{entered();await gate;await ctx.checkpoint();});await started;
    f.advance(60_001);await second.execute(id,async()=>{});release();await assert.rejects(old,LeaseLost);
    let duplicate=false;await second.execute(id,async()=>{duplicate=true;});assert.equal(duplicate,false);
  }finally{f.close();}
});
test('Cloud Tasks sends only the opaque ID to an authenticated worker and deduplicates names',async()=>{
  let request:any;const fake={async createTask(r:unknown){request=r;throw {code:6};}} as unknown as CloudTasksClient;
  const publisher=new GoogleTaskPublisher(fake,'projects/project/locations/region/queues/preview','https://worker-123.run.app','worker@project.iam.gserviceaccount.com');
  const id='a'.repeat(64);await publisher.publish(id);
  assert.deepEqual(JSON.parse(request.task.httpRequest.body.toString()),{id});
  assert.equal(request.task.httpRequest.oidcToken.audience,'https://worker-123.run.app');
  assert.equal(request.task.httpRequest.oidcToken.serviceAccountEmail,'worker@project.iam.gserviceaccount.com');
  await assert.rejects(publisher.publish('../forged'));assert.throws(()=>new GoogleTaskPublisher(fake,'wrong','http://host','bad'));
});
test('actual editor HTTP routes accept a shared ticket after replacing the server instance',async()=>{
  const {editorServer,EditorApi}=await import('./editor-support');
  const dir=mkdtempSync(join(tmpdir(),'rhwp-cloud-http-')),state=new State(join(dir,'sessions.sqlite'),'TTEST');
  const metadata=new SqliteMetadata(state),api=new EditorApi(),statePath=join(dir,'cards.sqlite');
  let server=await editorServer({api,statePath,sessionStore:metadata});
  try{
    const card=await server.prepare();await server.documents!.pdf.idle();
    const ticket=await server.documents!.sessions.issue(card,actor);await server.stop();
    server=await editorServer({api,statePath,sessionStore:metadata});await server.ready;
    const exchange=await fetch(server.origin+'/api/editor/exchange',{method:'POST',headers:{Origin:server.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
    assert.equal(exchange.status,200);const {token}=await exchange.json() as {token:string};
    const source=await fetch(server.origin+'/api/editor/source',{headers:{Authorization:`Bearer ${token}`}});assert.equal(source.status,200);
    const duplicate=await fetch(server.origin+'/api/editor/exchange',{method:'POST',headers:{Origin:server.publicOrigin,'Content-Type':'application/json'},body:JSON.stringify({ticket})});assert.equal(duplicate.status,403);
    await server.documents!.sessions.invalidate(card);
    assert.equal((await fetch(server.origin+'/api/editor/source',{headers:{Authorization:`Bearer ${token}`}})).status,403);
  }finally{await server.stop();state.close();rmSync(dir,{recursive:true,force:true});}
});
test('worker refuses unauthorized dispatch and acknowledges only after durable completion',async()=>{
  const {workerServer}=await import('../../src/server/cloud/worker');const f=fixture();let executed=0;
  const tasks=new DurableTasks(f.a,{async publish(){}},f.now),id=await tasks.enqueue('worker',{teamId:'TTEST',cardId:'card',kind:'preview'});
  const server=workerServer(tasks,async()=>{executed++;},{audience:'https://worker.run.app',serviceAccount:'worker@example.iam.gserviceaccount.com',verify:async token=>token==='valid'});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('listen');const url=`http://127.0.0.1:${address.port}/internal/tasks`;
  const send=(token?:string)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({id})});
  try{assert.equal((await send()).status,403);assert.equal((await send('wrong')).status,403);assert.equal(executed,0);assert.equal((await send('valid')).status,204);assert.equal((await send('valid')).status,204);assert.equal(executed,1);}
  finally{await new Promise<void>(r=>server.close(()=>r()));f.close();}
});

test('conversion retries are finite; a redelivery repairs the final receipt without converting again',async()=>{
 const f=fixture();try{
  const tasks=new DurableTasks(f.a,{async publish(){}},f.now),id=await tasks.enqueue('bounded',{teamId:'TTEST',cardId:'card',kind:'preview'});let calls=0,notices=0;
  const run=async(_spec:any,ctx:any)=>{if(ctx.terminalNotice){if(ctx.terminalNotice.phase==='bookkeeping')ctx.terminalNotice.result='ready';else{notices++;ctx.terminalNotice.result='sent';}return;}calls++;assert.equal(ctx.finalAttempt,calls===3);throw Object.assign(new Error('secret document'),{code:'conversion_timeout'});};
  await assert.rejects(tasks.execute(id,run));await assert.rejects(tasks.execute(id,run));await tasks.execute(id,run);
  assert.equal((await f.a.get<any>('tasks',id)).state,'failed');await tasks.execute(id,run);
  assert.equal(calls,3);assert.equal(notices,1);assert.doesNotMatch(JSON.stringify(await f.a.list('tasks')),/secret document/);
 }finally{f.close();}
});
test('a durable deadline reconciles a killed last worker and fences stale checkpoints',async()=>{
 const f=fixture();try{
  const scheduled:{id:string;at?:number}[]=[];const tasks=new DurableTasks(f.a,{async publish(id,at){scheduled.push({id,at});}},f.now);
  const id=await tasks.enqueue('killed',{teamId:'TTEST',cardId:'card',kind:'preview'}),watch=scheduled.find(x=>x.at!==undefined)!;
  assert.equal(watch.at,15*60_000);await assert.rejects(tasks.execute(watch.id,async()=>{}),TaskBusy);
  let checkpoint!:()=>Promise<void>,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const active=tasks.execute(id,async(_s,ctx)=>{checkpoint=ctx.checkpoint;entered();await gate;await checkpoint();});await started;
  f.advance(15*60_000);let terminal=false;
  await tasks.execute(watch.id,async(_s,ctx)=>{terminal=!!ctx.terminalFailure;assert.equal(ctx.id,id);if(ctx.terminalNotice)ctx.terminalNotice.result=ctx.terminalNotice.phase==='bookkeeping'?'ready':'sent';});
  assert.equal(terminal,true);assert.equal((await f.a.get<any>('tasks',id)).state,'failed');release();await assert.rejects(active,LeaseLost);
 }finally{f.close();}
});

test('permanent conversion fails once; redelivery and failed notifications never convert again',async()=>{
 const f=fixture();try{
  const published:{id:string;at?:number}[]=[],tasks=new DurableTasks(f.a,{async publish(id,at){published.push({id,at});}},f.now);
  const id=await tasks.enqueue('permanent',{teamId:'TTEST',cardId:'card',kind:'preview'});let conversions=0,notices=0;
  const run=async(_s:any,ctx:any)=>{
   if(ctx.terminalNotice){assert.equal(ctx.terminalFailure,'conversion_svg_limit');if(ctx.terminalNotice.phase==='bookkeeping'){ctx.terminalNotice.result='ready';return;}notices++;if(notices===1)throw new TerminalNoticeFailure(new Error('notification unavailable'));ctx.terminalNotice.result='sent';return;}
   conversions++;throw Object.assign(new Error('private text'),{code:'conversion_svg_limit'});
  };
  await assert.rejects(tasks.execute(id,run));assert.equal((await f.a.get<any>('tasks',id)).state,'failed');
  await tasks.execute(id,run);await tasks.execute(id,run);
  f.advance(15*60_000);await tasks.execute(published.find(p=>p.at!==undefined)!.id,run);
  assert.equal(conversions,1);assert.equal(notices,2);
  const receipt=await f.a.get<any>('tasks',id);assert.equal(receipt.state,'failed');assert.equal(receipt.failureCode,'conversion_svg_limit');
 }finally{f.close();}
});

test('terminal failure appears only after committed final attempt and is distinct from callback traces',async()=>{
 const f=fixture();try{
  const terminal:Record<string,unknown>[]=[],traces:Record<string,unknown>[]=[],receipts:Promise<unknown>[]=[];
  const tasks=new DurableTasks(f.a,{async publish(){}},f.now,60_000,row=>{terminal.push(row);receipts.push(f.a.get('tasks',String(row.taskId)));});
  const spec={teamId:'TTEST',cardId:'private-card',kind:'event' as const},id=await tasks.enqueue('terminal-event',spec);
  const api=new HttpSlackApi('xoxb-secret',async()=>new Response(JSON.stringify({ok:false,error:'file_not_found'})));
  const run=async(s:any,ctx:any)=>{if(ctx.terminalFailure)return;await traceTask(s,ctx,()=>api.call('files.info',{file:'FPRIVATE'}),r=>traces.push(r));};
  await assert.rejects(tasks.execute(id,run));assert.equal(terminal.length,0);
  await assert.rejects(tasks.execute(id,run));assert.equal(terminal.length,0);
  await tasks.execute(id,run);assert.equal(terminal.length,1);
  assert.equal(terminal[0]?.taskId,id);assert.equal(terminal[0]?.attempt,3);assert.equal(terminal[0]?.slackError,'file_not_found');
  assert.equal((await receipts[0] as {state:string}).state,'failed');assert.equal(traces.filter(r=>r.event==='task_finished').length,3);
  await tasks.execute(id,run);assert.equal(terminal.length,1);assert.equal((await f.a.get<any>('tasks',id)).generation,3);
  assert.equal(new Set(terminal.map(r=>r.taskId)).size,1);
  for(const value of ['xoxb-secret','FPRIVATE','private-card','TTEST'])assert.equal(JSON.stringify(terminal).includes(value),false);
 }finally{f.close();}
});
test('failed persistence cannot emit a terminal receipt',async()=>{
 const f=fixture();try{
  const rows:Record<string,unknown>[]=[],normal=new DurableTasks(f.a,{async publish(){}},f.now),id=await normal.enqueue('persistence',{teamId:'TTEST',cardId:'card',kind:'event'});
  const rejecting={get:f.a.get.bind(f.a),list:f.a.list.bind(f.a),atomic:async(kind:string,key:string,change:any)=>f.a.atomic(kind,key,current=>{
   const result=change(current);if(result.value?.state==='failed')throw new Error('storage unavailable');return result;
  })} as MetadataStore;
  const tasks=new DurableTasks(rejecting,{async publish(){}},f.now,60_000,r=>rows.push(r));
  await assert.rejects(tasks.execute(id,async()=>{throw Object.assign(new Error('permanent'),{code:'conversion_svg_limit'});}));
  assert.equal(rows.length,0);assert.equal((await f.a.get<any>('tasks',id)).state,'running');
 }finally{f.close();}
});
test('watchdog failure remains observable even when its notification fails',async()=>{
 const f=fixture();try{
  const rows:Record<string,unknown>[]=[],scheduled:{id:string;at?:number}[]=[],tasks=new DurableTasks(f.a,{async publish(id,at){scheduled.push({id,at});}},f.now,60_000,r=>rows.push(r));
  const id=await tasks.enqueue('deadline-observation',{teamId:'TTEST',cardId:'card',kind:'preview'}),watch=scheduled.find(r=>r.at!==undefined)!;
  f.advance(15*60_000);
  await assert.rejects(tasks.execute(watch.id,async()=>{throw new Error('notification unavailable');}));
  assert.equal(rows.length,1);assert.equal(rows[0]?.taskId,id);assert.equal(rows[0]?.errorCode,'task_deadline');assert.equal(rows[0]?.attempt,0);
  assert.equal((await f.a.get<any>('tasks',id)).state,'failed');assert.equal((await f.a.get<any>('tasks',watch.id)).state,'queued');
 }finally{f.close();}
});
test('lost ownership and successful work cannot emit terminal failure',async()=>{
 const f=fixture();try{
  const rows:Record<string,unknown>[]=[],publisher={async publish(){}},first=new DurableTasks(f.a,publisher,f.now,60_000,r=>rows.push(r)),second=new DurableTasks(f.b,publisher,f.now,60_000,r=>rows.push(r));
  const id=await first.enqueue('lease-observation',{teamId:'TTEST',cardId:'card',kind:'event'});
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const old=first.execute(id,async(_s,ctx)=>{entered();await gate;await ctx.checkpoint();});await started;
  f.advance(60_001);await second.execute(id,async()=>{});release();await assert.rejects(old,LeaseLost);
  assert.equal(rows.length,0);assert.equal((await f.a.get<any>('tasks',id)).state,'done');
 }finally{f.close();}
});
test('terminal logger failure never changes durable completion or failure behavior',async()=>{
 const f=fixture();try{
  const tasks=new DurableTasks(f.a,{async publish(){}},f.now,60_000,()=>{throw new Error('sink offline');});
  const id=await tasks.enqueue('sink-failure',{teamId:'TTEST',cardId:'card',kind:'event'});
  await tasks.execute(id,async()=>{throw Object.assign(new Error('permanent'),{code:'conversion_svg_limit'});});
  assert.equal((await f.a.get<any>('tasks',id)).state,'failed');
 }finally{f.close();}
});

test('worker keeps 503 retries and terminal 204 distinct from logical Slack failure',async()=>{
 const {workerServer}=await import('../../src/server/cloud/worker');const f=fixture();
 const rows:Record<string,unknown>[]=[],tasks=new DurableTasks(f.a,{async publish(){}},f.now,60_000,r=>rows.push(r));
 const id=await tasks.enqueue('http-terminal',{teamId:'TTEST',cardId:'card',kind:'event'});
 const api=new HttpSlackApi('xoxb-secret',async()=>new Response(JSON.stringify({ok:false,error:'file_not_found'})));
 const server=workerServer(tasks,async()=>{await api.call('files.info',{file:'FPRIVATE'});},{audience:'https://worker.run.app',serviceAccount:'worker@example.iam.gserviceaccount.com',verify:async token=>token==='valid'});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('listen');
 const send=()=>fetch(`http://127.0.0.1:${address.port}/internal/tasks`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer valid'},body:JSON.stringify({id})});
 try{
  assert.equal((await send()).status,503);assert.equal(rows.length,0);
  assert.equal((await send()).status,503);assert.equal(rows.length,0);
  assert.equal((await send()).status,204);assert.equal(rows.length,1);assert.equal(rows[0]?.slackError,'file_not_found');assert.equal(rows[0]?.httpStatus,200);
  assert.equal((await f.a.get<any>('tasks',id)).state,'failed');
 }finally{await new Promise<void>(r=>server.close(()=>r()));f.close();}
});
