import test from 'node:test';
import assert from 'node:assert/strict';
import {errorDiagnostics,validatedDiagnostics,restoreDiagnostics} from '../../src/server/cloud/error-diagnostics.ts';
import {errorCode,cloudTrace,traceTask,measured,traceDelivery,bindDelivery,bindLogicalTask,deliveryFailure,taskStateFinished,terminalNoticeResult} from '../../src/server/cloud/telemetry.ts';

const secret='xoxb-private private-document.hwp https://private.invalid/?token=private';
const frame='    at privateFunction (/app/src/server/cloud/events.ts:52:11)';
test('exception diagnostics keep only fixed schema values and known bounded source/bundle locations',()=>{
  const error=Object.assign(new TypeError(secret),{name:secret,code:secret,cause:{message:secret},headers:{authorization:secret},body:secret});
  error.stack=[secret+': '+secret,frame,'    at privateFunction (/app/dist/cloud/distributed.cjs:200:9)',
    '    at privateFunction (/files/private-document.hwp:1:2)','    at https://private.invalid/src/server/cloud/events.ts:3:4',
    '    at /app/../src/server/cloud/events.ts:3:4','    at /app/src/server/cloud/events.ts?token=private:3:4',
    ...Array(8).fill(frame)].join('\n');
  const safe=errorDiagnostics(error,'stage_failure');
  assert.equal(safe.exceptionType,'TypeError');assert.equal(safe.stackFrames.length,5);
  assert.deepEqual(safe.stackFrames[0],{file:'src/server/cloud/events.ts',line:52,column:11});
  assert.deepEqual(safe.stackFrames[1],{file:'dist/cloud/distributed.cjs',line:200,column:9});
  assert.match(safe.errorId,/^[0-9a-f-]{36}$/);assert.match(safe.fingerprint,/^[0-9a-f]{64}$/);
  for(const value of [secret,'privateFunction','private.invalid','private-document','cause','headers'])assert.equal(JSON.stringify(safe).includes(value),false);
  safe.stackFrames[0].file=secret;
  assert.equal(errorDiagnostics(error,'task_failure').stackFrames[0].file,'src/server/cloud/events.ts');
  assert.equal(errorDiagnostics(error,'worker_delivery').errorId,safe.errorId);
});
test('arbitrary getters, proxies, names, causes and oversized stacks cannot break error reporting',()=>{
  let getterCalls=0;const hostile=new Error(secret);
  for(const key of ['name','code','stack'])Object.defineProperty(hostile,key,{get(){getterCalls++;throw new Error(secret);}});
  const proxy=new Proxy({}, {get(){throw new Error(secret);},getPrototypeOf(){throw new Error(secret);},getOwnPropertyDescriptor(){throw new Error(secret);}});
  const cyclic={};cyclic.cause=cyclic;
  for(const value of [undefined,null,secret,42,cyclic,proxy,hostile]){
    assert.doesNotThrow(()=>errorDiagnostics(value));
    assert.doesNotThrow(()=>errorCode(value));
    assert.equal(JSON.stringify(errorDiagnostics(value)).includes(secret),false);
  }
  const long=new Error(secret);long.stack=secret+'\n'+frame.repeat(2000);assert.deepEqual(errorDiagnostics(long).stackFrames,[]);
  const native=new Error(secret);assert.ok(Array.isArray(errorDiagnostics(native).stackFrames));
  assert.ok(getterCalls<10);
  const injected=new Error(secret+'\n    at /app/src/server/cloud/tasks.ts:999999:999999');
  assert.equal(errorDiagnostics(injected).stackFrames.some(frame=>frame.line===999999),false);
  class InheritedName extends Error {}
  InheritedName.prototype.name=secret+'\n    at /app/src/server/cloud/tasks.ts:999999:999999';
  assert.equal(errorDiagnostics(new InheritedName(secret)).stackFrames.some(frame=>frame.line===999999),false);
  const changed=new Error(secret+'\n    at /app/src/server/cloud/tasks.ts:999999:999999');
  void changed.stack;changed.message='changed';assert.deepEqual(errorDiagnostics(changed).stackFrames,[]);
  assert.doesNotThrow(()=>taskStateFinished('a'.repeat(64),{kind:'event',cardId:null},1,'done'));
  assert.doesNotThrow(()=>taskStateFinished('a'.repeat(64),new Proxy({},{get(){throw new Error(secret);}}),1,'done'));
});
test('persisted error snapshots are validated and do not replace original location with terminal reconstruction',()=>{
  const source=new Error(secret);source.stack='Error: '+secret+'\n'+frame;
  const safe=errorDiagnostics(source,'task_failure'),stored=JSON.parse(JSON.stringify({...safe,message:secret}));
  const rebuilt=new Error('Durable task failed');restoreDiagnostics(rebuilt,stored);
  const result=errorDiagnostics(rebuilt,'terminal_failure');
  assert.equal(result.errorId,safe.errorId);assert.equal(result.fingerprint,safe.fingerprint);assert.deepEqual(result.stackFrames,safe.stackFrames);
  for(const bad of [{...safe,fingerprint:'0'.repeat(64)},{...safe,errorId:secret},{...safe,exceptionType:secret},
    {...safe,stackFrames:[{file:secret,line:1,column:2}]},{...safe,stackFrames:[{file:'src/server/cloud/events.ts',line:-1,column:2}]},
    {...safe,stackFrames:Array(6).fill(safe.stackFrames[0])}]){
    assert.equal(validatedDiagnostics(bad),undefined);
  }
});
test('cloud trace context accepts only fixed project and exact trace/span syntax',()=>{
  const header='a'.repeat(32)+'/18446744073709551615;o=1';
  assert.deepEqual(cloudTrace(header,'synthetic-project'),{'logging.googleapis.com/trace':'projects/synthetic-project/traces/'+'a'.repeat(32)});
  for(const value of [secret,[header],header+'\n',header+'x','0'.repeat(32)+'/1', 'a'.repeat(32)+'/18446744073709551616','a'.repeat(32)+'/1;o=2','a'.repeat(200)+'/1']){
    assert.deepEqual(cloudTrace(value,'synthetic-project'),{});
  }
  assert.deepEqual(cloudTrace(header,'projects/private/traces/secret'),{});
});
test('same exception keeps identity across stage, task and delivery without leaking overlapping requests',async()=>{
  const run=async(id)=>{
    const rows=[],error=new Error(secret);error.stack='Error: '+secret+'\n'+frame;
    await traceDelivery(undefined,async()=>{
      bindDelivery(id);
      try{await traceTask({teamId:'TPRIVATE',cardId:secret,kind:'event'},{id,attempt:1,signal:new AbortController().signal,checkpoint:async()=>{}},()=>measured('download',async()=>{await new Promise(r=>setTimeout(r,5));throw error;}),r=>rows.push(r));}
      catch(failure){deliveryFailure(failure);}
    },()=>503,r=>rows.push(r));
    const failures=rows.filter(r=>r.errorId);assert.equal(new Set(failures.map(r=>r.errorId)).size,1);
    assert.equal(new Set(failures.map(r=>r.fingerprint)).size,1);assert.ok(rows.filter(r=>r.deliveryId).every(r=>r.deliveryId===id));
    assert.equal(JSON.stringify(rows).includes(secret),false);return rows;
  };
  const [a,b]=await Promise.all([run('a'.repeat(64)),run('b'.repeat(64))]);
  assert.notEqual(a.at(-1).runId,b.at(-1).runId);
  await traceDelivery(undefined,async()=>{},()=>204,()=>{throw new Error(secret);});
});
test('terminal notice reservations do not overwrite business attempt numbering',async()=>{
  const rows=[];
  await traceDelivery(undefined,async()=>{
    bindLogicalTask('a'.repeat(64),3);
    terminalNoticeResult('a'.repeat(64),'sent',1);
  },()=>204,r=>rows.push(r));
  const notice=rows.find(row=>row.event==='terminal_notice_finished');
  assert.equal(notice.noticeAttempt,1);assert.equal(notice.attempt,3);
});
