import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {HttpSlackApi} from '../../src/server/slack-api';
import {object} from '../../src/server/errors';
import {actor,bytes,signed} from './support';
import {legacyFixture} from './legacy-support';

test('workspace worker final event failure sends one sanitized notice after durable failure, including redelivery',async()=>{
 const f=await legacyFixture();try{
  await f.events.enqueue('ETERMINAL',{kind:'app_mention',actor,files:['FTEST']});const id=f.pending.shift()!;
  f.api.handler=async(method,args)=>{
   if(method==='files.info')return new HttpSlackApi('xoxb-synthetic-test',async()=>new Response(JSON.stringify({ok:false,error:'missing_scope'}))).call(method,args);
   if(method==='chat.postEphemeral')assert.equal((await f.store.get<any>('tasks',id)).state,'failed');
   return f.api.response(method,args);
  };
  assert.equal((await f.dispatch(id,'wrong')).status,403);assert.equal(f.api.calls.length,0);
  assert.equal((await f.dispatch(id)).status,204);assert.equal((await f.dispatch(id)).status,204);
  assert.equal(f.api.calls.filter(c=>c.method==='files.info').length,1);
  const notices=f.api.calls.filter(c=>c.method==='chat.postEphemeral');assert.equal(notices.length,1);
  assert.doesNotMatch(String(notices[0].args.text),/FTEST|missing_scope|xoxb|files\.slack\.com/);
  assert.equal((await f.store.list<any>('event_notices'))[0][1].state,'sent');
 }finally{await f.close();}
});

test('workspace worker routes deadline recovery to event terminal callback without rerunning file access',async()=>{
 const f=await legacyFixture();try{
  await f.events.enqueue('EDEADLINE',{kind:'app_mention',actor,files:['FTEST']});const id=f.pending.shift()!,watch=f.scheduled.find(s=>s.at!==undefined)!;
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const execute=f.events.execute.bind(f.events);f.events.execute=async(_spec,context)=>{entered();await gate;await context.checkpoint();};
  const active=f.dispatch(id);await started;f.advance(15*60_000);
  try{assert.equal((await f.dispatch(watch.id)).status,204);assert.equal(f.api.calls.filter(c=>c.method==='chat.postEphemeral').length,1);}
  finally{release();}
  assert.equal((await active).status,503);f.events.execute=execute;
  assert.equal((await f.dispatch(id)).status,204);assert.equal((await f.dispatch(watch.id)).status,204);
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postEphemeral').length,1);assert.equal(f.api.calls.some(c=>c.method==='files.info'),false);
 }finally{await f.close();}
});

test('signed legacy Work Object opens an embed ticket and saves once in the original thread through the workspace worker',async()=>{
 const f=await legacyFixture();try{
  const id=await f.prepare(),card=await f.application.authorize(id,actor);
  assert.equal(card.pdf,'ready');assert.ok((card as any).pdfPreparedAt);assert.ok((card as any).slackPublishedAt);
  const event={type:'event_callback',api_app_id:'ATEST',team_id:'TTEST',event_id:'EDETAIL',event:{type:'entity_details_requested',user:'UTEST',channel:'CTEST',external_ref:{id,type:'document'},entity_url:`${f.cfg.publicOrigin}/documents/${id}`,trigger_id:'detail.trigger'}};
  assert.equal((await signed(f.origin,event,{json:true})).status,200);
  assert.equal((await signed(f.origin,event,{json:true})).status,200);
  const presented=f.api.calls.filter(c=>c.method==='entity.presentDetails');assert.equal(presented.length,1);
  const preview=object(object(object(object(presented[0].args.metadata).entity_payload).attributes).full_size_preview);
  const viewer=new URL(String(preview.preview_url));assert.equal(viewer.origin,f.cfg.editorOrigin);
  const ticket=new URLSearchParams(viewer.hash.slice(1)).get('ticket')!;
  const exchange=await fetch(f.origin+'/api/editor/exchange',{method:'POST',headers:{Origin:f.cfg.editorOrigin,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
  assert.equal(exchange.status,200);const {token}=await exchange.json() as {token:string};
  const source=await fetch(f.origin+'/api/editor/source',{headers:{Authorization:'Bearer '+token}});assert.equal(source.status,200);assert.deepEqual(Buffer.from(await source.arrayBuffer()),bytes);
  const request=randomUUID(),save=()=>fetch(f.origin+'/api/editor/save',{method:'POST',headers:{Origin:f.cfg.editorOrigin,'Content-Type':'application/octet-stream',Authorization:'Bearer '+token,'X-Save-Request-Id':request,'X-Document-Format':'hwp'},body:bytes});
  const first=await save();assert.equal(first.status,200);const receipt=await first.json() as {saved:boolean;fileId:string};assert.equal(receipt.saved,true);
  const duplicate=await save();assert.equal(duplicate.status,200);assert.equal((await duplicate.json() as {fileId:string}).fileId,receipt.fileId);await f.drain();
  const posted=f.api.calls.filter(c=>c.method==='chat.postMessage');assert.equal(posted.length,2);assert.ok(posted.every(c=>c.args.thread_ts==='100.001'));
  assert.ok(f.api.calls.filter(c=>c.method==='files.completeUploadExternal').every(c=>c.args.channel_id===undefined));
  assert.equal((f.api.files.get(receipt.fileId)!.shares as any).public.CTEST[0].thread_ts,'100.001');
  assert.equal((await f.store.list('usage_events')).length,0);
 }finally{await f.close();}
});

test('legacy cards keep their identity, embed ticket and original thread without inventing old completion timestamps',async()=>{
 const f=await legacyFixture();try{
  const id=await f.prepare();
  await f.store.atomic<any,void>('cards',id,current=>{
   const {pdfPreparedAt,slackPublishedAt,...legacy}=current;
   return {value:legacy,result:undefined};
  });
  const card=await f.application.authorize(id,actor);assert.equal((card as any).pdfPreparedAt,undefined);assert.equal((card as any).slackPublishedAt,undefined);
  const postsBefore=f.api.calls.filter(c=>c.method==='chat.postMessage').length;
  await f.application.present(id,actor,'legacy.trigger');
  const metadata=f.api.calls.filter(c=>c.method==='entity.presentDetails').at(-1)!.args.metadata;
  assert.equal(object(object(metadata).external_ref).id,id);
  const preview=object(object(object(object(metadata).entity_payload).attributes).full_size_preview);
  const ticket=new URLSearchParams(new URL(String(preview.preview_url)).hash.slice(1)).get('ticket')!;
  const token=await f.application.sessions.exchange(ticket),session=await f.application.sessions.require(token);
  assert.equal(session.cardId,id);assert.deepEqual(await f.application.ensureSource(id,session.actor),bytes);
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,postsBefore);
  const receipt=await f.application.save(session,randomUUID(),'hwp',bytes);assert.equal(receipt.saved,true);await f.drain();
  const revision=f.api.calls.filter(c=>c.method==='chat.postMessage').at(-1)!;assert.equal(revision.args.thread_ts,'100.001');
  assert.equal((await f.application.authorize(id,actor) as any).pdfPreparedAt,undefined);
 }finally{await f.close();}
});
