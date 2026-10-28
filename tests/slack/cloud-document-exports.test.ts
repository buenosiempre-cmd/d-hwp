import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents} from '../../src/server/cloud/events';
import {createCloudReceiver} from '../../src/server/cloud/receiver';
import {exportKey,type ExportRequest} from '../../src/server/document-exports';
import {errorCode,traceTask,measured} from '../../src/server/cloud/telemetry';
import {userMessage} from '../../src/server/errors';
import {isPermanentConversionFailure} from '../../src/conversion/failures.mjs';
import {EditorApi} from './editor-support';
import {actor,config,bytes,signed} from './support';

const text=Buffer.from('합성 문서 본문\n표 셀 내용\n');
const zip=Buffer.from('PK\x03\x04synthetic selected page archive');
type Options=NonNullable<ConstructorParameters<typeof CloudApplication>[4]>;
const allocations=(api:EditorApi)=>api.calls.filter(c=>c.method==='files.getUploadURLExternal'&&/\.(txt|zip)$/.test(String(c.args.filename)));
const exportFile=(api:EditorApi,id:unknown)=>/\.(txt|zip)$/.test(String(api.files.get(String(id))?.name));
const completions=(api:EditorApi)=>api.calls.filter(c=>c.method==='files.completeUploadExternal'&&exportFile(api,(c.args.files as {id:string}[])[0].id));
function fixture(){
 const state=new State(':memory:','TTEST'),store=new SqliteMetadata(state),api=new EditorApi(),pending:string[]=[];
 let failQueue=false,textCalls=0,zipCalls=0;const streamed:Buffer[]=[];
 const tasks=new DurableTasks(store,{async publish(id,notBefore){if(failQueue)throw new Error('synthetic queue outage');if(notBefore===undefined)pending.push(id);}});
 const cfg={...config,publicOrigin:'https://cloud.example.com'};
 const make=(options:Options={})=>new CloudApplication(cfg,api,store,tasks,{download:async()=>bytes,fetcher:async(_url,init)=>{streamed.push(Buffer.from(init!.body as Uint8Array));return new Response('ok');},convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:25,pages:[1,2,3].map(page=>({page,png:Buffer.from('png')}))}),text:async()=>{textCalls++;return text;},zip:async(_bytes,options)=>{zipCalls++;return {pageCount:25,pages:[...options.pages],zip};},...options});
 return {api,store,tasks,make,cfg,pending,streamed,get textCalls(){return textCalls;},get zipCalls(){return zipCalls;},setFailure(value:boolean){failQueue=value;},async drain(application=make()){
  const events=new CloudEvents(application,'UBOT');
  while(pending.length)await tasks.execute(pending.shift()!,async(spec,context)=>{if(spec.kind==='event')await events.execute(spec,context);else await application.execute(spec,context);},(spec,context)=>events.terminal(spec,context));
 },async prepare(){const app=make(),id=await app.submit({...actor,threadTs:'100.001'},'FTEST','exports-test');await this.drain(app);return {id,card:await app.authorize(id,actor)};},close(){state.close();}};
}

test('Cloud TXT and canonical selected-page ZIP persist independent receipts and reuse them across workers',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();
  const txt=await f.make().exportFile(id,actor,card.messageTs!,{format:'txt'});
  const zipped=await f.make().exportFile(id,actor,card.messageTs!,{format:'zip',pages:[15,3,15,2]});
  assert.equal((await f.make().exportFile(id,actor,card.messageTs!,{format:'zip',pages:[2,3,15]})).id,zipped.id);
  assert.equal((await f.make().exportFile(id,actor,card.messageTs!,{format:'txt'})).id,txt.id);
  assert.equal(f.textCalls,1);assert.equal(f.zipCalls,1);assert.equal(allocations(f.api).length,2);
  assert.ok(f.streamed.some(value=>value.equals(text)));assert.ok(f.streamed.some(value=>value.equals(zip)));
  for(const call of completions(f.api)){assert.equal(call.args.channel_id,'CTEST');assert.equal(call.args.thread_ts,'100.001');}
  const saved=await f.make().authorize(id,actor);assert.deepEqual(saved.images,card.images);
  assert.deepEqual(saved.exports?.['zip:2,3,15'].request,{format:'zip',pages:[2,3,15]});
  assert.equal(saved.exports?.txt.attempt?.saved,true);
  const json=JSON.stringify(await f.store.list('cards'));assert.ok(!json.includes('/upload/v1/'));assert.ok(!json.includes(text.toString()));assert.ok(!json.includes(zip.toString()));
 }finally{f.close();}
});

