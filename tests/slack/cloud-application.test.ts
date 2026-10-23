import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {EditorApi} from './editor-support';
import {actor,config,bytes} from './support';
function fixture(concurrency:1|2=1,editorMode:'embed'|'browser'='embed'){
 const dir=mkdtempSync(join(tmpdir(),'rhwp-cloud-app-')),state=new State(join(dir,'metadata.sqlite'),'TTEST'),store=new SqliteMetadata(state),api=new EditorApi();
 const pending:string[]=[];let failPublish=false,failUpload=false;const tasks=new DurableTasks(store,{async publish(id,notBefore){if(failPublish)throw new Error('queue unavailable');if(notBefore===undefined)pending.push(id);}});
 const make=(options:NonNullable<ConstructorParameters<typeof CloudApplication>[4]>={})=>new CloudApplication({...config,editorMode,imageUploadConcurrency:concurrency,publicOrigin:'https://cloud.example.com'},api,store,tasks,{noticeIdentity:{generation:'fixture-generation',botUserId:'UBOT',check:async()=>{}},download:async()=>bytes,fetcher:async(url)=>{assert.ok(String(url).startsWith('https://files.slack.com/upload/v1/'));if(failUpload)throw new Error('upload down');return new Response('ok');},convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:12,pages:[1,2,3].map(page=>({page,png:Buffer.from('png')}))}),images:async()=>({pageCount:12,pages:Array.from({length:10},(_,i)=>({page:i+1,png:Buffer.from('png')}))}),...options});
 return {store,api,tasks,make,pending,setPublishFailure(v:boolean){failPublish=v;},setUploadFailure(v:boolean){failUpload=v;},async drain(){while(pending.length){const id=pending.shift()!;await tasks.execute(id,(spec,ctx)=>make().execute(spec,ctx));}},close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
test('replacement workers build one thread card and persist file IDs without document bytes or upload URLs',async()=>{
 const f=fixture();try{
  const who={...actor,threadTs:'100.001'},id=await f.make().submit(who,'FTEST','thread:original');await f.drain();
  let card=await f.make().authorize(id,actor);assert.equal(card.pdf,'ready');assert.equal(card.imageState,'ready');assert.equal(card.images?.length,3);
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);assert.equal(f.api.messages.get(card.messageTs!)?.thread_ts,'100.001');
  const saved=JSON.stringify(await f.store.list('cards'));assert.equal(saved.includes('/upload/v1/'),false);assert.equal(saved.includes('png'),false);
  await f.make().submit(who,'FTEST','thread:original');await f.drain();assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);
  await f.make().morePages(id,actor,card.messageTs!);await f.drain();card=await f.make().authorize(id,actor);assert.equal(card.images?.length,10);assert.equal(card.imageState,'ready');
  const session=await f.make().sessions.exchange(await f.make().sessions.issue(id,actor));assert.deepEqual(await f.make().ensureSource((await f.make().sessions.require(session)).cardId,actor),bytes);
 }finally{f.close();}
});
test('source download reuses only this request authorization and rechecks both source and revision root afterwards',async()=>{
 for(const revision of [false,true]){
  const f=fixture();try{
   const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:source-count');await f.drain();
   if(revision)await f.store.atomic<any,void>('cards',id,card=>({value:{...card,fileId:'FREVISION',rootFileId:'FTEST'},result:undefined}));
   let downloads=0;
   const app=f.make({download:async source=>{downloads++;assert.equal(source.id,revision?'FREVISION':'FTEST');return bytes;}});
   for(let attempt=0;attempt<2;attempt++){
    f.api.calls.length=0;assert.deepEqual(await app.ensureSource(id,actor),bytes);
    for(const method of ['conversations.info','conversations.members','files.info'])assert.equal(f.api.calls.filter(c=>c.method===method).length,revision?4:2);
    if(revision)assert.equal(f.api.calls.filter(c=>c.method==='files.info'&&c.args.file==='FTEST').length,2);
   }
   assert.equal(downloads,2); // No cross-request document or permission cache.
  }finally{f.close();}
 }
});
test('revocation during transfer and changed document bytes still prevent source delivery',async()=>{
 for(const scenario of ['membership','root','hash','removed'] as const){
  const f=fixture();try{
   const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:source-revoke');await f.drain();
   if(scenario==='root')await f.store.atomic<any,void>('cards',id,card=>({value:{...card,fileId:'FREVISION',rootFileId:'FTEST'},result:undefined}));
   let transferred=false;
   f.api.handler=async(method,args)=>{
    if(transferred&&scenario==='membership'&&method==='conversations.members')return {ok:true,members:[],response_metadata:{next_cursor:''}};
    const result=f.api.response(method,args);
    if(transferred&&scenario==='root'&&method==='files.info'&&args.file==='FTEST')return {...result,file:{...(result.file as object),shares:{}}};
    return result;
   };
   const app=f.make({download:async()=>{
    transferred=true;
    if(scenario==='removed')await f.make().invalidate('FTEST');
    if(scenario==='hash'){const changed=Buffer.from(bytes);changed[changed.length-1]^=1;return changed;}
    return bytes;
   }});
   await assert.rejects(app.ensureSource(id,actor),{code:scenario==='hash'?'source_changed':'access_denied'});
   assert.equal(transferred,true);
  }finally{f.close();}
 }
});
test('saving survives a queue outage and retries the same request without duplicating revisions',async()=>{
 const f=fixture();try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:save');await f.drain();
  const app=f.make(),bearer=await app.sessions.exchange(await app.sessions.issue(id,actor)),session=await app.sessions.require(bearer),request=randomUUID();
  f.setPublishFailure(true);await assert.rejects(app.save(session,request,'hwp',bytes),/queue unavailable/);
  f.setPublishFailure(false);const receipt=await f.make().save(session,request,'hwp',bytes);assert.equal(receipt.saved,true);await f.drain();
  assert.equal((await f.make().status(session,request)).pdf,'ready');
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,2);
  assert.ok(receipt.name.endsWith('_편집본_1.hwp'));
  const next=await f.make().save(session,randomUUID(),'hwp',bytes);assert.ok(next.name.endsWith('_편집본_2.hwp'));await f.drain();
  const stored=JSON.stringify(await f.store.list('saves'));assert.equal(stored.includes('/upload/v1/'),false);
 }finally{f.close();}
});
test('failed transfer retries on a new worker while keeping the original card and permissions',async()=>{
 const f=fixture();try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:retry');const first=f.pending.shift()!;await f.tasks.execute(first,(spec,ctx)=>f.make().execute(spec,ctx));
  const preview=f.pending.shift()!;f.setUploadFailure(true);await assert.rejects(f.tasks.execute(preview,(spec,ctx)=>f.make().execute(spec,ctx)));
  f.setUploadFailure(false);await f.tasks.execute(preview,(spec,ctx)=>f.make().execute(spec,ctx));assert.equal((await f.make().authorize(id,actor)).pdf,'ready');
  await f.make().invalidate('FTEST');await assert.rejects(f.make().ensureSource(id,actor));
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);
 }finally{f.close();}
});

