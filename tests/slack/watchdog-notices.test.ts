import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import type {MetadataStore,Change} from '../../src/server/cloud/metadata';
import {DurableTasks,TaskBusy,LeaseLost,TerminalNoticeFailure,type Work,type TaskSpec,type TaskContext,type TerminalNotice} from '../../src/server/cloud/tasks';
import {HttpSlackApi,type SlackApi} from '../../src/server/slack-api';
import {UserError} from '../../src/server/errors';
import {workerServer} from '../../src/server/cloud/worker';
import {CloudApplication} from '../../src/server/cloud/application';
import {EditorApi} from './editor-support';
import {actor,config,bytes} from './support';

const permanent=()=>Object.assign(new Error('private document xoxb-secret'),{code:'conversion_svg_limit'});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'watchdog-notices-')),state=new State(join(dir,'state.sqlite'),'TTEST');let time=1000;
 const store=new SqliteMetadata(state,()=>time),published:{id:string;at?:number}[]=[],terminal:Record<string,unknown>[]=[],notices:Record<string,unknown>[]=[];
 const make=(storage:MetadataStore=store,sink=(r:Record<string,unknown>)=>terminal.push(r))=>new DurableTasks(storage,{async publish(id,at){published.push({id,at});}},()=>time,60_000,sink,r=>notices.push(r));
 const tasks=make(),spec:TaskSpec={teamId:'TTEST',cardId:'private-card',kind:'preview'};
 return {store,tasks,make,spec,published,terminal,notices,statePath:join(dir,'state.sqlite'),now:()=>time,advance(n:number){time+=n;},
  async seed(key='seed'){const id=await tasks.enqueue(key,spec);await store.atomic<Work,void>('tasks',id,c=>({value:{...c!,state:'failed',generation:1,terminalAt:time,failureCode:'conversion_svg_limit'},expiresAt:time+7*86400_000,result:undefined}));return id;},
  close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
function runner(deliver:(ctx:TaskContext)=>Promise<void>,business=()=>{throw permanent();}){
 return async(_spec:TaskSpec,ctx:TaskContext)=>{
  if(!ctx.terminalNotice){business();return;}
  if(ctx.terminalNotice.phase==='bookkeeping'){ctx.terminalNotice.result='ready';return;}
  await deliver(ctx);ctx.terminalNotice.result??='sent';
 };
}
async function rejection(code:string){
 const api=new HttpSlackApi('xoxb-synthetic',async()=>Response.json({ok:false,error:code}));
 try{await api.call('chat.update',{});}catch(error){return new TerminalNoticeFailure(error);}
 throw new Error('Expected Slack rejection');
}

test('worker shares three notice reservations across original/watchdog deliveries, stops 503 and preserves failed business',async()=>{
 const f=fixture();let server:ReturnType<typeof workerServer>|undefined;
 try{
  let business=0,sends=0;const error=await rejection('unable_to_share_files'),id=await f.tasks.enqueue('http-budget',f.spec);
  const run=runner(async()=>{sends++;throw error;},()=>{business++;throw permanent();});
  const watch=f.published.find(x=>x.at!==undefined)!.id;
  server=workerServer(f.tasks,run,{audience:'https://synthetic.run.app',serviceAccount:'test@example.iam.gserviceaccount.com',verify:async t=>t==='valid'});
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const a=server.address();assert.ok(a&&typeof a!=='string');
  const send=async(taskId:string)=>(await fetch('http://127.0.0.1:'+a.port+'/internal/tasks',{method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({id:taskId})})).status;
  const statuses=[await send(id)];f.advance(15*60_000);statuses.push(await send(watch),await send(id),await send(watch),await send(id));
  assert.deepEqual(statuses,[503,503,204,204,204]);assert.equal(business,1);assert.equal(sends,3);
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'failed');assert.equal((await f.store.get<Work>('tasks',id))?.generation,1);
  assert.equal((await f.store.get<Work>('tasks',watch))?.state,'done');
  assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'exhausted');
  assert.equal(f.terminal.length,1);assert.deepEqual(f.notices.map(x=>x.status),['failed','failed','exhausted']);
  assert.doesNotMatch(JSON.stringify([f.terminal,f.notices,await f.store.list('terminal_notices')]),/private-card|private document|xoxb-|TTEST/);
 }finally{if(server?.listening)await new Promise<void>(r=>server!.close(()=>r()));f.close();}
});

