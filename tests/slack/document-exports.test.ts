import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parsePageSelection,normalizeExportRequest,exportKey,MAX_DOCUMENT_EXPORTS} from '../../src/server/document-exports';
import {EditorApi,editorServer} from './editor-support';
import {actor} from './support';
import type {Card} from '../../src/server/documents';

const text=Buffer.from('동국대학교\n항목\t내용\n테스트 본문');
const zipBytes=Buffer.alloc(32);zipBytes.writeUInt32LE(0x04034b50);
const allocations=(api:EditorApi,extension:string)=>api.calls.filter(call=>call.method==='files.getUploadURLExternal'&&String(call.args.filename).endsWith('.'+extension));

test('page grammar accepts sparse ranges and canonicalizes order without silently truncating',()=>{
  assert.deepEqual(parsePageSelection('12,3-5,1,3'),[1,3,4,5,12]);
  assert.equal(exportKey({format:'zip',pages:[12,1,12]}),'zip:1,12');
  assert.deepEqual(normalizeExportRequest({format:'txt',pages:[999]}),{format:'txt'});
  for(const value of ['', '0','201','1-11','10-1','1.2','-1','1,','1e2','2;3','1-10,12','1-200','01', '1'.repeat(129)])assert.throws(()=>parsePageSelection(value),{code:'export_selection'});
  for(const value of [null,{format:'pdf'},{format:'zip',pages:[NaN]},{format:'zip',pages:['1']},{format:'zip',pages:[]}])assert.throws(()=>normalizeExportRequest(value),{code:'export_selection'});
});

test('TXT and selected ZIP share their exact bytes in the original thread with separate canonical receipts',async()=>{
  const sent:Buffer[]=[],selections:number[][]=[];let textCount=0;
  const server=await editorServer({text:async()=>{textCount++;return text;},zip:async(_bytes,options)=>{selections.push([...options.pages]);return {pageCount:80,pages:[...options.pages],zip:zipBytes};},fetcher:async(_url,init)=>{sent.push(Buffer.from(init!.body as Uint8Array));return new Response('ok');}});
  try{
    const {id}=server.preparations.submit({...actor,threadTs:'100.001'},'FTEST','open','exports-test');await server.preparations.idle();await server.documents!.pdf.idle();
    const card=await server.documents!.authorize(id,actor),message=card.messageTs!;
    const [first,second]=await Promise.all([server.documents!.exportFile(id,actor,message,{format:'txt'}),server.documents!.exportFile(id,actor,message,{format:'txt'})]);
    assert.equal(first.id,second.id);assert.equal(textCount,1);
    const zip=await server.documents!.exportFile(id,actor,message,{format:'zip',pages:[80,12,40,12]});
    assert.equal((await server.documents!.exportFile(id,actor,message,{format:'zip',pages:[12,40,80]})).id,zip.id);
    await server.documents!.exportFile(id,actor,message,{format:'zip',pages:[13]});
    assert.deepEqual(selections,[[12,40,80],[13]]);assert.equal(allocations(server.api,'zip').length,2);assert.equal(allocations(server.api,'txt').length,1);
    assert.ok(sent.some(bytes=>bytes.equals(text)));assert.ok(sent.some(bytes=>bytes.equals(zipBytes)));
    const shared=server.api.calls.filter(call=>call.method==='files.completeUploadExternal'&&call.args.channel_id);
    assert.equal(shared.length,3);assert.ok(shared.every(call=>call.args.thread_ts==='100.001'));
    assert.equal(card.images?.some(image=>image.page===12)??false,false);
  }finally{await server.stop();}
});

test('export denies wrong message/channel, revocation during conversion, oversized or mismatched output',async()=>{
  const api=new EditorApi();let revoked=false,mode='revoked',conversions=0;
  const server=await editorServer({api,text:async()=>{conversions++;if(mode==='revoked')revoked=true;return mode==='oversized'?Buffer.alloc(2*1024*1024+1):text;},zip:async()=>({pageCount:80,pages:[1],zip:zipBytes})});
  try{
    const id=await server.prepare();await server.documents!.pdf.idle();const card=await server.documents!.authorize(id,actor),message=card.messageTs!;
    await assert.rejects(server.documents!.exportFile(id,{...actor,channelId:'COTHER'},message,{format:'txt'}));
    await assert.rejects(server.documents!.exportFile(id,actor,'999.999',{format:'txt'}));assert.equal(conversions,0);
    api.handler=async(method,args)=>revoked&&method==='conversations.members'?{ok:true,members:[],response_metadata:{next_cursor:''}}:api.response(method,args);
    await assert.rejects(server.documents!.exportFile(id,actor,message,{format:'txt'}),{code:'access_denied'});
    revoked=false;mode='oversized';await assert.rejects(server.documents!.exportFile(id,actor,message,{format:'txt'}),{code:'export_output'});
    await assert.rejects(server.documents!.exportFile(id,actor,message,{format:'zip',pages:[12]}),{code:'export_output'});
    assert.equal(allocations(api,'txt').length,0);assert.equal(allocations(api,'zip').length,0);assert.equal(Object.keys(card.exports??{}).length,0);
    card.pageCount=2;await assert.rejects(server.documents!.exportFile(id,actor,message,{format:'zip',pages:[3]}),{code:'export_selection'});
  }finally{await server.stop();}
});