test('retrying remains pending; final failure has a new manual generation and one original card',async()=>{
 const f=fixture();try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:exhaust');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;f.setUploadFailure(true);
  await assert.rejects(f.tasks.execute(job,(s,c)=>f.make().execute(s,c)));
  let card=await f.make().authorize(id,actor);assert.equal(card.pdf,'pending');assert.equal(card.recovery?.state,'retrying');
  assert.match(JSON.stringify(f.api.messages.get(card.messageTs!)),/자동으로 다시 시도/);
  await assert.rejects(f.tasks.execute(job,(s,c)=>f.make().execute(s,c)));await f.tasks.execute(job,(s,c)=>f.make().execute(s,c));
  card=await f.make().authorize(id,actor);assert.equal(card.pdf,'failed');assert.equal(card.recovery?.state,'failed');
  assert.match(JSON.stringify(f.api.messages.get(card.messageTs!)),/rhwp_retry_preview/);
  await assert.rejects(f.make().retryPreview(id,{...actor,channelId:'COTHER'},card.messageTs!));
  const retries=await Promise.allSettled([f.make().retryPreview(id,actor,card.messageTs!),f.make().retryPreview(id,actor,card.messageTs!)]);
  assert.equal(retries.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.pending.length,1);const next=f.pending.shift()!;assert.notEqual(next,job);
  // A duplicate notification for the older task cannot replace the newly pending state.
  await f.tasks.execute(job,(s,c)=>f.make().execute(s,c));assert.equal((await f.make().authorize(id,actor)).recovery?.taskId,next);
  f.setUploadFailure(false);await f.tasks.execute(next,(s,c)=>f.make().execute(s,c));
  assert.equal((await f.make().authorize(id,actor)).pdf,'ready');assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);
 }finally{f.close();}
});