test('transient notice recovers on attempt three; duplicate deliveries cannot resend or reconvert',async()=>{
 const f=fixture();try{
  const id=await f.tasks.enqueue('transient',f.spec);let business=0,sends=0;
  const run=runner(async()=>{if(++sends<3)throw await rejection('unable_to_share_files');},()=>{business++;throw permanent();});
  await assert.rejects(f.tasks.execute(id,run));await assert.rejects(f.tasks.execute(id,run));await f.tasks.execute(id,run);
  for(let i=0;i<5;i++)await f.tasks.execute(id,run);
  f.advance(15*60_000);await f.tasks.execute(f.published.find(x=>x.at!==undefined)!.id,run);
  assert.equal(business,1);assert.equal(sends,3);assert.equal(f.terminal.length,1);
  assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
 }finally{f.close();}
});

for(const [name,code] of [['TimeoutError','timeout'],['AbortError','aborted']])test('durable terminal observation preserves normalized native error: '+code,async()=>{
 const f=fixture();try{
  const id=await f.tasks.enqueue('native-'+name,f.spec);
  const run=runner(async()=>{},()=>{throw Object.assign(new Error('private native failure'),{name});});
  await assert.rejects(f.tasks.execute(id,run));await assert.rejects(f.tasks.execute(id,run));await f.tasks.execute(id,run);
  assert.equal(f.terminal.length,1);assert.equal(f.terminal[0].errorCode,code);assert.equal((await f.store.get<Work>('tasks',id))?.failureCode,code);
  await f.tasks.execute(id,run);assert.equal(f.terminal.length,1);
 }finally{f.close();}
});

test('a new failure on the same card retains an independent observation and notice budget',async()=>{
 const f=fixture();try{
  const first=await f.seed('old-generation'),second=await f.seed('new-generation'),run=runner(async()=>{});
  await f.tasks.execute(first,run);await f.tasks.execute(second,run);await f.tasks.execute(first,run);
  assert.equal(f.terminal.length,2);assert.equal(new Set(f.terminal.map(x=>x.taskId)).size,2);
  for(const id of [first,second]){const n=await f.store.get<TerminalNotice>('terminal_notices',id);assert.equal(n?.state,'sent');assert.equal(n?.attempts,1);}
 }finally{f.close();}
});

for(const code of ['message_not_found','cant_update_message','invalid_blocks'])test('trusted permanent notice rejection ends once: '+code,async()=>{
 const f=fixture();try{
  const id=await f.seed(code),error=await rejection(code);let calls=0;
  const run=runner(async()=>{calls++;throw error;});await f.tasks.execute(id,run);await f.tasks.execute(id,run);
  assert.equal(calls,1);const n=await f.store.get<TerminalNotice>('terminal_notices',id);assert.equal(n?.state,'exhausted');assert.equal(n?.diagnostics?.slackError,code);
 }finally{f.close();}
});

test('unknown and forged permanent diagnoses stay bounded transient errors, without leaking strings',async()=>{
 for(const forged of [false,true]){
  const f=fixture();try{
   const id=await f.seed('unknown');let calls=0;
   const error=forged?new TerminalNoticeFailure(Object.assign(new UserError('slack_rejected','xoxb-private'),{slackError:'message_not_found',httpStatus:200})):await rejection('xoxb-private document');
   const run=runner(async()=>{calls++;throw error;});
   await assert.rejects(f.tasks.execute(id,run));await assert.rejects(f.tasks.execute(id,run));await f.tasks.execute(id,run);
   assert.equal(calls,3);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'exhausted');
   assert.doesNotMatch(JSON.stringify([f.notices,await f.store.list('terminal_notices')]),/xoxb-private|message_not_found/);
  }finally{f.close();}
 }
});