test('Cloud exports reject forged actor/message and revoked cached-receipt access before publication',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();
  for(const who of [{...actor,teamId:'TOTHER'},{...actor,userId:'UOTHER'},{...actor,channelId:'CPRIVATE'}])await assert.rejects(f.make().exportFile(id,who,card.messageTs!,{format:'txt'}));
  await assert.rejects(f.make().exportFile(id,actor,'999.001',{format:'txt'}));assert.equal(f.textCalls,0);
  await f.make().exportFile(id,actor,card.messageTs!,{format:'txt'});
  f.api.handler=async(method,args)=>method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:f.api.response(method,args);
  await assert.rejects(f.make().exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'access_denied'});
  assert.equal(allocations(f.api).length,1);
 }finally{f.close();}
});

for(const emptyReceipt of [false,true])test(`Cloud migrated card binds its first export hash before conversion (${emptyReceipt?'empty receipt':'new receipt'})`,async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();
  await f.store.atomic<any,void>('cards',id,current=>({value:{...current,contentHash:undefined,exports:emptyReceipt?{txt:{request:{format:'txt'}}}:undefined},result:undefined}));
  const expected=createHash('sha256').update(bytes).digest('hex');let converted=0;
  const app=f.make({text:async()=>{converted++;assert.equal((await f.store.get<any>('cards',id)).contentHash,expected);return text;}});
  await app.exportFile(id,actor,card.messageTs!,{format:'txt'});
  assert.equal((await f.store.get<any>('cards',id)).contentHash,expected);
  const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
  await assert.rejects(f.make({download:async()=>changed,text:async()=>{converted++;return text;}}).exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'source_changed'});
  assert.equal(converted,1);assert.equal(allocations(f.api).length,1);
 }finally{f.close();}
});

test('Cloud hashless allocated receipts fail closed even when a different export is requested',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();
  for(const prior of [{request:{format:'txt'},attempt:{fileId:'FOLDER',streamed:true}},{request:{format:'txt'},fileId:'FOLDER',attempt:{fileId:'FOLDER',saved:true}}]){
   await f.store.atomic<any,void>('cards',id,current=>({value:{...current,contentHash:undefined,exports:{txt:prior}},result:undefined}));
   for(const request of [{format:'txt'},{format:'zip',pages:[1]}] as ExportRequest[])await assert.rejects(f.make().exportFile(id,actor,card.messageTs!,request),{code:'source_changed'});
   assert.equal((await f.store.get<any>('cards',id)).contentHash,undefined);
  }
  assert.equal(f.textCalls,0);assert.equal(f.zipCalls,0);assert.equal(allocations(f.api).length,0);
 }finally{f.close();}
});

for(const scenario of ['membership','same-size source','before sharing'] as const)test(`Cloud export rechecks ${scenario} after conversion or transfer`,async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();let changed=false;
  f.api.handler=async(method,args)=>changed&&scenario!=='same-size source'&&method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:f.api.response(method,args);
  const app=f.make({download:async()=>{if(changed&&scenario==='same-size source'){const next=Buffer.from(bytes);next[next.length-1]^=1;return next;}return bytes;},text:async()=>{if(scenario!=='before sharing')changed=true;return text;},fetcher:async()=>{changed=true;return new Response('ok');}});
  await assert.rejects(app.exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:scenario==='same-size source'?'source_changed':'access_denied'});
  assert.equal(completions(f.api).length,0);assert.equal(allocations(f.api).length,scenario==='before sharing'?1:0);
 }finally{f.close();}
});

test('Cloud exports validate converter pages/count/bytes and release failed selection slots',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare(),request:ExportRequest={format:'zip',pages:[2,15]};
  for(const result of [{pageCount:25,pages:[2],zip},{pageCount:10,pages:[2,15],zip},{pageCount:26,pages:[2,15],zip},{pageCount:25,pages:[15,2],zip},{pageCount:201,pages:[2,15],zip},{pageCount:25,pages:[2,15],zip:Buffer.alloc(0)},{pageCount:25,pages:[2,15],zip:Buffer.alloc(32)}])await assert.rejects(f.make({zip:async()=>result}).exportFile(id,actor,card.messageTs!,request),{code:'export_output'});
  await assert.rejects(f.make({text:async()=>Buffer.alloc(2*1024*1024+1)}).exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'export_output'});
  await assert.rejects(f.make({text:async()=>Buffer.from([0xff,0xfe])}).exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'export_output'});
  await assert.rejects(f.make({zip:async()=>{assert.fail('Out-of-range pages must not start conversion');}}).exportFile(id,actor,card.messageTs!,{format:'zip',pages:[26]}),{code:'export_selection'});
  assert.equal(allocations(f.api).length,0);assert.deepEqual((await f.make().authorize(id,actor)).exports,{});
  await f.make().exportFile(id,actor,card.messageTs!,request);assert.equal(allocations(f.api).length,1);
 }finally{f.close();}
});