test('distinct-export cap preserves existing receipts and rejects further allocations',async()=>{
  const server=await editorServer({zip:async(_bytes,options)=>({pageCount:80,pages:[...options.pages],zip:zipBytes})});
  try{
    const id=await server.prepare();await server.documents!.pdf.idle();const card=await server.documents!.authorize(id,actor);
    for(let page=1;page<=MAX_DOCUMENT_EXPORTS;page++)await server.documents!.exportFile(id,actor,card.messageTs!,{format:'zip',pages:[page]});
    await assert.rejects(server.documents!.exportFile(id,actor,card.messageTs!,{format:'zip',pages:[21]}),{code:'export_limit'});
    await server.documents!.exportFile(id,actor,card.messageTs!,{format:'zip',pages:[1]});assert.equal(allocations(server.api,'zip').length,20);
  }finally{await server.stop();}
});

test('legacy cards bind the first export to source bytes and never reuse an unbound or changed receipt',async()=>{
  const server=await editorServer({text:async()=>text});
  try{
    const id=await server.prepare();await server.documents!.pdf.idle();const card=await server.documents!.authorize(id,actor);
    delete card.contentHash;
    await server.documents!.exportFile(id,actor,card.messageTs!,{format:'txt'});assert.match(card.contentHash!,/^[a-f0-9]{64}$/);
    const changed=Buffer.from(server.preparations.get(id)!.bytes!);changed[changed.length-1]^=1;
    server.preparations.invalidateCard(id);server.preparations.retain(id,actor,'FTEST',card.name,changed);
    await assert.rejects(server.documents!.exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'source_changed'});
    delete card.contentHash;
    await assert.rejects(server.documents!.exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'source_changed'});
    await assert.rejects(server.documents!.exportFile(id,actor,card.messageTs!,{format:'zip',pages:[1]}),{code:'source_changed'});
    assert.equal(allocations(server.api,'txt').length,1);
  }finally{await server.stop();}
});

test('uncertain TXT completion survives restart and retries the original upload without persisting bytes or signed URLs',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'dhwp-export-recovery-')),api=new EditorApi();let visible=false,streamed=0;
  const isText=(id:unknown)=>String(api.files.get(String(id))?.name).endsWith('.txt');
  api.handler=async(method,args)=>{const response=api.response(method,args);
    if(method==='files.completeUploadExternal'&&isText((args.files as {id:string}[])[0].id))throw new Error('synthetic lost response');
    if(method==='files.info'&&isText(args.file)&&!visible)return {...response,file:{...response.file as Record<string,unknown>,shares:{}}};return response;};
  const options={api,statePath:join(directory,'state.sqlite'),text:async()=>text,fetcher:async(url:Parameters<typeof fetch>[0])=>{if(isText(String(url).split('/').at(-1)))streamed++;return new Response('ok');}};
  let server:Awaited<ReturnType<typeof editorServer>>|undefined;
  try{
    server=await editorServer(options);await server.ready;const id=await server.prepare();await server.documents!.pdf.idle();const card=await server.documents!.authorize(id,actor);
    await assert.rejects(server.documents!.exportFile(id,actor,card.messageTs!,{format:'txt'}),{code:'upload_uncertain'});
    const persisted=server.state!.get<Card>('cards',id)!,fileId=persisted.exports!.txt.attempt!.fileId;assert.ok(fileId);
    assert.equal(persisted.exports!.txt.attempt!.url,undefined);assert.equal(JSON.stringify(persisted).includes('테스트 본문'),false);
    await server.stop();server=undefined;visible=true;server=await editorServer(options);await server.ready;
    const result=await server.documents!.exportFile(id,actor,card.messageTs!,{format:'txt'});assert.equal(result.id,fileId);assert.equal(streamed,1);assert.equal(allocations(api,'txt').length,1);
    assert.equal(api.calls.filter(call=>call.method==='files.completeUploadExternal'&&isText((call.args.files as {id:string}[])[0].id)).length,1);
  }finally{await server?.stop();await rm(directory,{recursive:true,force:true});}
});