test('bookkeeping failure consumes no external attempt and remains retryable after exhaustion',async()=>{
 const f=fixture();try{
  const id=await f.seed();let fail=true,sends=0;
  const base=runner(async()=>{sends++;throw new TerminalNoticeFailure(new Error('network'));});
  const run=async(s:TaskSpec,c:TaskContext)=>{if(c.terminalNotice?.phase==='bookkeeping'&&fail)throw new Error('storage unavailable');await base(s,c);};
  for(let i=0;i<4;i++)await assert.rejects(f.tasks.execute(id,run),/storage unavailable/);
  assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.attempts,0);assert.equal(sends,0);
  fail=false;await assert.rejects(f.tasks.execute(id,run));await assert.rejects(f.tasks.execute(id,run));await f.tasks.execute(id,run);
  fail=true;await assert.rejects(f.tasks.execute(id,run),/storage unavailable/);assert.equal(sends,3);
  fail=false;await f.tasks.execute(id,run);assert.equal(sends,3);
 }finally{f.close();}
});

test('an unimplemented bookkeeping outcome is an internal error, never a successful notice',async()=>{
 const f=fixture();try{
  const id=await f.seed();for(let i=0;i<4;i++)await assert.rejects(f.tasks.execute(id,async()=>{}),/bookkeeping outcome/);
  const n=await f.store.get<TerminalNotice>('terminal_notices',id);assert.equal(n?.attempts,0);assert.equal(n?.state,'pending');
 }finally{f.close();}
});

test('failure persistence precedes claims and survives a lost commit response without business re-execution',async()=>{
 const f=fixture();try{
  let lose=true;const store:MetadataStore={get:f.store.get.bind(f.store),list:f.store.list.bind(f.store),async atomic(kind,key,change){
   const r=await f.store.atomic(kind,key,change);if(kind==='tasks'&&lose&&(await f.store.get<Work>(kind,key))?.state==='failed'){lose=false;throw new Error('commit response lost');}return r;
  }};
  const tasks=f.make(store),id=await tasks.enqueue('lost-failure-response',f.spec);let business=0;
  const run=runner(async()=>{},()=>{business++;throw permanent();});
  await assert.rejects(tasks.execute(id,run),/commit response lost/);assert.equal(f.terminal.length,0);
  await tasks.execute(id,run);assert.equal(business,1);assert.equal(f.terminal.length,1);
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'failed');
 }finally{f.close();}
});

for(const afterCommit of [false,true])test('observation claim fault preserves the documented '+(afterCommit?'after-claim log loss':'before-claim recovery'),async()=>{
 const f=fixture();try{
  const id=await f.seed();let fail=true;
  const store:MetadataStore={get:f.store.get.bind(f.store),list:f.store.list.bind(f.store),async atomic(kind,key,change){
   if(kind==='terminal_observations'&&fail){fail=false;if(afterCommit)await f.store.atomic(kind,key,change);throw new Error('claim fault');}
   return f.store.atomic(kind,key,change);
  }};
  const tasks=f.make(store),run=runner(async()=>{});await assert.rejects(tasks.execute(id,run),/claim fault/);assert.equal(f.terminal.length,0);
  await tasks.execute(id,run);assert.equal(f.terminal.length,afterCommit?0:1);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
 }finally{f.close();}
});

test('after-log crash before notice reservation cannot duplicate terminal output',async()=>{
 const f=fixture();try{
  const id=await f.seed();let fail=true;
  const store:MetadataStore={get:f.store.get.bind(f.store),list:f.store.list.bind(f.store),async atomic(kind,key,change){if(kind==='terminal_notices'&&fail){fail=false;throw new Error('notice reservation lost');}return f.store.atomic(kind,key,change);}};
  const tasks=f.make(store),run=runner(async()=>{});await assert.rejects(tasks.execute(id,run));assert.equal(f.terminal.length,1);
  await tasks.execute(id,run);assert.equal(f.terminal.length,1);
 }finally{f.close();}
});

