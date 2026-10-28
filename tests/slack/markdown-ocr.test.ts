import test from 'node:test';
import assert from 'node:assert/strict';
import {loadMarkdownOcrConfig} from '../../src/server/config';
import {exportKey,normalizeExportRequest} from '../../src/server/document-exports';
import {EditorApi,editorServer} from './editor-support';
import {actor,bytes,config} from './support';
import {writeArchive} from '../../src/conversion/archive.mjs';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents} from '../../src/server/cloud/events';

test('OCR configuration requires an operator supplied absolute module and model cache pair',()=>{
 assert.equal(loadMarkdownOcrConfig({}),undefined);
 const profile={modulePath:'/trusted/kordoc/dist/index.js',modelCachePath:'/trusted/models'};
 assert.deepEqual(loadMarkdownOcrConfig({DHWP_KORDOC_MODULE:profile.modulePath,DHWP_KORDOC_MODEL_CACHE:profile.modelCachePath}),profile);
 for(const env of [{DHWP_KORDOC_MODULE:profile.modulePath},{DHWP_KORDOC_MODEL_CACHE:profile.modelCachePath},{DHWP_KORDOC_MODULE:'https://evil.invalid/code.js',DHWP_KORDOC_MODEL_CACHE:profile.modelCachePath},{DHWP_KORDOC_MODULE:profile.modulePath,DHWP_KORDOC_MODEL_CACHE:'relative'}])assert.throws(()=>loadMarkdownOcrConfig(env));
 assert.equal(exportKey({format:'markdown'}),'markdown-v3');
 assert.equal(exportKey({format:'markdown',ocr:true}),'markdown-v3-ocr');
 assert.throws(()=>normalizeExportRequest({format:'markdown',ocr:{modulePath:'/attacker'}}));
});

test('Slack selects OCR from server configuration and never reuses a plain or old package receipt',async()=>{
 const profile={modulePath:'/trusted/kordoc/dist/index.js',modelCachePath:'/trusted/models'};
 const markdown=Buffer.from('# 합성 문서'),report={schemaVersion:1,ocr:{runtimeStatus:'complete'}},zip=writeArchive([{name:'document.md',bytes:markdown},{name:'report.json',bytes:Buffer.from(JSON.stringify(report))}]);
 const api=new EditorApi();let conversions=0;
 const server=await editorServer({api,markdownOcr:profile,markdown:async(_source,options)=>{assert.deepEqual(options?.ocr,profile);conversions++;return {markdown,report,zip};}});
 try{
  const id=await server.prepare(),card=await server.documents!.authorize(id,actor);
  card.exports={'markdown-v2':{request:{format:'markdown'},fileId:'FOLD',attempt:{fileId:'FOLD',saved:true}},'markdown-v3':{request:{format:'markdown'},fileId:'FPLAIN',attempt:{fileId:'FPLAIN',saved:true}}};
  const first=await server.documents!.exportFile(id,actor,card.messageTs!,{format:'markdown'});
  assert.notEqual(first.id,'FOLD');assert.notEqual(first.id,'FPLAIN');
  assert.equal((await server.documents!.exportMarkdown(id,actor,card.messageTs!)).id,first.id);
  assert.equal(conversions,1);assert.equal(card.exports['markdown-v3-ocr']?.attempt?.saved,true);
 }finally{await server.stop();}
});

test('an unavailable OCR runtime leaves no saved package and the same card can retry after repair',async()=>{
 const profile={modulePath:'/trusted/kordoc/dist/index.js',modelCachePath:'/trusted/models'};
 const markdown=Buffer.from('# synthetic'),zip=writeArchive([{name:'document.md',bytes:markdown}]);
 let conversions=0;
 const server=await editorServer({markdownOcr:profile,markdown:async()=>({markdown,zip,report:{schemaVersion:1,ocr:{runtimeStatus:++conversions===1?'runtime_unavailable':'complete'}}})});
 try{
  const id=await server.prepare(),card=await server.documents!.authorize(id,actor);
  await assert.rejects(server.documents!.exportMarkdown(id,actor,card.messageTs!),{code:'conversion_ocr_unavailable'});
  assert.equal(card.exports?.['markdown-v3-ocr'],undefined);
  assert.equal(server.api.calls.filter(call=>call.method==='files.getUploadURLExternal'&&String(call.args.filename).endsWith('_Markdown.zip')).length,0);
  const ready=await server.documents!.exportMarkdown(id,actor,card.messageTs!);
  const saved=await server.documents!.authorize(id,actor);
  assert.equal(conversions,2);assert.equal(saved.exports?.['markdown-v3-ocr']?.fileId,ready.id);
  assert.equal((await server.documents!.exportMarkdown(id,actor,card.messageTs!)).id,ready.id);assert.equal(conversions,2);
 }finally{await server.stop();}
});

test('Cloud OCR failure clears its durable receipt and the same card retries across workers after repair',async()=>{
 const state=new State(':memory:','TTEST'),store=new SqliteMetadata(state),api=new EditorApi(),pending:string[]=[];
 const tasks=new DurableTasks(store,{async publish(id,notBefore){if(notBefore===undefined)pending.push(id);}});
 const profile={modulePath:'/trusted/kordoc/dist/index.js',modelCachePath:'/trusted/models'};
 const markdown=Buffer.from('# Cloud OCR retry'),zip=writeArchive([{name:'document.md',bytes:markdown}]);
 let conversions=0,repaired=false;
 const make=()=>new CloudApplication({...config,publicOrigin:'https://cloud.example.com',markdownOcr:profile},api,store,tasks,{
  download:async()=>bytes,fetcher:async()=>new Response('ok'),
  convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:1,pages:[{page:1,png:Buffer.from('png')}]}),
  markdown:async(_source,options)=>{
   assert.deepEqual(options?.ocr,profile);conversions++;
   return {markdown,zip,report:{schemaVersion:1,ocr:{runtimeStatus:repaired?'complete':'runtime_unavailable'}}};
  },
 });
 const allocations=()=>api.calls.filter(call=>call.method==='files.getUploadURLExternal'&&String(call.args.filename).endsWith('_Markdown.zip'));
 try{
  const id=await make().submit(actor,'FTEST','cloud-ocr-retry','open');
  while(pending.length){
   const app=make(),events=new CloudEvents(app,'UBOT');
   await tasks.execute(pending.shift()!,(spec,context)=>spec.kind==='event'?events.execute(spec,context):app.execute(spec,context));
  }
  const card=await make().authorize(id,actor);
  await assert.rejects(make().exportMarkdown(id,actor,card.messageTs!),{code:'conversion_ocr_unavailable'});
  assert.equal(allocations().length,0);
  assert.equal((await make().authorize(id,actor)).exports?.['markdown-v3-ocr'],undefined);
  assert.equal(conversions,1);
  repaired=true;
  const ready=await make().exportMarkdown(id,actor,card.messageTs!);
  const saved=await make().authorize(id,actor);
  assert.equal(saved.exports?.['markdown-v3-ocr']?.fileId,ready.id);
  assert.equal(saved.exports?.['markdown-v3-ocr']?.attempt?.saved,true);
  assert.equal(conversions,2);assert.equal(allocations().length,1);
  assert.equal((await make().exportMarkdown(id,actor,card.messageTs!)).id,ready.id);
  assert.equal(conversions,2);assert.equal(allocations().length,1);
 }finally{state.close();}
});
