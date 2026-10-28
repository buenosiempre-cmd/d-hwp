import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {createCloudReceiver} from '../../src/server/cloud/receiver';
import {config,bytes,signed,command} from './support';
import {EditorApi} from './editor-support';
async function start(){
 const dir=mkdtempSync(join(tmpdir(),'rhwp-cloud-http-')),state=new State(join(dir,'state.sqlite'),'TTEST'),store=new SqliteMetadata(state),api=new EditorApi();
 const pending:string[]=[];let fail=false;const tasks=new DurableTasks(store,{async publish(id,notBefore){if(fail)throw new Error('queue down');if(notBefore===undefined)pending.push(id);}});
 const cfg={...config,publicOrigin:'https://cloud.example.com',adminIds:new Set(['UTEST']),reactions:true};
 const application=new CloudApplication(cfg,api,store,tasks,{download:async()=>bytes,fetcher:async()=>new Response('ok'),convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:2,pages:[1,2].map(page=>({page,png:Buffer.from('png')}))})});
 const runtime=createCloudReceiver(cfg,application,{botId:'BBOT',botUserId:'UBOT'}),server=await runtime.receiver.start({host:'127.0.0.1',port:0}),address=server.address();if(!address||typeof address==='string')throw new Error('listen');
 return {api,store,application,runtime,pending,origin:`http://127.0.0.1:${address.port}`,setFailure(v:boolean){fail=v;},async drain(){while(pending.length){await tasks.execute(pending.shift()!,async(spec,ctx)=>{if(spec.kind==='event')await runtime.events.execute(spec,ctx);else await application.execute(spec,ctx);});}},async close(){await runtime.receiver.stop();state.close();rmSync(dir,{recursive:true,force:true});}};
}
const event=(id:string)=>({type:'event_callback',api_app_id:'ATEST',team_id:'TTEST',event_id:id,event:{type:'file_shared',file_id:'FTEST',user_id:'UTEST',channel_id:'CTEST'}});
test('cloud ingress verifies Slack signatures, acknowledges durable handoff and retries failed queue publication',async()=>{
 const f=await start();try{
  assert.equal((await signed(f.origin,event('E1'),{json:true,tamper:true})).status,401);assert.equal(f.pending.length,0);
  f.setFailure(true);assert.equal((await signed(f.origin,event('E1'),{json:true})).status,503);assert.equal(f.pending.length,0);
  f.setFailure(false);assert.equal((await signed(f.origin,event('E1'),{json:true})).status,200);assert.equal(f.pending.length,1);
  await f.drain();assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);
  assert.equal((await signed(f.origin,event('E1'),{json:true})).status,200);await f.drain();assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);
  const cards=await f.store.list<any>('cards');assert.equal(cards[0][1].pdf,'ready');assert.ok(f.api.calls.some(c=>c.method==='reactions.add'&&c.args.name==='white_check_mark'));
 }finally{await f.close();}
});
test('cloud settings survive receiver state, mention policy shares automatic request identity, and no message text is persisted',async()=>{
 const f=await start();try{
  await f.runtime.settings.set({teamId:'TTEST',userId:'UTEST',channelId:'CTEST'},'mention');
  assert.equal((await signed(f.origin,event('E2'),{json:true})).status,200);await f.drain();assert.equal(f.api.messages.size,0);
  const mention={...event('E3'),event:{type:'app_mention',user:'UTEST',channel:'CTEST',ts:'123.456',text:'secret message body'}};
  assert.equal((await signed(f.origin,mention,{json:true})).status,200);await f.drain();assert.equal(f.api.messages.size,1);
  assert.equal(JSON.stringify(await f.store.list('inputs')).includes('secret message body'),false);
  assert.equal((await signed(f.origin,new URLSearchParams(command({text:'help'})))).status,200);
  await f.runtime.settings.set({teamId:'TTEST',userId:'UTEST',channelId:'CTEST'},'off');const card=(await f.store.list<any>('cards'))[0][0];await assert.rejects(f.application.authorize(card,{teamId:'TTEST',userId:'UTEST',channelId:'CTEST'}));
 }finally{await f.close();}
});
test('mention before file_shared yields the single worker slot and retries after the share is observed',async()=>{
 const f=await start();try{
  await f.runtime.settings.set({teamId:'TTEST',userId:'UTEST',channelId:'CTEST'},'mention');
  const mention={...event('ERACE1'),event:{type:'app_mention',user:'UTEST',channel:'CTEST',ts:'123.456'}};
  assert.equal((await signed(f.origin,mention,{json:true})).status,200);
  const retry=f.pending[0];await assert.rejects(f.drain(),/Awaiting file share event/);
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postEphemeral').length,0);
  assert.equal((await signed(f.origin,event('ERACE2'),{json:true})).status,200);await f.drain();
  f.pending.push(retry);await f.drain();assert.equal(f.api.messages.size,1);
 }finally{await f.close();}
});
test('metadata outage during event authorization requests a Slack retry instead of silently dropping the event',async()=>{
 const f=await start();try{
  const get=f.store.get.bind(f.store);f.store.get=async()=>{throw new Error('metadata unavailable');};
  assert.equal((await signed(f.origin,event('ESTORE'),{json:true})).status,503);
  f.store.get=get;assert.equal((await signed(f.origin,event('ESTORE'),{json:true})).status,200);await f.drain();assert.equal(f.api.messages.size,1);
 }finally{await f.close();}
});

