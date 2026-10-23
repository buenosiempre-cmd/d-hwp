import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {TaskContext,TaskSpec} from './tasks';
import type {ConversionMetric} from '../../conversion/convert.mjs';
import {slackDiagnostics,type SlackDiagnostics} from '../slack-diagnostics';
import {errorDiagnostics,type ErrorDiagnostics} from './error-diagnostics';
const stages=new Set(['authorize','download','conversion','upload_pdf','upload_png','share_confirm','card_post','card_update','source_prepare']);
for(const stage of ['metadata_get','metadata_list','metadata_atomic','slack_auth_test','slack_conversations_info','slack_conversations_members','slack_files_info','slack_views_publish','slack_reactions_add','slack_reactions_remove','slack_chat_postEphemeral','slack_views_open','slack_chat_postMessage','slack_chat_update','slack_entity_presentDetails','slack_files_getUploadURLExternal','slack_files_completeUploadExternal'])stages.add(stage);
const editorOperations=new Set(['exchange','document','source','save','save_status','preflight','other']);
export type EditorOperation='exchange'|'document'|'source'|'save'|'save_status'|'preflight'|'other';
const errors=new Set(['timeout','aborted','access_denied','source_changed','session_expired','rate_limited','slack_unavailable','slack_rejected','upload_uncertain','size_limit','card_pending','share_pending','conversion_timeout','conversion_start','conversion_child','conversion_output','conversion_page_limit','conversion_svg_limit','conversion_page_geometry','conversion_pdf_limit','conversion_preview_limit','conversion_render','conversion_aborted','conversion_busy','task_deadline','task_attempts','task_busy','pages_pending']);
export function errorCode(error:unknown):string {
  try{
    const e=error as {code?:unknown;name?:unknown}|undefined;
    if(typeof e?.code==='string'&&errors.has(e.code))return e.code;
    if(e?.name==='TimeoutError')return 'timeout';
    if(e?.name==='AbortError')return 'aborted';
  }catch{/* Hostile exception properties cannot replace the original failure. */}
  return 'internal';
}
type Sink=(record:Record<string,unknown>)=>void;
interface Trace {started:number;sink:Sink;fields:Record<string,unknown>;}
const traces=new AsyncLocalStorage<Trace>();
interface Delivery {sink:Sink;fields:Record<string,unknown>;failure?:Record<string,unknown>;}
const deliveries=new AsyncLocalStorage<Delivery>();
export const runtimeId=randomUUID();
const output:Sink=record=>console.log(JSON.stringify(record));
function runtimeFields():Record<string,string> {
  const revision=process.env.K_REVISION;
  return {runtimeId,...(typeof revision==='string'&&/^[a-z][a-z0-9-]{0,62}$/.test(revision)?{revision}:{})};
}
export function cloudTrace(header:unknown,project:unknown=process.env.GOOGLE_CLOUD_PROJECT):Record<string,string> {
  if(typeof header!=='string'||header.length>100||typeof project!=='string'||!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project))return {};
  const match=/^([a-f0-9]{32})\/([0-9]{1,20})(?:;o=[01])?$/.exec(header);
  if(!match||/^0+$/.test(match[1])||BigInt(match[2])>18_446_744_073_709_551_615n)return {};
  return {'logging.googleapis.com/trace':`projects/${project}/traces/${match[1]}`};
}
function independent(record:Record<string,unknown>,sink?:Sink):void {
  try{(sink??deliveries.getStore()?.sink??output)({...runtimeFields(),...deliveries.getStore()?.fields,...record});}catch{/* Observability cannot fail work. */}
}
export function bindDelivery(id:string):void {const current=deliveries.getStore();if(current&&/^[a-f0-9]{64}$/.test(id))current.fields.deliveryId=id;}
export function bindLogicalTask(id:string,attempt?:number):void {
  const current=deliveries.getStore();if(!current||!/^[a-f0-9]{64}$/.test(id))return;
  current.fields.taskId=id;
  if(Number.isSafeInteger(attempt)&&Number(attempt)>=0)current.fields.attempt=attempt;
}
export function deliveryFailure(error:unknown):void {
  const current=deliveries.getStore();
  if(current)current.failure={errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error,'worker_delivery')};
}
/** Includes routing/claim/final-commit failures outside the narrower business callback trace. */
export async function traceDelivery<T>(header:unknown,run:()=>Promise<T>,status:()=>number,sink:Sink=output):Promise<T>{
  const context:Delivery={sink,fields:{...runtimeFields(),runId:randomUUID(),...cloudTrace(header)}};
  return deliveries.run(context,async()=>{
    const started=performance.now();independent({event:'worker_delivery_started'});
    try{return await run();}catch(error){deliveryFailure(error);throw error;}
    finally{
      const code=status(),statusCode=Number.isInteger(code)&&code>=100&&code<=599?code:500;
      independent({event:'worker_delivery_finished',...context.failure,statusCode,ok:!context.failure&&statusCode<400,durationMs:Math.round(performance.now()-started)});
    }
  });
}
function emit(record:Record<string,unknown>):void {
  const trace=traces.getStore();if(!trace)return;
  try{trace.sink({...trace.fields,...record,elapsedMs:Math.round(performance.now()-trace.started)});}catch{/* Observability cannot fail work. */}
}
export async function measured<T>(stage:string,run:()=>Promise<T>):Promise<T>{
  if(!stages.has(stage))throw new Error('Unknown measurement stage');
  if(!traces.getStore())return run();
  const started=performance.now();emit({event:'stage_started',stage});
  try{const result=await run();emit({event:'stage_finished',stage,ok:true,durationMs:Math.round(performance.now()-started)});return result;}
  catch(error){emit({event:'stage_finished',stage,ok:false,durationMs:Math.round(performance.now()-started),errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error,'stage_failure')});throw error;}
}
/** Only method names are observed; arguments, responses and URLs never enter the trace. */
export function measuredSlack<T>(method:string,run:()=>Promise<T>):Promise<T>{
  const stage='slack_'+method.replaceAll('.','_');
  return stages.has(stage)?measured(stage,run):run();
}
/** HTTP handler time, including external waits; not the client's full download duration. */
export async function traceEditor<T>(operation:EditorOperation,run:()=>Promise<T>,status:()=>number,sink:Sink=record=>console.log(JSON.stringify(record))):Promise<T>{
  const fields={...runtimeFields(),runId:randomUUID(),operation:editorOperations.has(operation)?operation:'other'};
  const started=performance.now();
  return traces.run({started,sink,fields},async()=>{
    emit({event:'api_started'});
    let failed=false,code:string|undefined,diagnostics:SlackDiagnostics={},failure:ErrorDiagnostics|undefined;
    try{return await run();}catch(error){failed=true;code=errorCode(error);diagnostics=slackDiagnostics(error);failure=errorDiagnostics(error,'editor_failure');throw error;}
    finally{
      const value=status(),statusCode=Number.isInteger(value)&&value>=100&&value<=599?value:500;
      emit({event:'api_finished',statusCode,ok:!failed&&statusCode<400,errorCode:code,...diagnostics,...failure,durationMs:Math.round(performance.now()-started),parentRssBytes:process.memoryUsage().rss});
    }
  });
}
export function conversionMetric(metric:ConversionMetric):void {
  // convert.mjs validates the child protocol and creates these values from an allowlist.
  emit({event:'conversion_stage',stage:metric.stage,phase:metric.phase,durationMs:metric.durationMs,rssBytes:metric.rssBytes,failureReason:metric.failureReason,pageNumber:metric.pageNumber,pageCount:metric.pageCount,svgBytes:metric.svgBytes});
}
export function milestone(name:'first_card'|'pdf_ready'|'first_image'|'all_ready'):void {emit({event:'milestone',name});}
/** Called only after the corresponding existing timestamp has been durably saved. */
export function artifactFinished(event:'pdf_prepared'|'slack_published'):void {emit({event,artifact:'pdf'});}
export function eventInputObserved(inputState:'awaiting_share'|'attachment_required'|'files_available'):void {
  emit({event:'event_input_observed',eventType:'app_mention',inputState,documentWork:inputState==='files_available'?'unknown':'not_started'});
}
export function eventInputNoticeFinished(status:'sent'|'failed',error?:unknown):void {
  emit({event:'event_input_notice_finished',eventType:'app_mention',inputState:'attachment_required',status,...(error===undefined?{}:{errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error)})});
}
export function taskStateFinished(id:string,spec:TaskSpec,attempt:number,state:'done'|'failed'):void {
  try{
    if(!/^[a-f0-9]{64}$/.test(id)||!['prepare','preview','images','event'].includes(spec.kind)||typeof spec.cardId!=='string'||!Number.isSafeInteger(attempt)||attempt<0||!['done','failed'].includes(state))return;
    independent({event:'task_state_finished',taskId:id,kind:spec.kind,attempt,state,cardKey:createHash('sha256').update(spec.cardId).digest('hex')});
  }catch{/* A state observation cannot alter a durable business result. */}
}
const shareReasons=new Set(['file_mismatch','shares_missing','team_mismatch','timestamp_invalid','message_mismatch','thread_mismatch','ambiguous','confirmed','invalid_response','api_error']);
const shareRoles=new Set(['pdf','png','source','other']);
/** Fixed summaries of an existing query only; no response fields or identifiers are copied. */
export function shareCheckFinished(check:unknown,role:unknown,attempt?:unknown):void {
  try{
    if(!check||typeof check!=='object'||Array.isArray(check)||typeof role!=='string'||!shareRoles.has(role))return;
    const value=check as Record<string,unknown>,reason=value.shareReason;
    if(typeof reason!=='string'||!shareReasons.has(reason))return;
    const record:Record<string,unknown>={event:'share_check_finished',shareReason:reason,shareRole:role};
    if(Number.isSafeInteger(attempt)&&Number(attempt)>=1&&Number(attempt)<=6)record.shareCheckAttempt=attempt;
    let capped=false;
    for(const key of ['shareRecords','shareTeamMatches','shareValidTsMatches','shareMessageMatches','shareThreadMatches']){
      const count=value[key];
      if(!Number.isSafeInteger(count)||Number(count)<0)continue;
      record[key]=Math.min(Number(count),1000);if(Number(count)>1000)capped=true;
    }
    record.shareCountsCapped=capped;emit(record);
  }catch{/* Invalid observations and sink failures cannot affect document work. */}
}
async function memory():Promise<Record<string,number>> {
  for(const path of ['/sys/fs/cgroup/memory.peak','/sys/fs/cgroup/memory/memory.max_usage_in_bytes']){
    const value=Number(await readFile(path,'utf8').catch(()=>''));if(Number.isSafeInteger(value)&&value>0)return {cgroupPeakBytes:value,parentRssBytes:process.memoryUsage().rss};
  }
  return {parentRssBytes:process.memoryUsage().rss};
}
export async function traceTask<T>(spec:TaskSpec,context:TaskContext,run:()=>Promise<T>,sink:Sink=record=>console.log(JSON.stringify(record))):Promise<T>{
  const fields={...runtimeFields(),...deliveries.getStore()?.fields,runId:randomUUID(),kind:spec.kind,cardKey:createHash('sha256').update(spec.cardId).digest('hex'),...(context.id&&/^[a-f0-9]{64}$/.test(context.id)?{taskId:context.id}:{}),...(Number.isSafeInteger(context.attempt)?{attempt:context.attempt}:{}),...(['bookkeeping','notice'].includes(context.terminalNotice?.phase??'')?{terminalPhase:context.terminalNotice!.phase}:{})};
  const started=performance.now();
  return traces.run({started,sink,fields},async()=>{
    emit({event:'task_started',processUptimeMs:Math.round(process.uptime()*1000)});
    let ok=false,code:string|undefined,diagnostics:SlackDiagnostics={},failure:ErrorDiagnostics|undefined;
    try{const result=await run();ok=true;return result;}catch(error){code=errorCode(error);diagnostics=slackDiagnostics(error);failure=errorDiagnostics(error,'task_failure');throw error;}
    finally{emit({event:'task_finished',ok,errorCode:code,...diagnostics,...failure,durationMs:Math.round(performance.now()-started),...await memory()});}
  });
}