test('a failing logger is attempted once while durable failure and notice remain independent',async()=>{
 const f=fixture();try{
  const id=await f.seed();let outputs=0;const tasks=f.make(f.store,()=>{outputs++;throw new Error('logger offline');});
  await tasks.execute(id,runner(async()=>{}));await tasks.execute(id,runner(async()=>{}));assert.equal(outputs,1);
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'failed');assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
 }finally{f.close();}
});

test('concurrent original and reverse watchdog delivery share one fenced notice lease',async()=>{
 const f=fixture();try{
  const id=await f.seed();f.advance(15*60_000);const watch=f.published.find(x=>x.at!==undefined)!.id;
  let enter!:()=>void,release!:()=>void,sends=0;const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const run=runner(async()=>{sends++;enter();await gate;});const first=f.tasks.execute(id,run);await started;
  await assert.rejects(f.make().execute(watch,run),TaskBusy);release();await first;await f.tasks.execute(watch,run);
  assert.equal(sends,1);assert.equal(f.terminal.length,1);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.attempts,1);
 }finally{f.close();}
});

test('an expired notice owner cannot mark a replacement delivery sent or change its counter',async()=>{
 const f=fixture();try{
  const id=await f.seed();let enter!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r);
  const old=f.tasks.execute(id,runner(async c=>{enter();await gate;await c.checkpoint();}));await started;
  f.advance(60_001);await f.make().execute(id,runner(async()=>{}));release();await assert.rejects(old,LeaseLost);
  const n=await f.store.get<TerminalNotice>('terminal_notices',id);assert.equal(n?.state,'sent');assert.equal(n?.attempts,2);assert.equal(f.terminal.length,1);
 }finally{f.close();}
});

test('acknowledgement loss after Slack success consumes a reservation and never fabricates sent',async()=>{
 const f=fixture();try{
  const id=await f.seed();let refuse=true,sends=0;
  const store:MetadataStore={get:f.store.get.bind(f.store),list:f.store.list.bind(f.store),atomic<T,R>(kind:string,key:string,change:(c:T|undefined)=>Change<T,R>){return f.store.atomic<T,R>(kind,key,c=>{
   const next=change(c);if(kind==='terminal_notices'&&refuse&&(next.value as TerminalNotice)?.state==='sent')throw new Error('result storage unavailable');return next;
  });}};
  const tasks=f.make(store),run=runner(async()=>{sends++;});await assert.rejects(tasks.execute(id,run),/result storage/);
  assert.notEqual((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
  refuse=false;await tasks.execute(id,run);assert.equal(sends,2);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
 }finally{f.close();}
});

test('three actual child process interruptions cannot bypass the persisted notice reservation limit',async()=>{
 const f=fixture();try{
  const id=await f.seed();
  const source=(name:string)=>JSON.stringify(new URL('../../src/server/'+name,import.meta.url).href);
  const script=`
    import {State} from ${source('state.ts')};
    import {SqliteMetadata} from ${source('cloud/sqlite-metadata.ts')};
    import {DurableTasks} from ${source('cloud/tasks.ts')};
    const now=()=>Number(process.argv[3]);
    const state=new State(process.argv[1],'TTEST'),store=new SqliteMetadata(state,now);
    await new DurableTasks(store,{async publish(){}},now).execute(process.argv[2],async(_s,c)=>{
      if(c.terminalNotice?.phase==='bookkeeping'){c.terminalNotice.result='ready';return;}
      // Kill only this disposable test process after its reservation is durably committed.
      if(c.terminalNotice?.phase==='notice')process.kill(process.pid,'SIGKILL');
      throw new Error('Unexpected business execution');
    });`;
  for(let attempt=1;attempt<=3;attempt++){
   const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script,f.statePath,id,String(f.now())],{encoding:'utf8',timeout:5000});
   assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.error,undefined);
   const notice=await f.store.get<TerminalNotice>('terminal_notices',id);assert.equal(notice?.state,'running');assert.equal(notice?.attempts,attempt);
   f.advance(60_001);
  }
  let sends=0;await f.make().execute(id,runner(async()=>{sends++;}));
  assert.equal(sends,0);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'exhausted');
  assert.equal((await f.store.get<Work>('tasks',id))?.generation,1);assert.equal((await f.store.get<Work>('tasks',id))?.state,'failed');
  assert.ok(await f.store.get('terminal_observations',id));assert.equal(f.terminal.length,0);
 }finally{f.close();}
});