test('PDF is shared before a PNG failure; a replacement worker reuses it and starts at the first missing image',async()=>{
 const f=fixture();try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:partial');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;
  const first=f.make({convert:async(_bytes,options)=>{
    await options?.onPdf?.(Buffer.from('%PDF-synthetic'),12);
    await options?.onPage?.({page:1,png:Buffer.from('png')},12);
    throw Object.assign(new Error('synthetic PNG failure'),{code:'conversion_timeout'});
  }});
  await assert.rejects(f.tasks.execute(job,(s,c)=>first.execute(s,c)));
  const pdfUploads=()=>f.api.calls.filter(c=>c.method==='files.getUploadURLExternal'&&String(c.args.filename).endsWith('.pdf')).length;
  assert.equal(pdfUploads(),1);assert.equal((await f.make().authorize(id,actor)).pdf,'ready');
  const next=f.make({convert:async()=>{throw new Error('PDF must not run again');},images:async(_bytes,options)=>{
    assert.equal(options?.start,2);assert.equal(options?.end,3);
    return {pageCount:12,pages:[2,3].map(page=>({page,png:Buffer.from('png')}))};
  }});
  await f.tasks.execute(job,(s,c)=>next.execute(s,c));const card=await f.make().authorize(id,actor);
  assert.equal(pdfUploads(),1);assert.equal(card.imageState,'ready');assert.deepEqual(card.images?.map(p=>p.page),[1,2,3]);
 }finally{f.close();}
});


test('out-of-order parallel PNG uploads preserve gallery order and durable receipts',async()=>{
 const f=fixture(2);try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:parallel');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;
  let active=0,peak=0;
  const app=f.make({fetcher:async(url)=>{
    const file=f.api.files.get(String(url).split('/').at(-1)!);const isPng=String(file?.name).endsWith('.png');
    if(isPng){active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,String(file?.name).includes('_001')?35:5));active--;}
    return new Response('ok');
  },convert:async(_bytes,options)=>{
    const pdf=Buffer.from('%PDF-synthetic'),pages=[1,2,3].map(page=>({page,png:Buffer.from('png')}));
    await options?.onPdf?.(pdf,12);for(const page of pages)await options?.onPage?.(page,12);
    return {pdf,pageCount:12,pages};
  }});
  await f.tasks.execute(job,(s,c)=>app.execute(s,c));const card=await app.authorize(id,actor);
  assert.equal(peak,2);assert.equal(active,0);assert.deepEqual(card.images?.map(p=>p.page),[1,2,3]);assert.ok(card.images?.every(p=>p.shared));
  assert.equal(f.api.calls.filter(c=>c.method==='files.getUploadURLExternal').length,4);
  const posted=f.api.messages.get(card.messageTs!)!;assert.deepEqual((posted.files as {id:string}[]).map(f=>f.id),card.images?.map(p=>p.fileId));
 }finally{f.close();}
});


test('a worker that lost task ownership cannot publish a stale retry notice',async()=>{
 const f=fixture();try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:lost-owner');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;
  const app=f.make({convert:async()=>{
    await f.store.atomic<any,void>('tasks',job,current=>({value:{...current,owner:'replacement-worker'},result:undefined}));
    throw new Error('old worker failed');
  }});
  await assert.rejects(f.tasks.execute(job,(s,c)=>app.execute(s,c)));
  const card=await f.make().authorize(id,actor);assert.equal(card.recovery?.state,'running');
  assert.equal(JSON.stringify(f.api.messages.get(card.messageTs!)).includes('자동으로 다시 시도'),false);
 }finally{f.close();}
});


