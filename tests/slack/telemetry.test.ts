import test from 'node:test';
import assert from 'node:assert/strict';
import {traceTask,traceEditor,measured,milestone,errorCode,conversionMetric,terminalNoticeResult} from '../../src/server/cloud/telemetry';
import {HttpSlackApi} from '../../src/server/slack-api';
import {FirestoreMetadata} from '../../src/server/cloud/firestore-metadata';
import type {Firestore} from '@google-cloud/firestore';
import {validMetric} from '../../src/conversion/convert.mjs';
import {UserError} from '../../src/server/errors';
const context={signal:new AbortController().signal,async checkpoint(){},id:'a'.repeat(64),attempt:2};
const spec={teamId:'TTEST',cardId:'private-card-name',kind:'preview' as const};
test('terminal delivery telemetry validates status and budget without exposing arbitrary error fields',async()=>{
 const rows:Record<string,unknown>[]=[],secret='xoxb-secret private-document https://private.example.com';
 terminalNoticeResult(context.id,'failed',1,Object.assign(new Error(secret),{slackError:secret}),r=>rows.push(r));
 assert.equal(rows[0]?.event,'terminal_notice_finished');assert.equal(rows[0]?.errorCode,'internal');assert.doesNotMatch(JSON.stringify(rows),/xoxb-|private-document|private.example/);
 for(const attempt of [-1,4,NaN,Infinity,1.5])terminalNoticeResult(context.id,'failed',attempt,undefined,r=>rows.push(r));
 terminalNoticeResult(secret,'sent',1,undefined,r=>rows.push(r));terminalNoticeResult(context.id,secret as any,1,undefined,r=>rows.push(r));assert.equal(rows.length,1);
 assert.doesNotThrow(()=>terminalNoticeResult(context.id,'sent',1,undefined,()=>{throw new Error(secret);}));
 await traceTask(spec,{...context,terminalNotice:{phase:'bookkeeping'}},async()=>{},r=>rows.push(r));
 assert.equal(rows.at(-1)?.terminalPhase,'bookkeeping');
});
test('stage failures keep numeric timings and error codes without logging exception contents or document identifiers',async()=>{
 const rows:Record<string,unknown>[]=[];
 await assert.rejects(traceTask(spec,context,()=>measured('download',async()=>{throw new UserError('slack_unavailable','xoxb-secret https://files.slack.com/private document name');}),r=>rows.push(r)));
 const serialized=JSON.stringify(rows);for(const secret of ['xoxb-secret','files.slack.com','document name','private-card-name','TTEST'])assert.equal(serialized.includes(secret),false);
 assert.equal(rows.find(r=>r.event==='stage_finished')?.errorCode,'slack_unavailable');
 assert.equal(rows.at(-1)?.ok,false);assert.equal(rows.at(-1)?.attempt,2);assert.equal(rows.at(-1)?.taskId,'a'.repeat(64));
 assert.ok(rows.every(r=>typeof r.elapsedMs==='number'));assert.equal(errorCode({code:'xoxb-secret',message:'document'}),'internal');
});
test('overlapping async traces keep their own stages and metrics; failing log sinks never fail document work',async()=>{
 const first:Record<string,unknown>[]=[],second:Record<string,unknown>[]=[];
 await Promise.all([
  traceTask(spec,context,()=>measured('upload_pdf',async()=>{await new Promise(r=>setTimeout(r,10));milestone('pdf_ready');conversionMetric({stage:'pdf',phase:'finish',durationMs:12});}),r=>first.push(r)),
  traceTask(spec,{...context,id:'b'.repeat(64)},()=>measured('upload_png',async()=>{milestone('first_image');}),r=>second.push(r)),
 ]);
 assert.ok(first.every(r=>r.taskId==='a'.repeat(64)));assert.ok(second.every(r=>r.taskId==='b'.repeat(64)));
 assert.equal(first.some(r=>r.stage==='upload_png'),false);assert.equal(second.some(r=>r.name==='pdf_ready'),false);
 assert.equal(await traceTask(spec,context,async()=>42,()=>{throw new Error('sink unavailable');}),42);
 await assert.rejects(measured('secret-document-name',async()=>{}),/Unknown measurement/);
});
test('child metric protocol strips arbitrary fields and rejects invalid stages and unbounded numeric values',()=>{
 assert.deepEqual(validMetric({stage:'parse',phase:'finish',durationMs:15,rssBytes:1024,message:'secret',document:'private'}),{stage:'parse',phase:'finish',durationMs:15,rssBytes:1024});
 for(const value of [null,{stage:'secret',phase:'finish'},{stage:'pdf',phase:'xoxb-secret'},{stage:'pdf',phase:'finish',durationMs:Infinity},{stage:'png',phase:'finish',rssBytes:-1}])assert.equal(validMetric(value),undefined);
});
test('editor traces isolate overlapping operations and report HTTP denial even when the route handles the exception',async()=>{
 const source:Record<string,unknown>[]=[],save:Record<string,unknown>[]=[];
 await Promise.all([
  traceEditor('source',()=>measured('download',async()=>{await new Promise(r=>setTimeout(r,5));}),()=>200,r=>source.push(r)),
  traceEditor('save',async()=>{},()=>403,r=>save.push(r)),
 ]);
 assert.equal(source.at(-1)?.ok,true);assert.equal(save.at(-1)?.ok,false);assert.equal(save.at(-1)?.statusCode,403);
 assert.ok(source.every(r=>r.operation==='source'));assert.ok(save.every(r=>r.operation==='save'));
 assert.notEqual(source[0]?.runId,save[0]?.runId);assert.equal(save.some(r=>r.stage==='download'),false);
 assert.equal(await traceEditor('document',async()=>42,()=>200,()=>{throw new Error('sink');}),42);
});
test('actual Slack client emits method timing without request credentials, identifiers, responses or exception messages',async()=>{
 const rows:Record<string,unknown>[]=[];
 const api=new HttpSlackApi('xoxb-secret',async()=>new Response(JSON.stringify({ok:true,file:{name:'private-document.hwp'}})));
 await traceEditor('source',()=>api.call('files.info',{file:'FPRIVATE'}),()=>200,r=>rows.push(r));
 assert.equal(rows.filter(r=>r.event==='stage_finished'&&r.stage==='slack_files_info').length,1);
 const failing=new HttpSlackApi('xoxb-secret',async()=>{throw new Error('private-url ticket=secret');});
 await assert.rejects(traceEditor('source',()=>failing.call('files.info',{file:'FPRIVATE'}),()=>500,r=>rows.push(r)));
 assert.equal(rows.at(-1)?.ok,false);assert.equal(rows.at(-1)?.errorCode,'internal');
 for(const secret of ['xoxb-secret','FPRIVATE','private-document','private-url','ticket='])assert.equal(JSON.stringify(rows).includes(secret),false);
});
test('Firestore operations retain return values and failures while tracing no keys or stored fields',async()=>{
 const rows:Record<string,unknown>[]=[];
 let row:Record<string,unknown>|undefined={key:'private-key',json:'{"fileId":"FPRIVATE"}'};
 const snapshot=()=>({data:()=>row});
 const db={collection:()=>({doc:()=>({get:async()=>snapshot()}),limit:()=>({get:async()=>({size:1,docs:[snapshot()]})})}),
  runTransaction:async(run:(transaction:unknown)=>Promise<unknown>)=>run({get:async()=>snapshot(),set:(_ref:unknown,value:Record<string,unknown>)=>{row=value;},delete:()=>{row=undefined;}})} as unknown as Firestore;
 const store=new FirestoreMetadata(db,'test','TPRIVATE');
 await traceEditor('source',async()=>{
  assert.deepEqual(await store.get('cards','private-key'),{fileId:'FPRIVATE'});
  assert.deepEqual(await store.list('cards'),[['private-key',{fileId:'FPRIVATE'}]]);
  assert.equal(await store.atomic('cards','private-key',()=>({value:{fileId:'FOTHER'},result:42})),42);
  await assert.rejects(store.atomic('cards','private-key',()=>{throw new Error('private-database-message');}));
 },()=>200,r=>rows.push(r));
 const stages=rows.filter(r=>r.event==='stage_finished');
 assert.deepEqual(stages.map(r=>[r.stage,r.ok]),[['metadata_get',true],['metadata_list',true],['metadata_atomic',true],['metadata_atomic',false]]);
 for(const secret of ['private-key','FPRIVATE','FOTHER','TPRIVATE','private-database-message'])assert.equal(JSON.stringify(rows).includes(secret),false);
});

test('validated conversion failures keep numeric context in the operational trace',async()=>{
 const records:Record<string,unknown>[]=[];
 await traceTask({teamId:'TTEST',cardId:'synthetic',kind:'preview'},{signal:new AbortController().signal,checkpoint:async()=>{}},async()=>{
  const metric=validMetric({stage:'svg_render',phase:'failed',failureReason:'svg_size',pageNumber:72,pageCount:80,svgBytes:104880785,message:'private document'});
  conversionMetric(metric!);
 },record=>records.push(record));
 const failure=records.find(r=>r.event==='conversion_stage')!;
 assert.equal(failure.failureReason,'svg_size');assert.equal(failure.pageNumber,72);assert.equal(failure.svgBytes,104880785);
 assert.equal(JSON.stringify(records).includes('private document'),false);
});