test('exhaustion storage failure stays retryable without another external send',async()=>{
 const f=fixture();try{
  const id=await f.seed();let refuse=true,sends=0;
  const store:MetadataStore={get:f.store.get.bind(f.store),list:f.store.list.bind(f.store),atomic<T,R>(kind:string,key:string,change:(c:T|undefined)=>Change<T,R>){return f.store.atomic<T,R>(kind,key,c=>{
   const next=change(c);if(kind==='terminal_notices'&&refuse&&(next.value as TerminalNotice)?.state==='exhausted')throw new Error('exhaustion storage unavailable');return next;
  });}};
  const tasks=f.make(store),run=runner(async()=>{sends++;throw new TerminalNoticeFailure(new Error('network'));});
  for(let i=0;i<4;i++)await assert.rejects(tasks.execute(id,run));assert.equal(sends,3);
  refuse=false;await tasks.execute(id,run);assert.equal(sends,3);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'exhausted');
 }finally{f.close();}
});

test('failed receipt, observation and notice expire together despite duplicate redeliveries',async()=>{
 const f=fixture();try{
  const id=await f.seed(),run=runner(async()=>{});await f.tasks.execute(id,run);f.advance(6*86400_000);await f.tasks.execute(id,run);
  assert.ok(await f.store.get('terminal_observations',id));f.advance(86400_000+1);
  for(const kind of ['tasks','terminal_observations','terminal_notices'])assert.equal(await f.store.get(kind,id),undefined);
  await assert.rejects(f.tasks.execute(id,run),/Unknown task/);
 }finally{f.close();}
});

test('legacy done/failed receipts receive a stable retention timestamp rather than losing their TTL',async()=>{
 for(const state of ['done','failed'] as const){
  const f=fixture();try{
   const id=await f.tasks.enqueue('legacy-'+state,f.spec);
   await f.store.atomic<Work,void>('tasks',id,c=>({value:{...c!,state,generation:3},expiresAt:f.now()+100,result:undefined}));
   await f.tasks.execute(id,runner(async()=>{}));const terminalAt=(await f.store.get<Work>('tasks',id))?.terminalAt;assert.equal(terminalAt,f.now());
   f.advance(6*86400_000);await f.tasks.reserve('legacy-'+state,f.spec);await f.tasks.execute(id,runner(async()=>{}));assert.equal((await f.store.get<Work>('tasks',id))?.terminalAt,terminalAt);
   f.advance(86400_000+1);assert.equal(await f.store.get<Work>('tasks',id),undefined);
  }finally{f.close();}
 }
});