test('first PNG uploads while PDF transfer is blocked, and failure drains both before retry',async()=>{
 for(const failPdf of [false,true]){
  const f=fixture();let releasePdf!:()=>void;const gate=new Promise<void>(r=>releasePdf=r);
  let pngStarted!:()=>void;const pngGate=new Promise<void>(r=>pngStarted=r);
  let pdfActive=false,finished=false;
  try{
   const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:independent');
   await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;
   const app=f.make({fetcher:async(url)=>{
    const name=String(f.api.files.get(String(url).split('/').at(-1)!)?.name);
    if(name.endsWith('.pdf')){pdfActive=true;await gate;pdfActive=false;if(failPdf)throw new Error('pdf transfer down');}
    else{assert.equal(pdfActive,true);pngStarted();}
    return new Response('ok');
   },convert:async(_bytes,options)=>{
    const pdf=Buffer.from('%PDF-synthetic'),pages=[{page:1,png:Buffer.from('png')}];
    await options?.onPdf?.(pdf,1);await options?.onPage?.(pages[0],1);return {pdf,pages,pageCount:1};
   }});
   const work=f.tasks.execute(job,(s,c)=>app.execute(s,c)).then(()=>({ok:true}),()=>({ok:false})).finally(()=>{finished=true;});
   await Promise.race([pngGate,new Promise((_,reject)=>setTimeout(()=>reject(new Error('PNG waited for PDF')),2000))]);
   assert.equal(finished,false);releasePdf();assert.equal((await work).ok,!failPdf);assert.equal(pdfActive,false);
   const card=await f.make().authorize(id,actor);assert.equal(card.images?.length,1);
   if(failPdf){
    await f.tasks.execute(job,(s,c)=>f.make({convert:async()=>({pdf:Buffer.from('%PDF-retry'),pageCount:1,pages:[]})}).execute(s,c));
    assert.equal((await f.make().authorize(id,actor)).pdf,'ready');
    assert.equal(f.api.calls.filter(c=>c.method==='files.getUploadURLExternal'&&String(c.args.filename).endsWith('.png')).length,1);
   }else assert.equal(card.imageState,'ready');
  }finally{releasePdf();f.close();}
 }
});

test('browser beta shares PDF before ready and saved HWP in the same thread without Work Objects metadata',async()=>{
 const f=fixture(1,'browser');try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:browser');await f.drain();
  const card=await f.make().authorize(id,actor);assert.equal(card.pdf,'ready');assert.equal(card.imageState,'ready');
  const original=f.api.messages.get(card.messageTs!)!;assert.equal(original.metadata,undefined);
  assert.deepEqual((original.files as {id:string}[]).map(v=>v.id).sort(),[card.pdfFileId,...card.images!.map(v=>v.fileId)].sort());
  const app=f.make(),bearer=await app.sessions.exchange(await app.sessions.issue(id,actor)),session=await app.sessions.require(bearer);
  const request=randomUUID();let failShare=true;
  f.api.handler=async(method,args)=>{if(method==='chat.update'&&failShare){failShare=false;throw new Error('sharing interrupted');}return f.api.response(method,args);};
  await assert.rejects(app.save(session,request,'hwp',bytes),/sharing interrupted/);
  const saved=await app.save(session,request,'hwp',bytes);assert.equal(saved.saved,true);await f.drain();
  const revisions=(await f.store.list<any>('cards')).map(([,c])=>c).filter(c=>c.parentId===id);assert.equal(revisions.length,1);assert.equal(revisions[0].pdf,'ready');
  const revision=f.api.messages.get(revisions[0].messageTs)!;assert.equal(revision.thread_ts,'100.001');assert.equal(revision.metadata,undefined);
  assert.deepEqual(revisions[0].noticeTarget,{fileId:saved.fileId,cardId:revisions[0].id,teamId:actor.teamId,channelId:actor.channelId,messageTs:revisions[0].messageTs,generation:'fixture-generation',botUserId:'UBOT'});
  assert.notEqual(revisions[0].noticeTarget.cardId,card.noticeTarget?.cardId);assert.notEqual(revisions[0].noticeTarget.fileId,card.noticeTarget?.fileId);assert.notEqual(revisions[0].noticeTarget.messageTs,card.noticeTarget?.messageTs);

  assert.ok((revision.files as {id:string}[]).some(v=>v.id===saved.fileId));assert.ok(f.api.calls.some(c=>c.method==='chat.update'&&c.args.ts===revisions[0].messageTs&&(c.args.file_ids as string[])?.includes(saved.fileId!)));assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,2);
 }finally{f.close();}
});

