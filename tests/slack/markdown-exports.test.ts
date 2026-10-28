import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents} from '../../src/server/cloud/events';
import {readArchive,writeArchive} from '../../src/conversion/archive.mjs';
import type {Card} from '../../src/server/documents';
import {EditorApi,editorServer} from './editor-support';
import {actor,config,bytes,signed,command} from './support';

async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('Expected result');}
const markdown=Buffer.from('# 동국 문서\n\n합성 테스트 본문\n');
const report={schemaVersion:1};
const zip=writeArchive([{name:'document.md',bytes:markdown},{name:'report.json',bytes:Buffer.from(JSON.stringify(report))},{name:'source/original.hwp',bytes}]);
const markdownPackage={markdown,zip,report};
const mdUploads=(api:EditorApi)=>api.calls.filter(c=>c.method==='files.getUploadURLExternal'&&String(c.args.filename).endsWith('_Markdown.zip'));
const legacyReceipt={markdownFileId:'FLEGACY',markdownUrl:'https://rhwp-test.slack.com/files/UBOT/FLEGACY/document.md',markdownAttempt:{fileId:'FLEGACY',streamed:true,saved:true}};

test('D-HWP command and signed Markdown action share actual content in the source thread exactly once',async()=>{
  let conversions=0;const sent:Uint8Array[]=[];
  const server=await editorServer({markdown:async()=>{conversions++;return markdownPackage;},fetcher:async(_url,init)=>{sent.push(new Uint8Array(init!.body as Uint8Array));return new Response('ok');}});
  try{
    const help=await signed(server.origin,new URLSearchParams(command({command:'/dhwp',text:''})));assert.match(await help.text(),/Markdown/);
    assert.equal(server.api.calls.some(c=>c.method==='views.open'),false);
    const response=await signed(server.origin,new URLSearchParams(command({command:'/dhwp',text:'md https://rhwp-test.slack.com/files/UTEST/FTEST/document.hwp'})));
    assert.equal(response.status,200);await server.preparations.idle();
    assert.equal(mdUploads(server.api).length,1);assert.equal(conversions,1);
    assert.equal(mdUploads(server.api)[0].args.filename,'문서_Markdown.zip');
    const uploaded=sent.find(b=>Buffer.from(b).equals(zip));assert.ok(uploaded);
    const entries=readArchive(uploaded);assert.deepEqual([...entries.keys()],['document.md','report.json','source/original.hwp']);
    assert.deepEqual(entries.get('document.md'),markdown);assert.deepEqual(entries.get('source/original.hwp'),bytes);
    assert.deepEqual(JSON.parse(entries.get('report.json')!.toString('utf8')),report);
    const cardMessage=server.api.calls.find(c=>c.method==='chat.postMessage')!;
    const id=(cardMessage.args.metadata as any).entities[0].external_ref.id;
    const card=await server.documents!.authorize(id,actor);
    assert.equal(card.exports?.['markdown-v3']?.attempt?.saved,true);assert.equal(card.markdownFileId,undefined);
    const payload={type:'block_actions',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},channel:{id:'CTEST'},container:{type:'message',channel_id:'CTEST',message_ts:card.messageTs},actions:[{type:'button',action_id:'rhwp_export_markdown',value:id,action_ts:'888.001'}]};
    await signed(server.origin,payload);await until(()=>server.api.calls.some(c=>c.method==='chat.postEphemeral'&&String(c.args.text).includes('Markdown')));
    assert.equal(mdUploads(server.api).length,1);assert.equal(conversions,1);
    const completion=server.api.calls.find(c=>c.method==='files.completeUploadExternal'&&c.args.channel_id);
    assert.equal(completion?.args.thread_ts,card.messageTs);
  }finally{await server.stop();}
});

test('local Markdown denies wrong message/channel and revocation during conversion before any Markdown upload',async()=>{
  const api=new EditorApi();let revoked=false,conversions=0;
  const server=await editorServer({api,markdown:async()=>{conversions++;revoked=true;return markdownPackage;}});
  try{
    const id=await server.prepare();
    const card=await server.documents!.authorize(id,actor);
    await assert.rejects(server.documents!.exportMarkdown(id,{...actor,channelId:'CPRIVATE'},card.messageTs!));
    await assert.rejects(server.documents!.exportMarkdown(id,actor,'999.999'));assert.equal(conversions,0);
    api.handler=async(method,args)=>revoked&&method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:api.response(method,args);
    await assert.rejects(server.documents!.exportMarkdown(id,actor,card.messageTs!),{code:'access_denied'});
    assert.equal(mdUploads(api).length,0);
  }finally{await server.stop();}
});

