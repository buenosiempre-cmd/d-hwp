import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpSlackApi} from '../../src/server/slack-api';
import {UserError} from '../../src/server/errors';
import {attachSlackDiagnostics,slackDiagnostics} from '../../src/server/slack-diagnostics';
import {traceTask,traceEditor,terminalTaskFailure} from '../../src/server/cloud/telemetry';
const spec={teamId:'TPRIVATE',cardId:'private-card',kind:'event' as const};
const context={signal:new AbortController().signal,checkpoint:async()=>{},id:'a'.repeat(64),attempt:2};
const secret='xoxb-secret private-document.hwp https://files.slack.com/private?ticket=private';

test('additional fixed chat.update diagnoses preserve logical rejection, single write attempt and private response filtering',async()=>{
 for(const code of ['file_share_limit_reached','max_file_sharing_exceeded','posting_to_channel_denied','blocked_file_type','invalid_arguments','too_many_attachments','update_failed','slack_connect_file_upload_sharing_blocked']){
  let calls=0;const records:Record<string,unknown>[]=[];
  const api=new HttpSlackApi('xoxb-secret',async()=>{calls++;return Response.json({ok:false,error:code,response_metadata:{messages:[secret]}});});
  await assert.rejects(traceTask(spec,context,()=>api.call('chat.update',{channel:'CPRIVATE',ts:'100.002',text:secret}),r=>records.push(r)),{code:'slack_rejected'});
  assert.equal(calls,1);assert.equal(records.find(r=>r.event==='stage_finished')?.slackError,code);assert.equal(records.at(-1)?.slackError,code);assert.equal(records.at(-1)?.httpStatus,200);
  for(const value of [secret,'CPRIVATE','100.002','TPRIVATE','private-card'])assert.equal(JSON.stringify(records).includes(value),false);
 }
});

test('Slack logical errors retain existing behavior and expose only fixed error codes',async()=>{
 for(const code of ['file_not_found','file_deleted','not_visible','access_denied','missing_scope','no_permission','invalid_auth','not_authed','token_revoked','token_expired','account_inactive','ratelimited','internal_error','fatal_error','service_unavailable','already_reacted','no_reaction']){
  const records:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-secret',async()=>new Response(JSON.stringify({ok:false,error:code,response_metadata:{messages:[secret]}})));
  await assert.rejects(traceTask(spec,context,()=>api.call('files.info',{file:'FPRIVATE'}),r=>records.push(r)),{code:['already_reacted','no_reaction'].includes(code)?code:'slack_rejected'});
  assert.equal(records.find(r=>r.event==='stage_finished')?.slackError,code);
  assert.equal(records.at(-1)?.slackError,code);assert.equal(records.at(-1)?.httpStatus,200);
  for(const value of ['xoxb-secret','FPRIVATE','TPRIVATE','private-card','private-document','ticket='])assert.equal(JSON.stringify(records).includes(value),false);
 }
});
test('unknown, absent and malformed Slack error values normalize without exposing response contents',async()=>{
 for(const code of [secret,undefined,null,42,{message:secret},[secret]]){
  const records:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-secret',async()=>new Response(JSON.stringify({ok:false,error:code})));
  await assert.rejects(traceEditor('source',()=>api.call('files.info',{file:'FPRIVATE'}),()=>403,r=>records.push(r)),{code:'slack_rejected'});
  assert.equal(records.at(-1)?.slackError,'unknown');assert.equal(records.at(-1)?.httpStatus,200);
  assert.equal(records.at(-1)?.statusCode,403);assert.equal(JSON.stringify(records).includes(secret),false);
 }
});
test('untrusted exception properties are ignored and diagnostic snapshots cannot mutate trusted values',()=>{
 let read=false;const spoof={get slackError(){read=true;throw new Error(secret);},get httpStatus(){read=true;throw new Error(secret);}};
 assert.deepEqual(slackDiagnostics(spoof),{});assert.equal(read,false);
 const error=attachSlackDiagnostics(new UserError('slack_rejected','message'),200,'file_not_found');
 const snapshot=slackDiagnostics(error);(snapshot as {slackError?:string}).slackError=secret;
 assert.deepEqual(slackDiagnostics(error),{httpStatus:200,slackError:'file_not_found'});
 for(const status of [NaN,Infinity,99,600,200.5,'200',secret])assert.deepEqual(slackDiagnostics(attachSlackDiagnostics(new Error(),status,secret)),{slackError:'unknown'});
});
test('HTTP 5xx preserves three read attempts and reports status without parsing arbitrary response bodies',async()=>{
 let calls=0;const rows:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-secret',async()=>{calls++;return new Response(secret,{status:503});});
 await assert.rejects(traceTask(spec,context,()=>api.call('files.info',{file:'FPRIVATE'}),r=>rows.push(r)),{code:'slack_unavailable'});
 assert.equal(calls,3);assert.equal(rows.at(-1)?.httpStatus,503);assert.equal(rows.at(-1)?.slackError,undefined);assert.equal(JSON.stringify(rows).includes(secret),false);
});
test('HTTP 429 retry behavior is unchanged and invalid Retry-After remains rate_limited',async()=>{
 let calls=0;const rows:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-secret',async()=>{calls++;return new Response(secret,{status:429,headers:{'Retry-After':'0.001'}});});
 await assert.rejects(traceTask(spec,context,()=>api.call('files.info',{file:'FPRIVATE'}),r=>rows.push(r)),{code:'slack_unavailable'});
 assert.equal(calls,3);assert.equal(rows.at(-1)?.httpStatus,429);
 const invalid=new HttpSlackApi('xoxb-secret',async()=>new Response(secret,{status:429,headers:{'Retry-After':secret}}));
 await assert.rejects(invalid.call('files.info',{}),error=>{assert.equal((error as UserError).code,'rate_limited');assert.deepEqual(slackDiagnostics(error),{httpStatus:429});return true;});
});
test('successful retry and transport failure do not fabricate Slack logical error diagnoses',async()=>{
 let calls=0;const rows:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-secret',async()=>++calls===1?new Response(secret,{status:429,headers:{'Retry-After':'0.001'}}):new Response(JSON.stringify({ok:true,file:{name:secret}})));
 const result=await traceTask(spec,context,()=>api.call('files.info',{file:'FPRIVATE'}),r=>rows.push(r));
 assert.equal((result.file as {name:string}).name,secret);assert.equal(calls,2);assert.equal(rows.at(-1)?.ok,true);
 assert.equal(rows.some(r=>'slackError' in r||'httpStatus' in r),false);assert.equal(JSON.stringify(rows).includes(secret),false);
 const failure=new HttpSlackApi('xoxb-secret',async()=>{throw Object.assign(new Error(secret),{slackError:secret,httpStatus:secret});});
 await assert.rejects(traceTask(spec,context,()=>failure.call('files.info',{}),r=>rows.push(r)));
 assert.equal(rows.at(-1)?.errorCode,'internal');assert.equal(rows.at(-1)?.httpStatus,undefined);assert.equal(rows.at(-1)?.slackError,undefined);
});
test('standalone terminal logger validates fields, strips identifiers and tolerates unavailable sinks',()=>{
 const records:Record<string,unknown>[]=[],error=attachSlackDiagnostics(new UserError('slack_rejected',secret),200,'file_not_found');
 terminalTaskFailure('a'.repeat(64),spec,3,error,r=>records.push(r));
 assert.equal(records[0]?.event,'task_terminal_failed');assert.equal(records[0]?.slackError,'file_not_found');assert.equal(records[0]?.httpStatus,200);
 assert.equal((records[0]?.cardKey as string).length,64);
 for(const value of ['xoxb-secret','TPRIVATE','private-card','private-document'])assert.equal(JSON.stringify(records).includes(value),false);
 for(const attempt of [-1,NaN,Infinity,1.5])terminalTaskFailure('a'.repeat(64),spec,attempt,error,r=>records.push(r));
 terminalTaskFailure(secret,spec,3,error,r=>records.push(r));assert.equal(records.length,1);
 assert.doesNotThrow(()=>terminalTaskFailure('a'.repeat(64),spec,3,error,()=>{throw new Error(secret);}));
});