test('leaving during preview finalizes state without resharing files and permits a fresh authorized retry',async()=>{
 const f=fixture(1,'browser');try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:left-preview');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;
  let left=false;
  f.api.handler=async(method,args)=>left&&method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:f.api.response(method,args);
  const app=f.make({convert:async()=>{left=true;return {pdf:Buffer.from('%PDF-test'),pageCount:12,pages:[{page:1,png:Buffer.from('png')}]};}});
  await assert.rejects(f.tasks.execute(job,(s,c)=>app.execute(s,c)));
  await assert.rejects(f.tasks.execute(job,(s,c)=>app.execute(s,c)));
  await f.tasks.execute(job,(s,c)=>app.execute(s,c));
  const card=await f.store.get<any>('cards',id);
  assert.equal(card.pdf,'failed');assert.equal(card.imageState,'failed');assert.equal(card.recovery.state,'failed');
  assert.equal((await f.store.get<any>('tasks',job)).state,'failed');
  const updates=f.api.calls.filter(c=>c.method==='chat.update');assert.ok(updates.length);
  const last=updates.at(-1)!.args;assert.match(JSON.stringify(last),/문서 접근을 확인할 수 없어/);
  for(const key of ['file_ids','metadata'])assert.equal(last[key],undefined);
  assert.equal(JSON.stringify(last).includes('FTEST'),false);assert.equal(JSON.stringify(last).includes('https://'),false);
  assert.equal(f.api.calls.filter(c=>c.method==='files.completeUploadExternal').length,0);
  await assert.rejects(f.make().retryPreview(id,actor,card.messageTs),{code:'access_denied'});
  left=false;await f.make().retryPreview(id,actor,card.messageTs);await f.drain();
  assert.equal((await f.make().authorize(id,actor)).pdf,'ready');
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postMessage').length,1);
 }finally{f.close();}
});

test('failure persists when status delivery is forbidden or unavailable and old tasks cannot overwrite a retry',async()=>{
 for(const scenario of ['bot-left','external','channel-off','slack-down','wrong-team'] as const){
  const f=fixture();try{
   const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:status-'+scenario);
   await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;
   const spec=(await f.store.get<any>('tasks',job)).spec;
   f.api.calls.length=0;
   f.api.handler=async(method,args)=>{
    if(method==='conversations.members')return {ok:true,members:[],response_metadata:{next_cursor:''}};
    if(method==='chat.update'&&scenario==='slack-down')throw new Error('network');
    const result=f.api.response(method,args);
    if(method==='conversations.info'&&['bot-left','external'].includes(scenario))return {...result,channel:{...(result.channel as object),...(scenario==='bot-left'?{is_member:false}:{is_ext_shared:true})}};
    return result;
   };
   if(scenario==='channel-off')await f.store.atomic('channels',actor.channelId,()=>({value:{mode:'off'},result:undefined}));
   const ctx={id:job,attempt:3,maxAttempts:3,finalAttempt:true,terminalFailure:'access_denied',signal:new AbortController().signal,checkpoint:async()=>{}};
   await assert.rejects(f.make().execute({...spec,...(scenario==='wrong-team'?{teamId:'TOTHER'}:{})},ctx));
   const card=await f.store.get<any>('cards',id);
   assert.equal(card.pdf,scenario==='wrong-team'?'pending':'failed');
   if(scenario!=='slack-down')assert.equal(f.api.calls.filter(c=>c.method==='chat.update').length,0);
   // Simulate a newer manual generation before an old deadline delivery arrives.
   await f.store.atomic<any,void>('cards',id,c=>({value:{...c,pdf:'pending',recovery:{taskId:'newer',state:'running'}},result:undefined}));
   await f.make().execute(spec,ctx);
   assert.equal((await f.store.get<any>('cards',id)).recovery.taskId,'newer');
   assert.equal((await f.store.get<any>('cards',id)).pdf,'pending');
  }finally{f.close();}
 }
});

test('manual retry releases the card lock before dispatch and progress failure does not cancel another user retry',async()=>{
 const f=fixture();try{
  const app=f.make(),id=await app.submit({...actor,threadTs:'100.001'},'FTEST','thread:dispatch-lock');await f.drain();
  const original=await app.authorize(id,actor);
  await f.store.atomic<any,void>('cards',id,c=>({value:{...c,pdf:'failed',imageState:'failed',recovery:{taskId:'old',state:'failed',attempt:3,maxAttempts:3}},result:undefined}));
  const other={...actor,userId:'UOTHER'};
  f.api.handler=async(method,args)=>{
   if(method==='conversations.members')return {ok:true,members:['UOTHER'],response_metadata:{next_cursor:''}};
   if(method==='chat.update')throw new Error('progress unavailable');
   return f.api.response(method,args);
  };
  const dispatch=f.tasks.dispatch.bind(f.tasks);let dispatched=false;
  f.tasks.dispatch=async job=>{assert.equal(await f.store.get('locks','card:'+id),undefined);dispatched=true;await dispatch(job);};
  await app.retryPreview(id,other,original.messageTs!,'click-other');assert.equal(dispatched,true);
  const job=f.pending.shift()!;const work=await f.store.get<any>('tasks',job);assert.equal(work.spec.actor.userId,'UOTHER');
  f.api.handler=async(method,args)=>method==='conversations.members'?{ok:true,members:['UOTHER'],response_metadata:{next_cursor:''}}:f.api.response(method,args);
  await f.tasks.execute(job,(s,c)=>app.execute(s,c));assert.equal((await app.authorize(id,other)).pdf,'ready');
  assert.equal(f.api.calls.filter(c=>c.method==='chat.postEphemeral').length,0);
 }finally{f.close();}
});