for(const mode of ['embed','browser'] as const)test('real application preserves partial PDF/images and updates status without sharing in '+mode,async()=>{
 const f=fixture();try{
  const api=new EditorApi(),app=new CloudApplication({...config,reactions:false,editorMode:mode,publicOrigin:'https://synthetic.example.com'},api,f.store,f.tasks,{download:async()=>bytes});
  const cardId=await app.submit({...actor,threadTs:'100.001'},'FTEST','thread:partial-'+mode),prepare=f.published.find(x=>x.at===undefined)!.id;
  await f.tasks.execute(prepare,(s,c)=>app.execute(s,c));const id=f.published.filter(x=>x.at===undefined).at(-1)!.id;
  await f.store.atomic<any,void>('cards',cardId,c=>({value:{...c,pdf:'ready',pdfFileId:'FPDF',pdfUrl:'https://synthetic.example.com/pdf',pdfPreparedAt:100,slackPublishedAt:200,pageCount:12,imageState:'pending',images:[{page:1,fileId:'FIMAGE1',shared:true},{page:2,fileId:'FIMAGE2',shared:false}]},result:undefined}));
  await f.store.atomic<Work,void>('tasks',id,c=>({value:{...c!,state:'failed',generation:3,terminalAt:f.now(),failureCode:'share_pending'},result:undefined}));
  api.calls.length=0;api.handler=async(method,args)=>{if(method==='chat.update')assert.ok(!('file_ids' in args)&&!('metadata' in args));return api.response(method,args);};
  await f.tasks.execute(id,(s,c)=>app.execute(s,c));const card=await f.store.get<any>('cards',cardId);
  assert.equal(card.pdf,'ready');assert.equal(card.pdfFileId,'FPDF');assert.equal(card.pdfPreparedAt,100);assert.equal(card.slackPublishedAt,200);assert.equal(card.imageState,'failed');
  assert.deepEqual(card.images.map((x:any)=>x.shared),[true,false]);
  const updates=api.calls.filter(x=>x.method==='chat.update');assert.equal(updates.length,1);assert.match(JSON.stringify(updates[0].args),/PDF로 보기/);assert.match(JSON.stringify(updates[0].args),/이미지 다시 준비/);
  assert.equal(api.calls.filter(x=>x.method.startsWith('files.')&&x.method!=='files.info').length,0);
  assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
  // A newly authorized manual generation gets a new task; the old delivery must not change it.
  const cardBefore={...card};await app.morePages(cardId,actor,card.messageTs,'new-manual-action');const next=await f.store.get<any>('cards',cardId);
  assert.notEqual(next.recovery.taskId,id);assert.equal(next.pdfFileId,cardBefore.pdfFileId);
  api.calls.length=0;await f.tasks.execute(id,(s,c)=>app.execute(s,c));
  assert.equal((await f.store.get<any>('cards',cardId)).recovery.taskId,next.recovery.taskId);assert.equal(api.calls.length,0);
 }finally{f.close();}
});

test('real application marks missing card skipped and never claims Slack publication',async()=>{
 const f=fixture();try{
  const id=await f.seed(),api=new EditorApi(),app=new CloudApplication({...config,reactions:false},api,f.store,f.tasks);
  await f.tasks.execute(id,(s,c)=>app.execute(s,c));const n=await f.store.get<TerminalNotice>('terminal_notices',id);
  assert.equal(n?.state,'skipped');assert.equal(n?.attempts,0);assert.equal(api.calls.length,0);
 }finally{f.close();}
});