function cloudFixture(){
  const state=new State(':memory:','TTEST'),store=new SqliteMetadata(state),api=new EditorApi(),pending:string[]=[];
  const tasks=new DurableTasks(store,{async publish(id,notBefore){if(notBefore===undefined)pending.push(id);}});
  let conversions=0,revoked=false;
  const make=()=>new CloudApplication({...config,publicOrigin:'https://cloud.example.com'},api,store,tasks,{download:async()=>bytes,fetcher:async()=>new Response('ok'),markdown:async()=>{conversions++;return markdownPackage;},convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:12,pages:[1,2,3].map(page=>({page,png:Buffer.from('png')}))}),images:async(_b,opts)=>({pageCount:12,pages:Array.from({length:opts!.end!-opts!.start!+1},(_,i)=>({page:i+opts!.start!,png:Buffer.from('png')}))})});
  api.handler=async(method,args)=>revoked&&method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:api.response(method,args);
  return {api,store,tasks,make,get conversions(){return conversions;},revoke(){revoked=true;},async drain(){while(pending.length){const app=make();await tasks.execute(pending.shift()!,(s,c)=>s.kind==='event'?new CloudEvents(app,'UBOT').execute(s,c):app.execute(s,c));}},close(){state.close();}};
}

test('Cloud Markdown command persists its mode and receipt across workers without content or signed upload URLs',async()=>{
  const f=cloudFixture();try{
    const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','md-command','markdown');await f.drain();
    const card=await f.make().authorize(id,actor);assert.ok(card.exports?.['markdown-v3']?.fileId);assert.equal(card.exports?.['markdown-v3']?.attempt?.saved,true);assert.equal(card.markdownFileId,undefined);assert.equal(f.conversions,1);
    await f.make().exportMarkdown(id,actor,card.messageTs!);assert.equal(f.conversions,1);assert.equal(mdUploads(f.api).length,1);
    const completion=f.api.calls.find(c=>c.method==='files.completeUploadExternal'&&c.args.channel_id);assert.equal(completion?.args.thread_ts,'100.001');
    const persisted=JSON.stringify(await f.store.list('cards'));assert.equal(persisted.includes('/upload/v1/'),false);assert.equal(persisted.includes('합성 테스트 본문'),false);
    f.revoke();await assert.rejects(f.make().exportMarkdown(id,actor,card.messageTs!));assert.equal(mdUploads(f.api).length,1);
  }finally{f.close();}
});

test('local Markdown creates a versioned ZIP instead of reusing a legacy text-only receipt',async()=>{
  let conversions=0;const server=await editorServer({markdown:async()=>{conversions++;return markdownPackage;}});
  try{
    const id=await server.prepare();await server.documents!.pdf.idle();
    const card=await server.documents!.authorize(id,actor);Object.assign(card,structuredClone(legacyReceipt));server.documents!.checkpoint();
    const fresh=await server.documents!.exportMarkdown(id,actor,card.messageTs!);
    assert.notEqual(fresh.id,legacyReceipt.markdownFileId);assert.equal(mdUploads(server.api).length,1);assert.equal(conversions,1);
    assert.equal(card.exports?.['markdown-v3']?.fileId,fresh.id);assert.equal(card.exports?.['markdown-v3']?.attempt?.saved,true);
    assert.equal(card.markdownFileId,legacyReceipt.markdownFileId);
    assert.equal((await server.documents!.exportMarkdown(id,actor,card.messageTs!)).id,fresh.id);
    assert.equal(mdUploads(server.api).length,1);assert.equal(conversions,1);
  }finally{await server.stop();}
});

test('Cloud Markdown ignores a persisted legacy text-only receipt and reuses only the new ZIP receipt',async()=>{
  const f=cloudFixture();try{
    const id=await f.make().submit(actor,'FTEST','legacy-md','open');await f.drain();
    await f.store.atomic<Card,void>('cards',id,current=>{assert.ok(current);return {value:{...current,...structuredClone(legacyReceipt)},result:undefined};});
    const card=await f.make().authorize(id,actor);const fresh=await f.make().exportMarkdown(id,actor,card.messageTs!);
    assert.notEqual(fresh.id,legacyReceipt.markdownFileId);assert.equal(mdUploads(f.api).length,1);assert.equal(f.conversions,1);
    const saved=await f.make().authorize(id,actor);assert.equal(saved.exports?.['markdown-v3']?.fileId,fresh.id);assert.equal(saved.exports?.['markdown-v3']?.attempt?.saved,true);
    assert.equal(saved.markdownFileId,legacyReceipt.markdownFileId);
    assert.equal((await f.make().exportMarkdown(id,actor,card.messageTs!)).id,fresh.id);assert.equal(mdUploads(f.api).length,1);assert.equal(f.conversions,1);
  }finally{f.close();}
});

test('PNG commands request the declared first ten pages in Cloud and local receivers',async()=>{
  const f=cloudFixture();try{const id=await f.make().submit(actor,'FTEST','png-command','png');await f.drain();const card=await f.make().authorize(id,actor);assert.equal(card.images?.length,10);}finally{f.close();}
  const server=await editorServer({convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:12,pages:[1,2,3].map(page=>({page,png:Buffer.from('png')}))}),convertImages:async(_b,o)=>({pageCount:12,pages:Array.from({length:o!.end!-o!.start!+1},(_,i)=>({page:i+o!.start!,png:Buffer.from('png')}))})});
  try{const {id}=server.preparations.submit(actor,'FTEST','png','png-test');await server.preparations.idle();await until(()=>server.api.files.size===11);const card=await server.documents!.authorize(id,actor);assert.equal(card.images?.length,10);}finally{await server.stop();}
});