test('preview button durably acknowledges before Slack lookups and deduplicates the same signed click',async()=>{
 const f=await start();try{
  await signed(f.origin,event('EBUTTON'),{json:true});await f.drain();
  const [id,card]=(await f.store.list<any>('cards'))[0];
  await f.store.atomic<any,void>('cards',id,c=>({value:{...c,pdf:'failed',imageState:'failed',recovery:{taskId:'old',state:'failed',attempt:3,maxAttempts:3}},result:undefined}));
  const payload={type:'block_actions',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},channel:{id:'CTEST'},container:{type:'message',channel_id:'CTEST',message_ts:card.messageTs},actions:[{type:'button',action_id:'rhwp_retry_preview',value:id,action_ts:'999.001'}]};
  // Any synchronous Slack lookup hangs: the durable acknowledgment must still finish.
  let unblock!:()=>void;const blocked=new Promise<void>(r=>{unblock=r;});let called=false;
  f.api.handler=async(method,args)=>{called=true;await blocked;return f.api.response(method,args);};
  try{
   const response=await signed(f.origin,new URLSearchParams({payload:JSON.stringify(payload)}));
   assert.equal(response.status,200);assert.equal(called,false);assert.equal(f.pending.length,1);
   assert.equal((await signed(f.origin,new URLSearchParams({payload:JSON.stringify(payload)}))).status,200);
   const inputs=await f.store.list<any>('inputs');assert.equal(inputs.filter(([,v])=>v.kind==='retry_preview').length,1);
  }finally{unblock();f.api.handler=undefined;}
  await f.drain();assert.equal((await f.store.get<any>('cards',id)).pdf,'ready');
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postEphemeral').length,0);
  assert.ok(f.api.calls.some(c=>c.method==='chat.update'&&JSON.stringify(c.args).includes('요청을 접수했습니다')));
 }finally{await f.close();}
});

test('preview button queue outage is not acknowledged and worker rejects a forged message before reserving conversion',async()=>{
 const f=await start();try{
  await signed(f.origin,event('EBADBUTTON'),{json:true});await f.drain();
  const [id]=(await f.store.list<any>('cards'))[0];
  const payload={type:'block_actions',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},channel:{id:'CTEST'},container:{type:'message',channel_id:'CTEST',message_ts:'999.999'},actions:[{type:'button',action_id:'rhwp_retry_preview',value:id,action_ts:'999.002'}]};
  const body=new URLSearchParams({payload:JSON.stringify(payload)});
  f.setFailure(true);assert.equal((await signed(f.origin,body)).status,503);
  f.setFailure(false);assert.equal((await signed(f.origin,body)).status,200);
  const before=(await f.store.list('tasks')).length;await f.drain();assert.equal((await f.store.list('tasks')).length,before);
  assert.ok(f.api.calls.some(c=>c.method==='chat.postEphemeral'&&String(c.args.text).includes('접근 권한')));
 }finally{await f.close();}
});

test('first upload before bot join initializes auto; repeated join welcomes once; explicit policies survive',async()=>{
 const f=await start();try{
  await f.store.atomic('settings','initialized',()=>({value:true,result:undefined}));
  assert.equal(await f.application.mode('CTEST'),'off');
  const join={...event('EJOIN45'),event:{type:'member_joined_channel',user:'UBOT',channel:'CTEST',channel_type:'C'}};
  await signed(f.origin,event('EFIRST45'),{json:true});await f.drain();
  assert.equal(await f.application.mode('CTEST'),'auto');assert.equal((await f.store.list('cards')).length,1);
  await signed(f.origin,join,{json:true});await f.drain();
  await signed(f.origin,{...join,event_id:'EJOIN45B'},{json:true});await f.drain();
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage'&&String(c.args.text).startsWith('D-HWP · 이 채널')).length,1);
  for(const mode of ['mention','off'] as const){
   await f.runtime.settings.set({teamId:'TTEST',userId:'UTEST',channelId:'CTEST'},mode);
   await signed(f.origin,{...join,event_id:'EJOIN45'+mode},{json:true});await f.drain();assert.equal(await f.application.mode('CTEST'),mode);
  }
 }finally{await f.close();}
});
test('own bot join initializes channel; ordinary members and inaccessible channels do not',async()=>{
 const f=await start();try{
  await f.store.atomic('settings','initialized',()=>({value:true,result:undefined}));
  const join={...event('EJOIN46'),event:{type:'member_joined_channel',user:'UOTHER',channel:'CTEST',channel_type:'C'}};
  await signed(f.origin,join,{json:true});await f.drain();assert.equal(await f.application.mode('CTEST'),'off');
  const original=f.api.response.bind(f.api);
  f.api.handler=async(method,args)=>method==='conversations.info'?{ok:true,channel:{...(original(method,args).channel as object),is_member:false}}:original(method,args);
  await signed(f.origin,{...join,event_id:'EJOIN46B',event:{...join.event,user:'UBOT'}},{json:true});await f.drain();assert.equal(await f.application.mode('CTEST'),'off');
  f.api.handler=undefined;
  await signed(f.origin,{...join,event_id:'EJOIN46C',event:{...join.event,user:'UBOT'}},{json:true});await f.drain();assert.equal(await f.application.mode('CTEST'),'auto');
 }finally{await f.close();}
});
test('bare D-HWP shows conversion help; settings remains explicit and admin-only',async()=>{
 const f=await start();try{
  const help=await signed(f.origin,new URLSearchParams(command({command:'/dhwp',text:''})));
  assert.match(await help.text(),/Markdown/);
  assert.equal(f.api.calls.filter(c=>c.method==='views.open').length,0);
  await signed(f.origin,new URLSearchParams(command({text:'settings',channel_id:'CNEW'})));
  assert.equal(f.api.calls.filter(c=>c.method==='views.open').length,1);
  await signed(f.origin,new URLSearchParams(command({text:'settings',user_id:'UOTHER'})));
  assert.equal(f.api.calls.filter(c=>c.method==='views.open').length,1);
 }finally{await f.close();}
});
