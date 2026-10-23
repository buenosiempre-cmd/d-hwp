import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {HttpSlackApi,readBounded} from '../../src/server/slack-api';
import {slackDiagnostics,attachSlackDiagnostics,attachResponseSizeDiagnostics} from '../../src/server/slack-diagnostics';
import {traceTask} from '../../src/server/cloud/telemetry';
import {authorizeFile} from '../../src/server/access';
import {actor,config,file,FakeApi} from '../slack/support';
const MiB=1024*1024;
const privateText='synthetic-token private-document https://files.slack.com/private';
function jsonBytes(size:number):Buffer {
 const prefix='{"ok":true,"file":{"id":"FTEST"},"padding":"';
 return Buffer.from(prefix+'x'.repeat(size-Buffer.byteLength(prefix)-2)+'"}');
}
function streamed(body:Uint8Array,headers:Record<string,string>={},failCancel=false){
 let offset=0,cancelled=0,pulls=0;
 const stream=new ReadableStream<Uint8Array>({
  pull(controller){pulls++;if(offset===body.length){controller.close();return;}
   const end=Math.min(offset+64*1024,body.length);controller.enqueue(body.subarray(offset,end));offset=end;},
  cancel(){cancelled++;if(failCancel)throw new Error(privateText);},
 },{highWaterMark:0});
 return {response:new Response(stream,{headers}),stats:()=>({offset,cancelled,pulls})};
}

test('ordinary JSON accepts the exact 1 MiB byte boundary and rejects one byte above',async()=>{
 for(const headers of [{},{'content-length':String(MiB)}] as Record<string,string>[]){
  assert.equal((await new HttpSlackApi('synthetic',async()=>streamed(jsonBytes(MiB),headers).response).call('auth.test',{})).ok,true);
 }
 for(const headers of [{},{'content-length':String(MiB+1)},{'content-length':'1'}] as Record<string,string>[]){
  const source=streamed(jsonBytes(MiB+1),headers);
  await assert.rejects(new HttpSlackApi('synthetic',async()=>source.response).call('auth.test',{}),{code:'size_limit'});
  assert.equal(source.stats().cancelled,1);
 }
});

test('files.info accepts complete JSON above 1 MiB through its exact 4 MiB limit',async()=>{
 for(const size of [MiB,MiB+1,2*MiB,4*MiB])for(const header of [false,true]){
  const body=jsonBytes(size),source=streamed(body,header?{'content-length':String(size)}:{});
  const result=await new HttpSlackApi('synthetic',async()=>source.response).call('files.info',{file:'FTEST'});
  assert.equal(result.ok,true);assert.equal(Buffer.byteLength(JSON.stringify(result)),size);
 }
});

test('declared oversized responses cancel before reading and cancel failures retain size_limit',async()=>{
 for(const failCancel of [false,true]){
  const source=streamed(Buffer.from(privateText),{'content-length':String(4*MiB+1)},failCancel);
  await assert.rejects(new HttpSlackApi('synthetic',async()=>source.response).call('files.info',{}),error=>{
   assert.equal((error as {code:string}).code,'size_limit');
   assert.deepEqual(slackDiagnostics(error),{httpStatus:200,responseBytesRead:0,responseLimitBytes:4*MiB,responseContentLengthBytes:4*MiB+1});return true;
  });
  assert.deepEqual(source.stats(),{offset:0,cancelled:1,pulls:0});assert.equal(source.response.body!.locked,false);
 }
});

test('missing, misleading and invalid Content-Length cannot bypass the actual stream cap',async()=>{
 for(const header of [undefined,'1',String(4*MiB),'garbage','-1','Infinity','9007199254740992']){
  const source=streamed(new Uint8Array(5*MiB),header===undefined?{}:{'content-length':header},true);
  await assert.rejects(new HttpSlackApi('synthetic',async()=>source.response).call('files.info',{}),error=>{
   assert.equal((error as {code:string}).code,'size_limit');
   assert.equal(slackDiagnostics(error).responseBytesRead,4*MiB+64*1024);return true;
  });
  assert.equal(source.stats().cancelled,1);assert.equal(source.stats().offset,4*MiB+64*1024);
  assert.equal(source.response.body!.locked,false);
 }
});

test('reader measures UTF-8 bytes and propagates interrupted streams without success',async()=>{
 const body=Buffer.from('한'.repeat(350_000));assert.ok(body.length>MiB);
 await assert.rejects(readBounded(new Response(body),MiB),{code:'size_limit'});
 const failure=new DOMException('synthetic abort','AbortError');let cancelled=0;
 const response=new Response(new ReadableStream({pull(c){c.error(failure);},cancel(){cancelled++;}}));
 await assert.rejects(readBounded(response,MiB),error=>error===failure);
 assert.equal(response.body!.locked,false);assert.equal(cancelled,0);
});

