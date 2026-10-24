import test from 'node:test';
import assert from 'node:assert/strict';
import {Uploads,type ShareCheck} from '../../src/server/uploads';
import {shareCheckFinished,traceTask} from '../../src/server/cloud/telemetry';
import {HttpSlackApi} from '../../src/server/slack-api';
import {slackDiagnostics} from '../../src/server/slack-diagnostics';
import type {Actor} from '../../src/server/access';
import {actor,config} from './support';
const expectedTs='100.002',threadTs='100.001';
const good={team_id:actor.teamId,ts:expectedTs,thread_ts:threadTs};
const spec={teamId:'TTEST',cardId:'synthetic-private-card',kind:'preview' as const};
const context={signal:new AbortController().signal,checkpoint:async()=>{},id:'a'.repeat(64),attempt:2};
const secret='xoxb-synthetic-secret private-document.hwp https://private.example.com?ticket=secret FPRIVATE TPRIVATE CPRIVATE UPRIVATE';
function response(records:unknown,extra:Record<string,unknown>={}){return {ok:true,file:{id:'FTEST',shares:{private:{[actor.channelId]:records}},...extra}};}
function uploads(result:Record<string,unknown>,counts:{calls:number}){
 return new Uploads({async call(){counts.calls++;return result;}},config);
}
test('fixed reasons summarize the same single share query and preserve expected-message and thread matching',async()=>{
 const cases:[unknown[],ShareCheck['shareReason'],number|undefined][]=[
  [[good],'confirmed',1],[[],'shares_missing',0],[[{...good,team_id:'TOTHER'}],'team_mismatch',0],
  [[{...good,ts:'invalid'}],'timestamp_invalid',0],[[{...good,ts:'100.003'}],'message_mismatch',0],
  [[{...good,thread_ts:'100.004'}],'thread_mismatch',0],[[good,good],'ambiguous',2],
  [[{...good,team_id:'TOTHER'},{...good,ts:'100.003'},{...good,thread_ts:'100.004'}],'thread_mismatch',0],
 ];
 for(const [records,reason,matches] of cases){
  const checks:ShareCheck[]=[],calls={calls:0},u=uploads(response(records),calls);
  const result=await u.sharedMessage('FTEST',{...actor,threadTs},expectedTs,c=>checks.push(c));
  assert.equal(result,reason==='confirmed'?expectedTs:undefined);assert.equal(calls.calls,1);assert.equal(checks.length,1);
  assert.equal(checks[0].shareReason,reason);assert.equal(checks[0].shareRecords,records.length);assert.equal(checks[0].shareThreadMatches,matches);
  assert.ok(Object.isFrozen(checks[0]));
 }
});
test('public selection, private fallback, optional expected message and top-level rules are unchanged',async()=>{
 const cases:[Record<string,unknown>,Actor,string|undefined,string|undefined][]=[
  [response(undefined,{shares:{public:{[actor.channelId]:[]},private:{[actor.channelId]:[good]}}}),{...actor,threadTs},expectedTs,undefined],
  [response([good],{shares:{public:{[actor.channelId]:[good]},private:{[actor.channelId]:[]}}}),{...actor,threadTs},expectedTs,expectedTs],
  [response([good]),{...actor,threadTs},undefined,expectedTs],
  [response([{team_id:actor.teamId,ts:expectedTs}]),actor,expectedTs,expectedTs],
  [response([good]),actor,expectedTs,undefined],
 ];
 for(const [result,a,expected,want] of cases){
  const calls={calls:0};assert.equal(await uploads(result,calls).sharedMessage('FTEST',a,expected),want);assert.equal(calls.calls,1);
 }
});
test('file mismatch and missing shares omit unknown counts while malformed responses keep the original denial',async()=>{
 for(const [result,reason] of [[response([good],{id:'FOTHER'}),'file_mismatch'],[response(undefined),'shares_missing']] as const){
  const calls={calls:0},checks:ShareCheck[]=[];
  assert.equal(await uploads(result,calls).sharedMessage('FTEST',{...actor,threadTs},expectedTs,c=>checks.push(c)),undefined);
  assert.equal(checks[0].shareReason,reason);assert.equal(checks[0].shareRecords,undefined);assert.equal(checks[0].shareTeamMatches,undefined);assert.equal(calls.calls,1);
 }
 for(const result of [{ok:true,file:null},response([null]),response([good],{shares:null}),response([good],{shares:{public:[]}})]){
  const calls={calls:0},checks:ShareCheck[]=[];
  await assert.rejects(uploads(result,calls).sharedMessage('FTEST',{...actor,threadTs},expectedTs,c=>checks.push(c)),{code:'access_denied'});
  assert.equal(checks[0].shareReason,'invalid_response');assert.equal(checks[0].shareTeamMatches,undefined);assert.equal(calls.calls,1);
 }
});
test('Slack query failures keep their original identity and trusted diagnostics and observe api_error once',async()=>{
 const checks:ShareCheck[]=[],rows:Record<string,unknown>[]=[],api=new HttpSlackApi('xoxb-synthetic-secret',async()=>Response.json({ok:false,error:'missing_scope',private:secret}));
 await assert.rejects(traceTask(spec,context,()=>new Uploads(api,config).sharedMessage('FTEST',actor,expectedTs,c=>{checks.push(c);shareCheckFinished(c,'pdf',1);}),r=>rows.push(r)),error=>{
  assert.deepEqual(slackDiagnostics(error),{httpStatus:200,slackError:'missing_scope'});return true;
 });
 assert.deepEqual(checks,[{shareReason:'api_error'}]);assert.equal(rows.filter(r=>r.event==='share_check_finished').length,1);
 assert.equal(rows.find(r=>r.event==='share_check_finished')?.shareReason,'api_error');assert.equal(JSON.stringify(rows).includes(secret),false);
 const error=new Error(secret);let calls=0;
 await assert.rejects(new Uploads({async call(){calls++;throw error;}},config).sharedMessage('FTEST',actor,expectedTs,()=>{throw new Error('observer');}),e=>e===error);
 assert.equal(calls,1);
});
test('throwing observers cannot replace successful results, inconclusive shares or malformed-response denials',async()=>{
 const observer=()=>{throw new Error(secret);};
 for(const [records,result] of [[[good],expectedTs],[[],undefined]] as const){
  const calls={calls:0};assert.equal(await uploads(response(records),calls).sharedMessage('FTEST',{...actor,threadTs},expectedTs,observer),result);assert.equal(calls.calls,1);
 }
 const calls={calls:0};await assert.rejects(uploads(response([null]),calls).sharedMessage('FTEST',actor,expectedTs,observer),{code:'access_denied'});assert.equal(calls.calls,1);
});
test('capped observations use all candidates for ambiguity and never truncate the sharing decision',async()=>{
 for(const records of [Array(1001).fill(good),[...Array(1001).fill({...good,team_id:'TOTHER'}),good]]){
  const calls={calls:0},rows:Record<string,unknown>[]=[];
  const result=await traceTask(spec,context,()=>uploads(response(records),calls).sharedMessage('FTEST',{...actor,threadTs},expectedTs,c=>shareCheckFinished(c,'png',6)),r=>rows.push(r));
  assert.equal(result,records.length===1002?expectedTs:undefined);assert.equal(calls.calls,1);
  const row=rows.find(r=>r.event==='share_check_finished')!;assert.equal(row.shareRecords,1000);assert.equal(row.shareCountsCapped,true);
  assert.equal(row.shareReason,records.length===1002?'confirmed':'ambiguous');assert.equal(row.shareThreadMatches,records.length===1002?1:1000);
 }
});
test('telemetry accepts only fixed enums and safe integers, caps counts and omits unknown or malformed values',async()=>{
 const rows:Record<string,unknown>[]=[];
 await traceTask(spec,context,async()=>{
  for(const count of [0,1000,1001,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1000',null,undefined]){
   shareCheckFinished({shareReason:'confirmed',shareRecords:count,shareTeamMatches:count,shareCountsCapped:true,rawResponse:secret},'png',2);
  }
  for(const attempt of [undefined,0,7,1.5,NaN,Infinity,'1',secret])shareCheckFinished({shareReason:'shares_missing'},'source',attempt);
  for(const role of ['pdf','png','source','other'])shareCheckFinished({shareReason:'api_error'},role,6);
  for(const check of [null,[],secret,{shareReason:secret},{shareReason:42}])shareCheckFinished(check,'pdf',1);
  for(const role of [secret,undefined,42])shareCheckFinished({shareReason:'confirmed'},role,1);
  shareCheckFinished({get shareReason(){throw new Error(secret);}},'pdf',1);
 },r=>rows.push(r));
 const observations=rows.filter(r=>r.event==='share_check_finished');assert.equal(observations.length,23);
 assert.deepEqual(observations.slice(0,3).map(r=>[r.shareRecords,r.shareCountsCapped]),[[0,false],[1000,false],[1000,true]]);
 assert.ok(observations.slice(3,11).every(r=>!('shareRecords' in r)&&!('shareTeamMatches' in r)&&r.shareCountsCapped===false));
 assert.ok(observations.slice(11,19).every(r=>!('shareCheckAttempt' in r)&&!('shareRecords' in r)));
 assert.deepEqual(observations.slice(19).map(r=>r.shareRole),['pdf','png','source','other']);
 assert.equal(JSON.stringify(rows).includes(secret),false);
});
test('forged observation fields, response data and synthetic identifiers cannot enter the trace',async()=>{
 const rows:Record<string,unknown>[]=[],calls={calls:0};
 await traceTask(spec,context,async()=>{
  shareCheckFinished({shareReason:'confirmed',shareRecords:1,rawResponse:secret,rawError:secret,filename:secret,documentText:secret,userId:secret,teamId:secret,channelId:secret,fileId:secret,messageTs:secret,threadTs:secret,url:secret,token:secret,credential:secret,taskId:secret,cardKey:secret,event:secret},'other',1);
  const result=response([{...good,private:secret}],{name:secret,permalink:secret,token:secret});
  assert.equal(await uploads(result,calls).sharedMessage('FTEST',{...actor,threadTs},expectedTs,c=>shareCheckFinished(c,'png',1)),expectedTs);
 },r=>rows.push(r));
 const observations=rows.filter(r=>r.event==='share_check_finished');assert.equal(observations.length,2);assert.equal(calls.calls,1);
 const allowed=new Set(['runtimeId','runId','kind','cardKey','taskId','attempt','elapsedMs','event','shareReason','shareRole','shareCheckAttempt','shareRecords','shareTeamMatches','shareValidTsMatches','shareMessageMatches','shareThreadMatches','shareCountsCapped']);
 assert.ok(observations.every(r=>Object.keys(r).every(k=>allowed.has(k))));
 for(const value of [secret,'synthetic-private-card','TTEST','FTEST',expectedTs,threadTs])assert.equal(JSON.stringify(rows).includes(value),false);
});
test('overlapping share observations keep their own trace and failing sinks preserve return values and errors',async()=>{
 const first:Record<string,unknown>[]=[],second:Record<string,unknown>[]=[];
 await Promise.all([
  traceTask(spec,context,async()=>{await new Promise(r=>setTimeout(r,5));shareCheckFinished({shareReason:'confirmed'},'pdf',1);},r=>first.push(r)),
  traceTask(spec,{...context,id:'b'.repeat(64)},async()=>{shareCheckFinished({shareReason:'shares_missing'},'png',2);},r=>second.push(r)),
 ]);
 assert.ok(first.every(r=>r.taskId===context.id));assert.ok(second.every(r=>r.taskId==='b'.repeat(64)));
 assert.equal(first.find(r=>r.event==='share_check_finished')?.shareReason,'confirmed');assert.equal(second.find(r=>r.event==='share_check_finished')?.shareReason,'shares_missing');
 const calls={calls:0};
 assert.equal(await traceTask(spec,context,()=>uploads(response([good]),calls).sharedMessage('FTEST',{...actor,threadTs},expectedTs,c=>shareCheckFinished(c,'pdf',1)),()=>{throw new Error(secret);}),expectedTs);
 await assert.rejects(traceTask(spec,context,()=>uploads(response([null]),calls).sharedMessage('FTEST',actor,expectedTs,c=>shareCheckFinished(c,'pdf',1)),()=>{throw new Error(secret);}),{code:'access_denied'});
 shareCheckFinished({shareReason:'confirmed'},'png',1);assert.equal(calls.calls,2);
});