test('Cloud keeps at most 20 distinct receipts while existing canonical selections still work',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();
  for(let page=1;page<=20;page++)await f.make().exportFile(id,actor,card.messageTs!,{format:'zip',pages:[page]});
  await assert.rejects(f.make().exportFile(id,actor,card.messageTs!,{format:'zip',pages:[21]}),{code:'export_limit'});
  await f.make().exportFile(id,actor,card.messageTs!,{format:'zip',pages:[1,1]});
  assert.equal(allocations(f.api).length,20);assert.equal(Object.keys((await f.make().authorize(id,actor)).exports??{}).length,20);
 }finally{f.close();}
});

test('Cloud lost completion response recovers the same uploaded ZIP after a worker replacement',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();let visible=false;
  f.api.handler=async(method,args)=>{
   const response=f.api.response(method,args);
   if(method==='files.completeUploadExternal'&&exportFile(f.api,(args.files as {id:string}[])[0].id))throw new Error('synthetic lost completion');
   if(method==='files.info'&&exportFile(f.api,args.file)&&!visible)return {...response,file:{...response.file as object,shares:{}}};
   return response;
  };
  const request:ExportRequest={format:'zip',pages:[12,15]};
  await assert.rejects(f.make().exportFile(id,actor,card.messageTs!,request),{code:'upload_uncertain'});
  const pending=(await f.make().authorize(id,actor)).exports![exportKey(request)];
  assert.ok(pending.attempt?.fileId);assert.equal(pending.attempt.streamed,true);assert.equal(pending.attempt.completing,true);assert.equal(pending.attempt.url,undefined);
  const transmitted=f.streamed.length;visible=true;
  const result=await f.make().exportFile(id,actor,card.messageTs!,request);
  assert.equal(result.id,pending.attempt.fileId);assert.equal(allocations(f.api).length,1);assert.equal(completions(f.api).length,1);assert.equal(f.streamed.length,transmitted);
  assert.equal((await f.make().exportFile(id,actor,card.messageTs!,request)).id,result.id);assert.equal(f.zipCalls,2);
 }finally{f.close();}
});

test('Cloud card lease prevents concurrent duplicate exports and permits safe retry',async()=>{
 const f=fixture();try{
  const {id,card}=await f.prepare();let release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;}),wait=new Promise<void>(resolve=>{release=resolve;});
  const first=f.make({text:async()=>{started();await wait;return text;}}).exportFile(id,actor,card.messageTs!,{format:'txt'});
  await ready;
  await assert.rejects(f.make().exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'task_busy'});
  release();const receipt=await first;
  assert.equal((await f.make().exportFile(id,actor,card.messageTs!,{format:'txt'})).id,receipt.id);assert.equal(allocations(f.api).length,1);
 }finally{f.close();}
});

async function httpFixture(){
 const f=fixture(),prepared=await f.prepare();
 const app=f.make(),runtime=createCloudReceiver(f.cfg,app,{botId:'BBOT',botUserId:'UBOT'}),server=await runtime.receiver.start({host:'127.0.0.1',port:0});
 const address=server.address();if(!address||typeof address==='string')throw new Error('listen');const origin=`http://127.0.0.1:${address.port}`;
 const action={type:'block_actions',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},trigger_id:'123.456.synthetic',channel:{id:'CTEST'},container:{type:'message',channel_id:'CTEST',message_ts:prepared.card.messageTs},actions:[{type:'button',action_id:'rhwp_export_options',value:prepared.id,action_ts:'999.001'}]};
 const open=async()=>{assert.equal((await signed(origin,action)).status,200);return (f.api.calls.filter(c=>c.method==='views.open').at(-1)!.args.view as any).private_metadata as string;};
 const submission=(id:string,format='zip',pages='15,2-3')=>({type:'view_submission',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},view:{id:'VEXPORT',hash:'synthetic',callback_id:'rhwp_export_document',private_metadata:id,state:{values:{format:{value:{selected_option:{value:format}}},pages:{value:{value:pages}}}}}});
 return {...f,...prepared,runtime,origin,action,open,submission,async closeHttp(){await runtime.receiver.stop();f.close();}};
}