test('real fetch handles HTTP chunked, Content-Length and compressed decoded byte limits',async()=>{
 const body=jsonBytes(MiB+1),large=jsonBytes(4*MiB+1);
 const server=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/length'){res.setHeader('Content-Length',body.length);res.end(body);}
  else if(req.url==='/gzip'){const compressed=gzipSync(large);res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',compressed.length);res.end(compressed);}
  else {res.write(body.subarray(0,32));res.end(body.subarray(32));}
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const address=server.address();assert.ok(address&&typeof address==='object');
  for(const path of ['/chunked','/length']){
   const api=new HttpSlackApi('synthetic',async():Promise<Response>=>fetch(`http://127.0.0.1:${address.port}${path}`));
   assert.equal((await api.call('files.info',{})).ok,true);
  }
  await assert.rejects(new HttpSlackApi('synthetic',async()=>fetch(`http://127.0.0.1:${address.port}/gzip`)).call('files.info',{}),error=>{
   const d=slackDiagnostics(error);assert.equal((error as {code:string}).code,'size_limit');
   assert.equal(d.responseBytesRead,large.length);assert.ok(d.responseContentLengthBytes!<MiB);return true;
  });
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('large files.info retains authorization evidence, denies invalid shares and preserves 20 MiB document cap',async()=>{
 const fake=new FakeApi();
 const check=async(patch:Record<string,unknown>)=>{
  const api=new HttpSlackApi('synthetic',async url=>{
   const method=new URL(String(url)).pathname.split('/').at(-1)!;
   if(method==='files.info')return Response.json({ok:true,file:{...file,preview:'x'.repeat(MiB),...patch}});
   return Response.json(fake.response(method as Parameters<FakeApi['response']>[0],{}));
  });
  return authorizeFile(api,config,actor,'FTEST');
 };
 assert.equal((await check({})).id,'FTEST');
 assert.equal((await check({size:20*MiB})).size,20*MiB);
 for(const patch of [{size:20*MiB+1},{shares:{}},{shares:{public:{CTEST:[{team_id:'TOTHER',ts:'123.456'}]}}},{has_more_shares:true},{is_restricted_sharing_enabled:true},{id:'FOTHER'}]){
  await assert.rejects(check(patch),{code:'access_denied'});
 }
});

test('large logical errors and malformed JSON remain failures with sanitized size diagnostics',async()=>{
 for(const body of [JSON.stringify({ok:false,error:'missing_scope',padding:'x'.repeat(MiB)}),'x'.repeat(MiB+1)]){
  await assert.rejects(new HttpSlackApi('synthetic',async()=>new Response(body)).call('files.info',{}));
 }
 const rows:Record<string,unknown>[]=[];
 const api=new HttpSlackApi(privateText,async()=>streamed(Buffer.from(privateText),{'content-length':String(4*MiB+1)}).response);
 await assert.rejects(traceTask({teamId:'TPRIVATE',cardId:privateText,kind:'event'},{signal:new AbortController().signal,checkpoint:async()=>{},attempt:1},()=>api.call('files.info',{file:'FPRIVATE'}),row=>rows.push(row)),{code:'size_limit'});
 const stage=rows.find(r=>r.event==='stage_finished')!;
 assert.equal(stage.stage,'slack_files_info');assert.equal(stage.httpStatus,200);assert.equal(stage.responseLimitBytes,4*MiB);
 assert.equal(stage.responseBytesRead,0);assert.equal(stage.responseContentLengthBytes,4*MiB+1);
 for(const secret of [privateText,'FPRIVATE','TPRIVATE'])assert.equal(JSON.stringify(rows).includes(secret),false);
});

test('size diagnostic allowlist rejects forged, negative, nonfinite and noninteger counts',()=>{
 const forged={responseBytesRead:privateText,responseLimitBytes:4*MiB};assert.deepEqual(slackDiagnostics(forged),{});
 for(const value of [-1,Infinity,NaN,1.5,'1',privateText]){
  const error=attachSlackDiagnostics(new Error(),200);
  attachResponseSizeDiagnostics(error,{responseBytesRead:value,responseLimitBytes:value,responseContentLengthBytes:value} as never);
  assert.deepEqual(slackDiagnostics(error),{httpStatus:200});
 }
 const error=attachSlackDiagnostics(new Error(),200);attachResponseSizeDiagnostics(error,{responseBytesRead:0,responseLimitBytes:MiB});
 const snapshot=slackDiagnostics(error);(snapshot as {responseLimitBytes:number}).responseLimitBytes=99;
 assert.equal(slackDiagnostics(error).responseLimitBytes,MiB);
});
