import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRulesHandler, type RulesInvoker} from '../../src/server/rules-api';
import {editorRoutes, type EditorDocuments, type EditorSaves} from '../../src/server/editor-routes';
import {UserError} from '../../src/server/errors';
import type {RulesReply} from '../../src/shared/rules';

const success:RulesReply={ok:true,operation:'status',tool:'get_service_info',checkedAt:'2026-10-28T00:00:00Z',data:{version:'synthetic'}};
async function serve(handle:ReturnType<typeof createRulesHandler>){
  const server=createServer((req,res)=>{void handle(req,res).catch(()=>res.writeHead(500).end());});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const a=server.address();assert.ok(a&&typeof a!=='string');
  return {url:`http://127.0.0.1:${a.port}`,close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))};
}
test('rules API rejects methods, non-JSON, malformed/oversized/unknown operations before MCP',async()=>{
  let calls=0;const api=await serve(createRulesHandler({call:async()=>{calls++;return success;}}));
  const post=(body:string,contentType='application/json')=>fetch(api.url,{method:'POST',headers:{'Content-Type':contentType},body});
  try{
    assert.equal((await fetch(api.url)).status,405);
    assert.equal((await post('{}','text/plain')).status,415);
    assert.equal((await post('{')).status,400);
    assert.equal((await post(JSON.stringify({operation:'exec',command:'sh'}))).status,400);
    assert.equal((await post(JSON.stringify({operation:'citations',text:'x'.repeat(20_001)}))).status,400);
    assert.equal((await post('x'.repeat(100_000))).status,413);
    assert.equal(calls,0);
    const reply=await post(JSON.stringify({operation:'status'}));
    assert.equal(reply.status,200);assert.equal(reply.headers.get('cache-control'),'no-store');assert.deepEqual(await reply.json(),success);assert.equal(calls,1);
  }finally{await api.close();}
});
test('rules API bounds concurrency, recovers capacity and hides unexpected transport errors',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls=0;
  const api=await serve(createRulesHandler({call:async()=>{calls++;await gate;return success;}}));
  const post=()=>fetch(api.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"operation":"status"}'});
  try{
    const a=post(),b=post();
    for(let n=0;calls<2&&n<100;n++)await new Promise(r=>setTimeout(r,5));
    assert.equal(calls,2);assert.equal((await post()).status,429);
    release();assert.equal((await a).status,200);assert.equal((await b).status,200);assert.equal((await post()).status,200);
  }finally{release();await api.close();}
  const failing=await serve(createRulesHandler({call:async()=>{throw Error('Bearer synthetic-secret /private/path');}}));
  try{
    const reply=await fetch(failing.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"operation":"status"}'});
    assert.equal(reply.status,502);assert.doesNotMatch(await reply.text(),/synthetic-secret|private\/path/);
  }finally{await failing.close();}
});
test('Slack rules lookup requires allowed origin, current session and document access before and after MCP',async()=>{
  let permitted=true,validSession=true,calls=0,checks=0;
  const session={cardId:'synthetic-card',actor:{teamId:'TTEST',userId:'UTEST',channelId:'CTEST'}};
  const documents={sessions:{require:async(token:string)=>{if(!validSession||token!=='s'.repeat(43))throw new UserError('session_expired','expired');return session;}},authorize:async()=>{checks++;if(!permitted)throw new UserError('access_denied','denied');return {};}} as unknown as EditorDocuments;
  let duringCall=()=>{};
  const service:RulesInvoker={call:async()=>{calls++;duringCall();return success;}};
  const handler=editorRoutes('https://api.example.test',documents,{} as EditorSaves,'https://editor.example.test',false,service);
  const server=createServer((req,res)=>{void handler(req,res,()=>res.writeHead(404).end());});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const a=server.address();assert.ok(a&&typeof a!=='string');
  const url=`http://127.0.0.1:${a.port}/api/editor/rules`;
  const post=(origin:string|undefined='https://editor.example.test',token='s'.repeat(43))=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{}),Authorization:'Bearer '+token},body:'{"operation":"status"}'});
  try{
    assert.equal((await post('https://evil.example')).status,403);
    assert.equal((await post('')).status,403);
    assert.equal((await post(undefined,'bad')).status,403);assert.equal(calls,0);
    permitted=false;assert.equal((await post()).status,403);assert.equal(calls,0);
    permitted=true;const reply=await post();assert.equal(reply.status,200);assert.deepEqual(await reply.json(),success);assert.ok(checks>=3);
    duringCall=()=>{permitted=false;};assert.equal((await post()).status,403);assert.equal(calls,2);
    permitted=true;duringCall=()=>{validSession=false;};assert.equal((await post()).status,403);assert.equal(calls,3);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('disconnected requests cancel the service and recover capacity after transport cleanup',async()=>{
  let calls=0,aborted=0;
  let started!:()=>void,cancelled!:()=>void,cleanup!:()=>void;
  const bothStarted=new Promise<void>(resolve=>started=resolve);
  const bothCancelled=new Promise<void>(resolve=>cancelled=resolve);
  const cleanupGate=new Promise<void>(resolve=>cleanup=resolve);
  const api=await serve(createRulesHandler({call:async(_request,signal)=>{
    calls++;
    if(calls>2)return success;
    assert.ok(signal);
    if(calls===2)started();
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{
      if(++aborted===2)cancelled();
      void cleanupGate.then(resolve);
    },{once:true}));
    return success;
  }}));
  const controllers=[new AbortController(),new AbortController()];
  const post=(signal?:AbortSignal)=>fetch(api.url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"operation":"status"}',signal});
  const pending=controllers.map(controller=>post(controller.signal).catch(()=>undefined));
  try{
    await bothStarted;
    for(const controller of controllers)controller.abort();
    await bothCancelled;
    assert.equal((await post()).status,429,'capacity must remain reserved while upstream cleanup is pending');
    cleanup();
    await Promise.all(pending);
    assert.equal((await post()).status,200,'cancelled lookups must not block the next request until the MCP timeout');
    assert.equal(calls,3);
    assert.equal(aborted,2);
  }finally{
    for(const controller of controllers)controller.abort();
    cleanup();await Promise.all(pending);await api.close();
  }
});

test('malformed raw request targets return a safe error without stopping the local desk server',{timeout:10_000},async()=>{
  const probe=createServer();
  await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const address=probe.address();assert.ok(address&&typeof address==='object');
  const port=address.port;
  await new Promise<void>(resolve=>probe.close(()=>resolve()));
  const child=spawn(process.execPath,['--import','tsx','scripts/serve-desk.mjs'],{
    env:{PATH:process.env.PATH,PORT:String(port)},stdio:['ignore','pipe','pipe'],
  });
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const exited=once(child,'exit');
  try{
    await Promise.race([once(child.stdout,'data'),exited.then(()=>{throw new Error('Synthetic local server failed to start');})]);
    const response=await new Promise<string>((resolve,reject)=>{
      const socket=connect(port,'127.0.0.1');let received='';
      socket.setTimeout(3000,()=>socket.destroy(new Error('Synthetic raw request timed out')));
      socket.on('error',reject);
      socket.on('data',chunk=>received+=chunk);
      socket.on('end',()=>resolve(received));
      socket.on('connect',()=>socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    });
    assert.match(response,/^HTTP\/1\.1 400 /);
    assert.doesNotMatch(response,/ERR_INVALID_URL|TypeError|serve-desk\.mjs/);
    assert.equal(child.exitCode,null);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`,{redirect:'manual'})).status,302);
    assert.equal(stderr,'');
  }finally{child.kill();await exited;}
});