test('Cloud modal authorizes its message, binds its user and durably queues exactly one canonical export before ack',async()=>{
 const f=await httpFixture();try{
  const selection=await f.open();assert.equal(allocations(f.api).length,0);
  const body=f.submission(selection);f.setFailure(true);
  assert.equal((await signed(f.origin,body)).status,503);assert.equal(f.pending.length,0);
  f.setFailure(false);assert.equal((await signed(f.origin,body)).status,200);
  assert.equal((await signed(f.origin,body)).status,200);
  const inputs=(await f.store.list<any>('inputs')).filter(([,input])=>input.kind==='export_file');assert.equal(inputs.length,1);
  assert.deepEqual(inputs[0][1].request,{format:'zip',pages:[2,3,15]});assert.equal(inputs[0][1].terminalNoticeRequested,true);
  const changed=await signed(f.origin,f.submission(selection,'txt'));assert.match(await changed.text(),/errors/);
  await f.drain();assert.equal(allocations(f.api).length,1);
  assert.ok(f.api.calls.some(call=>call.method==='chat.postEphemeral'&&String(call.args.text).includes('선택 쪽 PNG ZIP')));
 }finally{await f.closeHttp();}
});

test('Cloud modal denies foreign users, expired selections, forged messages and invalid pages without queued work',async()=>{
 const f=await httpFixture();try{
  const selection=await f.open(),foreign={...f.submission(selection),user:{id:'UOTHER'}};
  assert.match(await (await signed(f.origin,foreign)).text(),/errors/);
  assert.match(await (await signed(f.origin,f.submission(selection,'zip','1-11'))).text(),/errors/);
  const before=f.api.calls.filter(c=>c.method==='views.open').length;
  await signed(f.origin,{...f.action,container:{...f.action.container,message_ts:'999.999'}});
  await signed(f.origin,{...f.action,channel:{id:'COTHER'}});
  assert.equal(f.api.calls.filter(c=>c.method==='views.open').length,before);
  await f.store.atomic<any,void>('export_selections',selection,current=>({value:{...current,expiresAt:Date.now()-1},result:undefined}));
  assert.match(await (await signed(f.origin,f.submission(selection))).text(),/errors/);
  assert.equal((await f.store.list('inputs')).length,0);assert.equal(allocations(f.api).length,0);
 }finally{await f.closeHttp();}
});

test('Cloud export worker reauthorizes queued selections and terminal conversion errors have safe specific notices',async()=>{
 const f=await httpFixture();try{
  const selection=await f.open();await signed(f.origin,f.submission(selection,'txt'));
  await f.drain(f.make({text:async()=>{throw Object.assign(new Error('PRIVATE SYNTHETIC DATA'),{code:'conversion_text_empty'});}}));
  assert.equal(allocations(f.api).length,0);
  assert.ok(f.api.calls.some(call=>call.method==='chat.postEphemeral'&&String(call.args.text).includes('추출할 텍스트가 없습니다')));
  assert.ok(!JSON.stringify(f.api.calls).includes('PRIVATE SYNTHETIC DATA'));
  const next=await f.open();await signed(f.origin,f.submission(next,'txt'));
  f.api.handler=async(method,args)=>method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:f.api.response(method,args);
  await f.drain();assert.equal(allocations(f.api).length,0);
 }finally{await f.closeHttp();}
});

test('TXT, ZIP and page-selection failures stay permanent and classified without leaking exception text',async()=>{
 for(const code of ['conversion_page_selection','conversion_text_limit','conversion_text_empty','conversion_zip_limit']){
  const error=Object.assign(new Error('PRIVATE SYNTHETIC DATA'),{code});assert.equal(errorCode(error),code);assert.equal(isPermanentConversionFailure(code),true);
  assert.ok(!userMessage(error).includes('PRIVATE'));assert.notEqual(userMessage(error),userMessage(new Error()));
  const rows:Record<string,unknown>[]=[];
  await assert.rejects(traceTask({teamId:'TTEST',cardId:'synthetic',kind:'event'},{signal:new AbortController().signal,checkpoint:async()=>{}},()=>measured('conversion',async()=>{throw error;}),row=>rows.push(row)));
  assert.equal(rows.find(row=>row.event==='task_finished')?.errorCode,code);assert.ok(!JSON.stringify(rows).includes('PRIVATE SYNTHETIC DATA'));
 }
});