for(const scenario of ['actor-left','bot-left','mode-off','slack-down','metadata-down','post-call-lease-lost','tenant-before','tenant-after'] as const)test('real terminal application boundary: '+scenario,async()=>{
 const f=fixture();try{
  const api=new EditorApi();let breakMetadata=false,breakTenant=false;
  const storage:MetadataStore={get:async<T>(kind:string,key:string)=>{
   if(breakMetadata&&kind==='cards')throw new Error('metadata unavailable');return f.store.get<T>(kind,key);
  },list:f.store.list.bind(f.store),atomic:f.store.atomic.bind(f.store)};
  const rawClient=new HttpSlackApi('xoxb-synthetic',async(url,init)=>{
   const u=new URL(String(url)),method=u.pathname.split('/').at(-1)! as Parameters<EditorApi['call']>[0];
   const args:Record<string,unknown>=Object.fromEntries(init?.body?new URLSearchParams(String(init.body)):u.searchParams);
   for(const key of ['blocks','metadata','file_ids','files'])if(typeof args[key]==='string')args[key]=JSON.parse(args[key] as string);
   return Response.json(await api.call(method,args));
  });
  // Same before/after API boundary as the tenant wrapper; these errors originate outside HttpSlackApi.
  const client:SlackApi={async call(method,args,signal){
   if(breakTenant&&scenario==='tenant-before')throw new Error('installation metadata unavailable');
   const result=await rawClient.call(method,args,signal);
   if(breakTenant&&scenario==='tenant-after')throw new Error('installation metadata unavailable');
   return result;
  }};
  const tasks=f.make(storage),app=new CloudApplication({...config,reactions:false,publicOrigin:'https://synthetic.example.com'},client,storage,tasks,{noticeIdentity:{generation:'fixture-generation',botUserId:'UBOT',check:async()=>{}},download:async()=>bytes});
  const cardId=await app.submit({...actor,threadTs:'100.001'},'FTEST','thread:boundary-'+scenario);
  await tasks.execute(f.published.find(x=>x.at===undefined)!.id,(s,c)=>app.execute(s,c));const id=f.published.filter(x=>x.at===undefined).at(-1)!.id;
  await f.store.atomic<Work,void>('tasks',id,c=>({value:{...c!,state:'failed',generation:3,terminalAt:f.now(),failureCode:'access_denied'},result:undefined}));
  api.calls.length=0;api.handler=async(method,args)=>{
   if(method==='files.info'&&scenario==='slack-down')throw new Error('Slack network unavailable');
   if(method==='conversations.members'&&scenario==='actor-left')return {ok:true,members:[],response_metadata:{next_cursor:''}};
   const result=api.response(method,args);
   if(method==='conversations.info'&&scenario==='bot-left')return {...result,channel:{...(result.channel as object),is_member:false}};
   if(method==='chat.update'&&scenario==='post-call-lease-lost')f.advance(60_001);
   return result;
  };
  if(scenario==='mode-off')await f.store.atomic('channels',actor.channelId,()=>({value:{mode:'off'},result:undefined}));
  if(scenario==='metadata-down')breakMetadata=true;
  if(scenario==='tenant-before'||scenario==='tenant-after')breakTenant=true;
  const run=(s:TaskSpec,c:TaskContext)=>app.execute(s,c);
  if(scenario==='slack-down'){
   await assert.rejects(tasks.execute(id,run));await assert.rejects(tasks.execute(id,run));await tasks.execute(id,run);
   assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'exhausted');
  }else if(scenario==='metadata-down'){
   await assert.rejects(tasks.execute(id,run),/metadata unavailable/);await assert.rejects(tasks.execute(id,run),/metadata unavailable/);
   assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.attempts,0);
   breakMetadata=false;await tasks.execute(id,run);
  }else if(scenario==='tenant-before'||scenario==='tenant-after'){
   await assert.rejects(tasks.execute(id,run),error=>{assert.ok(!(error instanceof TerminalNoticeFailure));assert.match(String(error),/installation metadata/);return true;});
   assert.equal(f.notices.length,0);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'pending');
   breakTenant=false;await tasks.execute(id,run);assert.equal((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
  }else if(scenario==='post-call-lease-lost'){
   await assert.rejects(tasks.execute(id,run),LeaseLost);assert.notEqual((await f.store.get<TerminalNotice>('terminal_notices',id))?.state,'sent');
  }else{
   await tasks.execute(id,run);const notice=await f.store.get<TerminalNotice>('terminal_notices',id);
   assert.equal(notice?.state,scenario==='actor-left'?'sent':'skipped');
   const updates=api.calls.filter(x=>x.method==='chat.update');assert.equal(updates.length,scenario==='actor-left'?1:0);
   if(updates.length)assert.doesNotMatch(JSON.stringify(updates[0].args),/file_ids|metadata|FTEST|https:\/\/|문서.hwp/);
  }
  assert.equal((await f.store.get<Work>('tasks',id))?.state,'failed');assert.equal((await f.store.get<any>('cards',cardId)).pdf,'failed');
 }finally{f.close();}
});
