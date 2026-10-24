export type NoticeReason='source_unavailable'|'access_unavailable'|'receipt_missing'|'target_mismatch'|'installation_mismatch'|'channel_access_unavailable'|'card_missing'|'superseded'|'message_missing';
import {isPermanentConversionFailure} from '../../conversion/failures.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {CloudTasksClient} from '@google-cloud/tasks';
import type {Actor} from '../access';
import type {MetadataStore} from './metadata';
import {errorCode,terminalTaskFailure,eventNoticeResult,terminalNoticeResult,bindLogicalTask,taskStateFinished} from './telemetry';
import {errorDiagnostics,restoreDiagnostics,type ErrorDiagnostics} from './error-diagnostics';
import {isPermanentEventFailure} from './task-failures';
import {slackDiagnostics,attachSlackDiagnostics,attachResponseSizeDiagnostics,type SlackDiagnostics} from '../slack-diagnostics';
export const MAX_TASK_ATTEMPTS=3;
export const MAX_NOTICE_ATTEMPTS=3;
export const TASK_LIFETIME_MS=15*60_000;
const RETENTION_MS=7*86400_000;
export interface TaskSpec {teamId:string;cardId:string;kind:'prepare'|'preview'|'images'|'event';actor?:Actor;terminalNoticeRequested?:true;}
export interface Work {spec:TaskSpec;state:'queued'|'running'|'done'|'failed';owner?:string;leaseUntil?:number;generation:number;createdAt:number;deadlineAt?:number;failureCode?:string;failureDiagnostics?:SlackDiagnostics;failureDetails?:ErrorDiagnostics;terminalAt?:number;watchdogFor?:string;}
export interface TaskPublisher {publish(id:string,notBefore?:number):Promise<void>;}
export class GoogleTaskPublisher implements TaskPublisher {
  constructor(private client:CloudTasksClient,private queue:string,private workerOrigin:string,private serviceAccount:string){
    const url=new URL(workerOrigin);
    if(url.protocol!=='https:'||url.origin!==workerOrigin||!url.hostname.endsWith('.run.app'))throw new Error('Expected a Cloud Run worker origin');
    if(!/^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/.test(queue)||!serviceAccount.endsWith('.iam.gserviceaccount.com'))throw new Error('Invalid task queue configuration');
  }
  async publish(id:string,notBefore?:number):Promise<void>{
    if(!/^[a-f0-9]{64}$/.test(id)||(notBefore!==undefined&&(!Number.isSafeInteger(notBefore)||notBefore<0)))throw new Error('Invalid task ID or schedule');
    try{
      await this.client.createTask({parent:this.queue,task:{name:`${this.queue}/tasks/${id}`,dispatchDeadline:{seconds:900},...(notBefore===undefined?{}:{scheduleTime:{seconds:Math.ceil(notBefore/1000)}}),httpRequest:{
        httpMethod:'POST',url:this.workerOrigin+'/internal/tasks',headers:{'Content-Type':'application/json'},
        body:Buffer.from(JSON.stringify({id})),oidcToken:{serviceAccountEmail:this.serviceAccount,audience:this.workerOrigin},
      }}});
    }catch(error){if((error as {code?:number}).code!==6)throw error;}
  }
}
export class TaskBusy extends Error {readonly code='task_busy';}
export class LeaseLost extends Error {}
export interface TaskContext {signal:AbortSignal;checkpoint():Promise<void>;id?:string;attempt?:number;maxAttempts?:number;finalAttempt?:boolean;terminalFailure?:string;terminalNotice?:{phase:'bookkeeping'|'notice';result?:'ready'|'sent'|'skipped';reason?:NoticeReason};}
/** Only an actual Slack call may be wrapped; storage/checkpoints stay outside this boundary. */
export class TerminalNoticeFailure extends Error {
  readonly code:string;
  constructor(readonly failure:unknown){
    super('Terminal notice unavailable');this.code=errorCode(failure);
    restoreDiagnostics(this,errorDiagnostics(failure));
    const diagnostic=slackDiagnostics(failure);
    if(diagnostic.slackError!==undefined)attachSlackDiagnostics(this,diagnostic.httpStatus,diagnostic.slackError);
    else if(diagnostic.httpStatus!==undefined)attachSlackDiagnostics(this,diagnostic.httpStatus);
    attachResponseSizeDiagnostics(this,diagnostic);
  }
}
export interface TerminalNotice {state:'pending'|'running'|'sent'|'exhausted'|'skipped';attempts:number;owner?:string;leaseUntil?:number;errorCode?:string;diagnostics?:SlackDiagnostics;}
export interface TerminalContext {id:string;attempt:number;failureCode:string;}
export type TerminalCallback=(spec:TaskSpec,context:TerminalContext)=>Promise<void>;
/** Queue messages contain an opaque ID only. No document contents, tokens or transfer URLs. */
export class DurableTasks {
  constructor(private store:MetadataStore,private publisher:TaskPublisher,private now=Date.now,private leaseMs=60_000,private terminalSink?:(record:Record<string,unknown>)=>void,private noticeSink?:(record:Record<string,unknown>)=>void){}
  async enqueue(requestKey:string,spec:TaskSpec):Promise<string>{
    const id=await this.reserve(requestKey,spec);await this.dispatch(id);return id;
  }
  /** Persist intent without starting work. Call dispatch only after releasing document locks. */
  async reserve(requestKey:string,spec:TaskSpec):Promise<string>{
    if(!/^T[A-Z0-9]+$/.test(spec.teamId)||!spec.cardId||!['prepare','preview','images','event'].includes(spec.kind)||(spec.terminalNoticeRequested!==undefined&&(spec.terminalNoticeRequested!==true||spec.kind!=='event'))||!requestKey||requestKey.length>2048)throw new Error('Invalid task');
    const id=createHash('sha256').update(JSON.stringify([spec.teamId,requestKey])).digest('hex');
    await this.store.atomic<Work,Work|undefined>('tasks',id,current=>{
      if(current){
        if(JSON.stringify(current.spec)!==JSON.stringify(spec))throw new Error('Task key conflict');
        const terminal=current.state==='done'||current.state==='failed',value=terminal?{...current,terminalAt:current.terminalAt??this.now()}:current;
        return {value,expiresAt:value.terminalAt===undefined?undefined:value.terminalAt+RETENTION_MS,result:terminal?undefined:value};
      }
      const value:Work={spec,state:'queued',generation:0,createdAt:this.now(),deadlineAt:this.now()+TASK_LIFETIME_MS};return {value,result:value};
    });
    return id;
  }
  async dispatch(id:string):Promise<void>{
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid task ID');
    const work=await this.store.get<Work>('tasks',id);if(!work)throw new Error('Missing reserved task');
    if(work.state==='done'||work.state==='failed')return;
    const spec=work.spec;
    // A separate scheduled delivery repairs the visible state even if the last worker was killed.
    // Publish it before the work, so acknowledging ingress always includes this durable handoff.
    if(spec.kind!=='event'||spec.terminalNoticeRequested===true){
      const watchId=createHash('sha256').update(id+':deadline').digest('hex'),deadline=work.deadlineAt??work.createdAt+TASK_LIFETIME_MS;
      await this.store.atomic<Work,void>('tasks',watchId,current=>({value:current??{spec,state:'queued',generation:0,createdAt:work.createdAt,deadlineAt:deadline,watchdogFor:id},result:undefined}));
      await this.publisher.publish(watchId,deadline);
    }
    await this.publisher.publish(id);
  }
  private async observe(id:string,work:Work,checkpoint:()=>Promise<void>):Promise<void>{
    await checkpoint();
    const claimed=await this.store.atomic<{claimedAt:number},boolean>('terminal_observations',id,current=>({
      value:current??{claimedAt:this.now()},expiresAt:work.terminalAt!+RETENTION_MS,result:!current,
    }));
    if(!claimed)return;
    const error=Object.assign(new Error('Durable task failed'),{code:work.failureCode});
    if(!restoreDiagnostics(error,work.failureDetails))restoreDiagnostics(error,errorDiagnostics(undefined,'terminal_failure'));
    const diagnostic=work.failureDiagnostics;
    if(diagnostic?.slackError!==undefined)attachSlackDiagnostics(error,diagnostic.httpStatus,diagnostic.slackError);
    else if(diagnostic?.httpStatus!==undefined)attachSlackDiagnostics(error,diagnostic.httpStatus);
    if(diagnostic)attachResponseSizeDiagnostics(error,diagnostic);
    terminalTaskFailure(id,work.spec,Math.min(work.generation,MAX_TASK_ATTEMPTS),error,this.terminalSink);

  }
  private async repair(id:string,work:Work,run:(spec:TaskSpec,context:TaskContext)=>Promise<void>,onTerminal?:TerminalCallback,parent?:TaskContext):Promise<void>{
    const parentCheck=async()=>{await parent?.checkpoint();};
    await this.observe(id,work,parentCheck);
    if(work.spec.kind==='event'){
      if(onTerminal)try{await onTerminal(work.spec,{id,attempt:Math.min(work.generation,MAX_TASK_ATTEMPTS),failureCode:work.failureCode??'task_deadline'});}
      catch(error){eventNoticeResult(id,'failed',error);}
      return;
    }
    const owner=randomUUID(),expiresAt=work.terminalAt!+RETENTION_MS;
    const closed=(state:TerminalNotice['state'])=>['sent','exhausted','skipped'].includes(state);
    const receipt=await this.store.atomic<TerminalNotice,TerminalNotice>('terminal_notices',id,current=>{
      if(current?.owner&&(current.leaseUntil??0)>this.now())throw new TaskBusy('Terminal notice is already running');
      const value:TerminalNotice={...current,state:current&&closed(current.state)?current.state:'running',attempts:current?.attempts??0,owner,leaseUntil:this.now()+this.leaseMs};
      return {value,expiresAt,result:value};
    });
    const controller=new AbortController(),signal=parent?AbortSignal.any([controller.signal,parent.signal]):controller.signal;
    const checkpoint=async()=>{
      signal.throwIfAborted();await parentCheck();
      try{await this.store.atomic<TerminalNotice,void>('terminal_notices',id,current=>{
        if(!current||current.owner!==owner||(current.leaseUntil??0)<=this.now())throw new LeaseLost('Terminal notice lease expired');
        return {value:{...current,leaseUntil:this.now()+this.leaseMs},expiresAt,result:undefined};
      });}catch(error){controller.abort(new LeaseLost('Terminal notice lease unavailable'));throw error;}
    };
    let renewal=Promise.resolve();
    const timer=setInterval(()=>{renewal=renewal.then(checkpoint).catch(()=>controller.abort(new LeaseLost('Terminal notice lease unavailable')));},Math.max(10,Math.floor(this.leaseMs/3)));timer.unref();
    const timeout=setTimeout(()=>controller.abort(new LeaseLost('Terminal notice timed out')),60_000);timeout.unref();
    const context:TaskContext={signal,checkpoint,id,attempt:Math.min(work.generation,MAX_TASK_ATTEMPTS),maxAttempts:MAX_TASK_ATTEMPTS,finalAttempt:true,terminalFailure:work.failureCode??'task_deadline',terminalNotice:{phase:'bookkeeping'}};
    let settled=false,noticeAttempt=receipt.attempts;
    const finish=async(state:TerminalNotice['state'],error?:unknown)=>{
      await checkpoint();
      await this.store.atomic<TerminalNotice,void>('terminal_notices',id,current=>{
        if(!current||current.owner!==owner||(current.leaseUntil??0)<=this.now())throw new LeaseLost('Terminal notice lease expired');
        return {value:{...current,state,owner:undefined,leaseUntil:undefined,...(error===undefined?{}:{errorCode:errorCode(error),diagnostics:slackDiagnostics(error)})},expiresAt,result:undefined};
      });settled=true;
    };
    try{
      // Always recheck bookkeeping, including after exhaustion; storage failures must still retry.
      await run(work.spec,context);await checkpoint();
      if(closed(receipt.state)){await finish(receipt.state);return;}
      if(context.terminalNotice?.result==='skipped'){
        await finish('skipped');terminalNoticeResult(id,'skipped',receipt.attempts,undefined,this.noticeSink,context.terminalNotice?.reason);return;
      }
      if(context.terminalNotice?.result!=='ready')throw new Error('Missing terminal bookkeeping outcome');
      if(receipt.attempts>=MAX_NOTICE_ATTEMPTS){
        await finish('exhausted');terminalNoticeResult(id,'exhausted',receipt.attempts,undefined,this.noticeSink,context.terminalNotice?.reason);return;
      }
      const attempt=await this.store.atomic<TerminalNotice,number>('terminal_notices',id,current=>{
        if(!current||current.owner!==owner||(current.leaseUntil??0)<=this.now())throw new LeaseLost('Terminal notice lease expired');
        return {value:{...current,attempts:current.attempts+1},expiresAt,result:current.attempts+1};
      });
      noticeAttempt=attempt;context.terminalNotice={phase:'notice'};
      try{await run(work.spec,context);}
      catch(error){
        if(!(error instanceof TerminalNoticeFailure))throw error;
        await checkpoint();
        const slackError=slackDiagnostics(error.failure).slackError??'';
        const denied=['not_in_channel','channel_not_found','is_archived','missing_scope','no_permission','posting_to_channel_denied','invalid_auth','token_revoked','account_inactive'].includes(slackError);
        if(denied)context.terminalNotice!.reason='channel_access_unavailable';
        const permanent=denied||['message_not_found','cant_update_message','invalid_blocks'].includes(slackError);
        const state=permanent||attempt>=MAX_NOTICE_ATTEMPTS?'exhausted':'pending';
        await finish(state,error.failure);terminalNoticeResult(id,state==='pending'?'failed':'exhausted',attempt,error.failure,this.noticeSink,context.terminalNotice?.reason);
        if(state==='pending')throw error;
        return;
      }
      await checkpoint();
      const result=context.terminalNotice.result;
      if(result!=='sent'&&result!=='skipped')throw new Error('Missing terminal notice outcome');
      await finish(result);terminalNoticeResult(id,result,attempt,undefined,this.noticeSink,context.terminalNotice?.reason);
    }finally{
      clearInterval(timer);clearTimeout(timeout);await renewal;controller.abort();
      if(!settled)await this.store.atomic<TerminalNotice,void>('terminal_notices',id,current=>({
        value:current?.owner===owner?{...current,state:closed(current.state)?current.state:'pending',owner:undefined,leaseUntil:undefined}:current,expiresAt,result:undefined,
      })).catch(()=>{});
    }
  }
  async execute(id:string,run:(spec:TaskSpec,context:TaskContext)=>Promise<void>,onTerminal?:TerminalCallback):Promise<void>{
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid task ID');
    bindLogicalTask(id);
    const owner=randomUUID(),controller=new AbortController();
    const work=await this.store.atomic<Work,(Work&{terminalReceipt?:true})|undefined>('tasks',id,current=>{
      if(!current)throw new Error('Unknown task');
      if(current.state==='done'){
        const value={...current,terminalAt:current.terminalAt??this.now()};
        return {value,expiresAt:value.terminalAt+RETENTION_MS,result:undefined};
      }
      if(current.watchdogFor&&(current.deadlineAt??0)>this.now())throw new TaskBusy('Reconciliation is not due');
      if(current.state==='running'&&(current.leaseUntil??0)>this.now())throw new TaskBusy('Task is already running');
      const deadlineAt=current.deadlineAt??current.createdAt+TASK_LIFETIME_MS;
      if(!current.watchdogFor&&(current.state==='failed'||current.generation>=MAX_TASK_ATTEMPTS||deadlineAt<=this.now()||isPermanentConversionFailure(current.failureCode))){
        const value:Work={...current,state:'failed',owner:undefined,leaseUntil:undefined,deadlineAt,terminalAt:current.terminalAt??this.now(),failureCode:current.failureCode??'task_deadline'};
        return {value,expiresAt:value.terminalAt!+RETENTION_MS,result:{...value,terminalReceipt:true}};
      }
      const value:Work={...current,state:'running',owner,generation:current.generation+1,deadlineAt,leaseUntil:this.now()+this.leaseMs};
      return {value,result:value};
    });
    if(!work)return;
    bindLogicalTask(id,work.generation);
    if(work.terminalReceipt){taskStateFinished(id,work.spec,Math.min(work.generation,MAX_TASK_ATTEMPTS),'failed');await this.repair(id,work,run,onTerminal);return;}
    const checkpoint=async()=>{
      controller.signal.throwIfAborted();
      try{await this.store.atomic<Work,void>('tasks',id,current=>{
        if(!current||current.owner!==owner||current.generation!==work.generation||current.state!=='running'||(current.leaseUntil??0)<=this.now())throw new LeaseLost('Worker lease expired');
        return {value:{...current,leaseUntil:this.now()+this.leaseMs},result:undefined};
      });}catch(error){controller.abort(new LeaseLost('Worker lease unavailable'));throw error;}
    };
    const context:TaskContext={signal:controller.signal,checkpoint,id,attempt:work.generation,maxAttempts:MAX_TASK_ATTEMPTS,finalAttempt:work.generation>=MAX_TASK_ATTEMPTS};
    let renewal=Promise.resolve();
    const timer=setInterval(()=>{renewal=renewal.then(checkpoint).catch(()=>controller.abort(new LeaseLost('Worker lease unavailable')));},Math.max(10,Math.floor(this.leaseMs/3)));timer.unref();
    const timeout=setTimeout(()=>controller.abort(Object.assign(new Error('Task deadline exceeded'),{code:'task_deadline'})),work.watchdogFor?60_000:Math.max(1,Math.min(5*60_000,work.deadlineAt!-this.now())));timeout.unref();
    let terminal:Work|undefined;
    try{
      try{
        if(work.watchdogFor){
          const target=await this.store.atomic<Work,Work|undefined>('tasks',work.watchdogFor,current=>{
            if(!current)return {result:undefined};
            if(current.state==='done'){
              const value={...current,terminalAt:current.terminalAt??this.now()};
              return {value,expiresAt:value.terminalAt+RETENTION_MS,result:undefined};
            }
            if((current.deadlineAt??current.createdAt+TASK_LIFETIME_MS)>this.now())throw new TaskBusy('Reconciliation is not due');
            const value:Work={...current,state:'failed',owner:undefined,leaseUntil:undefined,terminalAt:current.terminalAt??this.now(),failureCode:current.failureCode??'task_deadline'};
            return {value,expiresAt:value.terminalAt!+RETENTION_MS,result:value};
          });
          if(target){
            bindLogicalTask(work.watchdogFor,target.generation);
            taskStateFinished(work.watchdogFor,target.spec,Math.min(target.generation,MAX_TASK_ATTEMPTS),'failed');
            await this.repair(work.watchdogFor,target,run,onTerminal,context);
          }
        }else await run(work.spec,context);
        clearInterval(timer);await renewal;await checkpoint();
        await this.store.atomic<Work,void>('tasks',id,current=>{
          if(!current||current.owner!==owner||current.generation!==work.generation||current.state!=='running'||(current.leaseUntil??0)<=this.now())throw new LeaseLost('Worker lease expired');
          const value:Work={...current,state:'done',owner:undefined,leaseUntil:undefined,terminalAt:this.now()};
          return {value,expiresAt:value.terminalAt!+RETENTION_MS,result:undefined};
        });
        if(!work.watchdogFor)taskStateFinished(id,work.spec,work.generation,'done');
      }catch(error){
        clearInterval(timer);await renewal;
        const final=!(error instanceof TaskBusy)&&!work.watchdogFor&&(work.generation>=MAX_TASK_ATTEMPTS||work.deadlineAt!<=this.now()||isPermanentConversionFailure(errorCode(error))||isPermanentEventFailure(work.spec,error));
        const failureDetails=errorDiagnostics(error,'task_failure');
        const failed=await this.store.atomic<Work,Work|undefined>('tasks',id,current=>{
          if(current?.owner!==owner||current.generation!==work.generation||current.state!=='running'||(current.leaseUntil??0)<=this.now())return {value:current,expiresAt:current?.terminalAt===undefined?undefined:current.terminalAt+RETENTION_MS,result:undefined};
          const value:Work={...current,state:final?'failed':'queued',owner:undefined,leaseUntil:undefined,failureCode:errorCode(error),failureDiagnostics:slackDiagnostics(error),failureDetails,generation:error instanceof TaskBusy?Math.max(0,current.generation-1):current.generation,...(final?{terminalAt:this.now()}:{})};
          return {value,expiresAt:final?value.terminalAt!+RETENTION_MS:undefined,result:value};
        });
        if(!failed)throw new LeaseLost('Worker no longer owns task');
        if(!final)throw error;
        taskStateFinished(id,failed.spec,Math.min(failed.generation,MAX_TASK_ATTEMPTS),'failed');
        terminal=failed;
      }
      // Notice errors cannot return the business task to running or queued.
      if(terminal)await this.repair(id,terminal,run,onTerminal);
    }finally{clearInterval(timer);clearTimeout(timeout);controller.abort();}
  }
}