test('a redelivered action publishes the same reservation after queue failure',async()=>{
 const f=fixture();try{
  const app=f.make(),id=await app.submit(actor,'FTEST','thread:reserve');await f.drain();const card=await app.authorize(id,actor);
  await f.store.atomic<any,void>('cards',id,c=>({value:{...c,pdf:'failed',imageState:'failed',recovery:{taskId:'old',state:'failed',attempt:3,maxAttempts:3}},result:undefined}));
  f.setPublishFailure(true);await assert.rejects(app.retryPreview(id,actor,card.messageTs!,'click-republish'),/queue unavailable/);
  const reserved=(await app.authorize(id,actor)).recovery!.taskId;assert.equal(await f.store.get('locks','card:'+id),undefined);
  f.setPublishFailure(false);await app.retryPreview(id,actor,card.messageTs!,'click-republish');assert.deepEqual(f.pending,[reserved]);
  await f.drain();assert.equal((await app.authorize(id,actor)).pdf,'ready');
 }finally{f.close();}
});

test('permanent SVG limit finalizes the card on attempt one and offers actionable guidance',async()=>{
 const f=fixture(1,'browser');try{
  const id=await f.make().submit({...actor,threadTs:'100.001'},'FTEST','thread:limit');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>f.make().execute(s,c));const job=f.pending.shift()!;let conversions=0;
  const app=f.make({convert:async()=>{conversions++;throw Object.assign(new Error('private contents'),{code:'conversion_svg_limit'});}});
  await f.tasks.execute(job,(s,c)=>app.execute(s,c));
  let card=await app.authorize(id,actor);assert.equal(card.recovery?.state,'failed');assert.equal(card.recovery?.attempt,1);assert.equal(card.pdf,'failed');
  const message=JSON.stringify(f.api.messages.get(card.messageTs!));assert.match(message,/문서를 나누거나/);assert.doesNotMatch(message,/자동으로 다시 시도|준비가 지연|private contents|rhwp_retry_preview/);assert.match(message,/rhwp_browser_edit/);
  await f.tasks.execute(job,(s,c)=>app.execute(s,c));assert.equal(conversions,1);
  // A ready PDF is retained when only image generation reaches a permanent limit.
  await f.store.atomic<any,void>('cards',id,current=>({value:{...current,pdf:'ready',pdfUrl:'https://example.com/ready.pdf',pageCount:12},result:undefined}));
  const images=f.make({images:async()=>{throw Object.assign(new Error('synthetic image limit'),{code:'conversion_preview_limit'});}});
  await images.morePages(id,actor,card.messageTs!,'fresh-image-generation');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>images.execute(s,c));card=await app.authorize(id,actor);assert.equal(card.pdf,'ready');
  assert.match(JSON.stringify(f.api.messages.get(card.messageTs!)),/PDF로 보기/);
 }finally{f.close();}
});
test('PDF evidence survives failed Slack publication and a replacement worker confirms publication',async()=>{
 const f=fixture(1,'browser');try{
  const app=()=>f.make();
  const id=await app().submit({...actor,threadTs:'100.001'},'FTEST','thread:usage-resume');
  await f.tasks.execute(f.pending.shift()!,(s,c)=>app().execute(s,c));const job=f.pending.shift()!;
  let blocked=true;f.api.handler=async(method,args)=>{
   if(blocked&&method==='chat.update'&&Array.isArray(args.file_ids)&&args.file_ids.length>0)throw new Error('synthetic Slack update outage');
   return f.api.response(method,args);
  };
  await assert.rejects(f.tasks.execute(job,(s,c)=>app().execute(s,c)));
  const partial=await f.store.get<any>('cards',id);assert.ok(partial.pdfPreparedAt);assert.equal(partial.slackPublishedAt,undefined);
  blocked=false;await f.tasks.execute(job,(s,c)=>app().execute(s,c));
  const done=await f.store.get<any>('cards',id);assert.ok(done.slackPublishedAt>=done.pdfPreparedAt);
  assert.equal(f.api.calls.filter(c=>c.method==='files.getUploadURLExternal'&&String(c.args.filename).endsWith('.pdf')).length,1);
 }finally{f.close();}
});