test('malformed successful HTTP responses retain status without logging parse errors or response data',async()=>{
 for(const [body,code] of [[secret,'internal'],['null','access_denied']] as const){
  const rows:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-secret',async()=>new Response(body));
  await assert.rejects(traceTask(spec,context,()=>api.call('files.info',{}),r=>rows.push(r)));
  assert.equal(rows.at(-1)?.errorCode,code);assert.equal(rows.at(-1)?.httpStatus,200);assert.equal(rows.at(-1)?.slackError,undefined);
  assert.equal(JSON.stringify(rows).includes(secret),false);
 }
});

test('overlapping Slack failures keep each trace diagnosis while failing sinks cannot replace errors',async()=>{
 const missing:Record<string,unknown>[]=[],scope:Record<string,unknown>[]=[];
 const first=new HttpSlackApi('xoxb-secret',async()=>{await new Promise(r=>setTimeout(r,5));return new Response(JSON.stringify({ok:false,error:'file_not_found'}));});
 const second=new HttpSlackApi('xoxb-secret',async()=>new Response(JSON.stringify({ok:false,error:'missing_scope'})));
 await Promise.all([
  assert.rejects(traceTask(spec,context,()=>first.call('files.info',{}),r=>missing.push(r))),
  assert.rejects(traceTask(spec,{...context,id:'b'.repeat(64)},()=>second.call('files.info',{}),r=>scope.push(r))),
 ]);
 assert.equal(missing.at(-1)?.slackError,'file_not_found');assert.equal(scope.at(-1)?.slackError,'missing_scope');
 assert.ok(missing.every(r=>r.taskId==='a'.repeat(64)));assert.ok(scope.every(r=>r.taskId==='b'.repeat(64)));
 await assert.rejects(traceTask(spec,context,()=>second.call('files.info',{}),()=>{throw new Error(secret);}),error=>{
  assert.equal((error as UserError).code,'slack_rejected');assert.equal(slackDiagnostics(error).slackError,'missing_scope');return true;
 });
});
