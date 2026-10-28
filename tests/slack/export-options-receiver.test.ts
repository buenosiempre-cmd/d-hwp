import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {editorServer,EditorApi} from './editor-support';
import {actor,signed} from './support';

type Server=Awaited<ReturnType<typeof editorServer>>;
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('Expected export result');}
async function responseAction(response:Response){return (await response.json() as {response_action?:string}).response_action;}
let sequence=0;
function action(id:string,messageTs:string,overrides:Record<string,unknown>={}){
  return {type:'block_actions',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},channel:{id:'CTEST'},trigger_id:`${++sequence}.321.synthetic`,
    container:{type:'message',channel_id:'CTEST',message_ts:messageTs},actions:[{type:'button',action_id:'rhwp_export_options',value:id}],...overrides};
}
function submission(id:string,format='txt',pages:unknown='1',overrides:Record<string,unknown>={}){
  return {type:'view_submission',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},view:{id:'VEXPORT',callback_id:'rhwp_export_document',private_metadata:id,
    state:{values:{format:{value:{type:'static_select',selected_option:{value:format}}},pages:{value:{type:'plain_text_input',value:pages}}}}},...overrides};
}
async function open(server:Server,id:string){
  const card=await server.documents!.authorize(id,actor),previous=server.api.calls.filter(c=>c.method==='views.open').length;
  await signed(server.origin,action(id,card.messageTs!));await until(()=>server.api.calls.filter(c=>c.method==='views.open').length>previous);
  return server.api.calls.filter(c=>c.method==='views.open').at(-1)!.args.view as {private_metadata:string;callback_id:string;blocks:any[]};
}
const exports=(server:Server,extension:string)=>server.api.calls.filter(c=>c.method==='files.getUploadURLExternal'&&String(c.args.filename).endsWith(extension));

test('signed export modal uploads actual TXT to the source thread and repeated selections reuse its receipt',async()=>{
  const text=Buffer.from('동국대학교 합성 문서\n원문 본문\n');let conversions=0;const sent:Buffer[]=[];
  const server=await editorServer({text:async()=>{conversions++;return text;},fetcher:async(_url,init)=>{sent.push(Buffer.from(init!.body as Uint8Array));return new Response('ok');}});
  try{
    const id=await server.prepare(),view=await open(server,id);assert.equal(view.callback_id,'rhwp_export_document');assert.equal(JSON.stringify(view).includes('원문 본문'),false);
    const result=await signed(server.origin,submission(view.private_metadata,'txt','malformed,999'));assert.equal(result.status,200);assert.equal(await result.text(),'');
    await until(()=>server.api.calls.some(c=>c.method==='chat.postEphemeral'&&String(c.args.text).includes('원문 TXT 열기')));
    assert.equal(conversions,1);assert.equal(exports(server,'.txt').length,1);assert.ok(sent.some(b=>b.equals(text)));
    const card=await server.documents!.authorize(id,actor),completion=server.api.calls.find(c=>c.method==='files.completeUploadExternal'&&c.args.channel_id);
    assert.equal(completion?.args.channel_id,'CTEST');assert.equal(completion?.args.thread_ts,card.messageTs);
    const repeat=await open(server,id),before=server.api.calls.filter(c=>c.method==='chat.postEphemeral').length;
    await signed(server.origin,submission(repeat.private_metadata));await until(()=>server.api.calls.filter(c=>c.method==='chat.postEphemeral').length>before);
    assert.equal(conversions,1);assert.equal(exports(server,'.txt').length,1);
    const replay=await signed(server.origin,submission(repeat.private_metadata));assert.equal(await responseAction(replay),'errors');assert.equal(conversions,1);
  }finally{await server.stop();}
});