export function notificationFailure(stage:'preview_progress'|'preview_notice',error:unknown):void {emit({event:'notification_failed',stage,errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error)});}

/** A classified unshare outcome; neither deletion evidence nor an access grant. */
export function unshareVisibilityUnavailable():void {
  emit({event:'unshare_resolution',result:'visibility_unavailable',cleanup:'deferred'});
}

/** Called after durable failure is confirmed, outside the callback's trace scope. */
export function terminalTaskFailure(id:string,spec:TaskSpec,attempt:number,error:unknown,sink?:Sink):void {
  try{
    if(!/^[a-f0-9]{64}$/.test(id)||!['prepare','preview','images','event'].includes(spec.kind)||typeof spec.cardId!=='string'||!Number.isSafeInteger(attempt)||attempt<0)return;
    independent({event:'task_terminal_failed',taskId:id,cardKey:createHash('sha256').update(spec.cardId).digest('hex'),kind:spec.kind,attempt,errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error,'terminal_failure')},sink);
  }catch{/* Diagnostics cannot change task delivery or durable state. */}
}

/** Terminal notices run after callback traces and use no document or actor fields. */
export function eventNoticeResult(taskId:string,status:'sent'|'failed'|'skipped'|'duplicate',error?:unknown,sink?:Sink):void {
 try{
  if(!/^[a-f0-9]{64}$/.test(taskId)||!['sent','failed','skipped','duplicate'].includes(status))return;
  independent({event:'event_notice_finished',taskId,status,...(error!==undefined?{errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error)}:{})},sink);
 }catch{/* Notification diagnostics cannot change durable work. */}
}

/** A delivery result, separate from the durable business failure and its alert event. */
export function terminalNoticeResult(taskId:string,status:'sent'|'failed'|'skipped'|'exhausted',attempt:number,error?:unknown,sink?:Sink,reason?:import('./tasks').NoticeReason):void {
 try{
  if(!/^[a-f0-9]{64}$/.test(taskId)||!['sent','failed','skipped','exhausted'].includes(status)||!Number.isSafeInteger(attempt)||attempt<0||attempt>3)return;
  const safeReason=reason&&['source_unavailable','access_unavailable','receipt_missing','target_mismatch','installation_mismatch','channel_access_unavailable','card_missing','superseded','message_missing'].includes(reason)?reason:undefined;
  independent({event:'terminal_notice_finished',taskId,status,noticeAttempt:attempt,at:Date.now(),retryable:status==='failed',...(safeReason?{reason:safeReason}:{}),...(error!==undefined?{errorCode:errorCode(error),...slackDiagnostics(error),...errorDiagnostics(error)}:{})},sink);
 }catch{/* Delivery diagnostics do not change durable work. */}
}