test('ZIP modal normalizes noncontiguous pages including page 12 without changing the preview gallery',async()=>{
  const requested:number[][]=[],zip=Buffer.alloc(30);zip.writeUInt32LE(0x04034b50);
  const server=await editorServer({convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:12,pages:[]}),zip:async(_bytes,options)=>{requested.push([...options.pages]);return {zip,pageCount:12,pages:[...options.pages]};}});
  try{
    const id=await server.prepare();await until(()=>server.api.calls.some(c=>c.method==='chat.update'&&JSON.stringify(c.args).includes('12페이지')));
    const view=await open(server,id);assert.equal(view.blocks.find(b=>b.block_id==='pages').element.initial_value,'1-10');
    const bad=await signed(server.origin,submission(view.private_metadata,'zip','1-11'));assert.equal(await responseAction(bad),'errors');assert.equal(requested.length,0);
    await signed(server.origin,submission(view.private_metadata,'zip','12,3-5,1,3'));
    await until(()=>server.api.calls.some(c=>c.method==='chat.postEphemeral'&&String(c.args.text).includes('PNG ZIP 열기')));
    assert.deepEqual(requested,[[1,3,4,5,12]]);assert.equal(exports(server,'.zip').length,1);
    const card=await server.documents!.authorize(id,actor);assert.deepEqual(card.images??[],[]);
  }finally{await server.stop();}
});

test('export button rejects a mismatched channel or message and a revoked source before opening a modal',async()=>{
  const api=new EditorApi(),server=await editorServer({api});
  try{
    const id=await server.prepare(),card=await server.documents!.authorize(id,actor);
    await signed(server.origin,action(id,'999.999'));
    await signed(server.origin,action(id,card.messageTs!,{channel:{id:'CPRIVATE'}}));
    await until(()=>api.calls.filter(c=>c.method==='chat.postEphemeral').length===2);assert.equal(api.calls.some(c=>c.method==='views.open'),false);
    api.handler=async(method,args)=>method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:api.response(method,args);
    await signed(server.origin,action(id,card.messageTs!));await until(()=>api.calls.filter(c=>c.method==='chat.postEphemeral').length===3);
    assert.equal(api.calls.some(c=>c.method==='views.open'),false);
  }finally{await server.stop();}
});

test('signed modal submissions cannot change the bound user, workspace or expired selection',async()=>{
  let now=100,conversions=0;const server=await editorServer({now:()=>now,text:async()=>{conversions++;return Buffer.from('text');}});
  try{
    const id=await server.prepare(),view=await open(server,id);
    const other=await signed(server.origin,submission(view.private_metadata,'txt','1',{user:{id:'UOTHER'}}));assert.equal(await responseAction(other),'errors');
    await signed(server.origin,submission(view.private_metadata,'txt','1',{team:{id:'TOTHER'}}));await delay(10);assert.equal(conversions,0);
    const malformed=submission(view.private_metadata);const broken=await signed(server.origin,{...malformed,view:{...malformed.view,state:{}}});assert.equal(await responseAction(broken),'errors');
    const forged=await signed(server.origin,submission('unknown-selection'));assert.equal(await responseAction(forged),'errors');
    now+=5*60_000;const expired=await signed(server.origin,submission(view.private_metadata));assert.equal(await responseAction(expired),'errors');assert.equal(conversions,0);assert.equal(exports(server,'.txt').length,0);
  }finally{await server.stop();}
});

test('source revocation after a TXT upload suppresses the result link notice',async()=>{
  const api=new EditorApi();let revoked=false;
  const server=await editorServer({api,text:async()=>Buffer.from('synthetic text')});
  try{
    const id=await server.prepare(),view=await open(server,id);
    api.handler=async(method,args)=>{
      if(revoked&&method==='conversations.members')return {ok:true,members:[],response_metadata:{next_cursor:''}};
      const result=api.response(method,args);
      if(method==='files.completeUploadExternal'&&args.channel_id){const fileId=(args.files as {id:string}[])[0].id;if(String(api.files.get(fileId)?.name).endsWith('.txt'))revoked=true;}
      return result;
    };
    await signed(server.origin,submission(view.private_metadata));await until(()=>api.calls.some(c=>c.method==='chat.postEphemeral'));
    assert.equal(revoked,true);assert.equal(exports(server,'.txt').length,1);
    const notices=api.calls.filter(c=>c.method==='chat.postEphemeral').map(c=>String(c.args.text));assert.ok(notices.every(text=>!text.includes('TXT 열기')&&!text.includes('slack.com/files')));assert.match(notices.join('\n'),/접근 권한/);
  }finally{await server.stop();}
});
