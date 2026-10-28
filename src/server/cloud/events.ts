import {onboardChannel} from './channel-onboarding';
import {createHash} from 'node:crypto';
import type {Actor} from '../access';
import {authorizeFile,authorizeChannel} from '../access';
import {ID} from '../config';
import {object,UserError,userMessage} from '../errors';
import type {CloudApplication} from './application';
import type {TaskContext,TaskSpec,TerminalContext} from './tasks';
import {notificationFailure,eventNoticeResult,errorCode,eventInputObserved,eventInputNoticeFinished} from './telemetry';
import {AttachmentPendingError} from './error-diagnostics';
import {Settings} from '../settings';
import {normalizeExportRequest,type ExportRequest} from '../document-exports';
/** A projection of a signed event. Never store the message text or the original payload. */
export interface Input {kind:'channel_joined'|'file_shared'|'app_mention'|'file_deleted'|'file_unshared'|'home'|'retry_preview'|'more_pages'|'export_markdown'|'export_file';cardId?:string;messageTs?:string;actor?:Actor;fileId?:string;files?:string[];user?:string;request?:ExportRequest;receivedAt?:number;terminalNoticeRequested?:true;}
export class CloudEvents {
 constructor(private application:CloudApplication,private botUserId:string,private noticeSink?:(record:Record<string,unknown>)=>void){}
 async enqueue(eventId:string,input:Input):Promise<void>{
  const app=this.application,id=createHash('sha256').update(app.config.teamId+':'+eventId).digest('hex');
  const saved=await app.store.atomic<Input,Input>('inputs',id,current=>{
   const value=current??{...input,...(input.kind==='export_file'?{request:normalizeExportRequest(input.request)}:{}),receivedAt:Date.now(),terminalNoticeRequested:input.kind==='app_mention'||input.kind==='export_markdown'||input.kind==='export_file'?true as const:undefined};
   return {value,expiresAt:Date.now()+7*86400_000,result:value};
  });
  await app.tasks.enqueue('event:'+id,{teamId:app.config.teamId,cardId:id,kind:'event',...(saved.terminalNoticeRequested?{terminalNoticeRequested:true as const}:{})});
 }
 async terminal(spec:TaskSpec,context:TerminalContext):Promise<void>{
  const app=this.application,report=(status:'sent'|'failed'|'skipped'|'duplicate',error?:unknown)=>eventNoticeResult(context.id,status,error,this.noticeSink);
  if(spec.kind!=='event'||spec.teamId!==app.config.teamId||!/^[a-f0-9]{64}$/.test(context.id))return;
  const input=await app.store.get<Input>('inputs',spec.cardId),actor=input?.actor;
  if((input?.kind!=='app_mention'&&input?.kind!=='export_markdown'&&input?.kind!=='export_file')||!actor||actor.teamId!==spec.teamId||actor.userId===this.botUserId||!ID.user.test(actor.userId)||!ID.channel.test(actor.channelId)){report('skipped');return;}
  const key=createHash('sha256').update('event-notice:'+context.id).digest('hex');
  if(await app.store.get('event_notices',key)){report('duplicate');return;}
  if(await app.mode(actor.channelId)==='off'){report('skipped');return;}
  const signal=AbortSignal.timeout(10_000);
  try{await authorizeChannel(app.api,await app.accessConfig(actor),actor,signal);}
  catch(error){report('skipped',error);return;}
  interface Notice {state:'attempted'|'sent'|'failed';attemptedAt:number;finishedAt?:number;errorCode?:string;}
  const attemptedAt=Date.now(),expiresAt=attemptedAt+7*86400_000;
  const claimed=await app.store.atomic<Notice,boolean>('event_notices',key,current=>({value:current??{state:'attempted',attemptedAt},expiresAt:current?current.attemptedAt+7*86400_000:expiresAt,result:!current}));
  if(!claimed){report('duplicate');return;}
  let state:'sent'|'failed'='sent',failure:unknown;
  const exportFailure=['conversion_page_selection','conversion_text_limit','conversion_text_empty','conversion_zip_limit'].includes(context.failureCode)?userMessage({code:context.failureCode}):'파일 내보내기를 완료하지 못했습니다. 원본의 공유 상태와 선택한 쪽을 확인하고 다시 요청해 주세요. TXT는 2 MiB, ZIP은 최대 10쪽·26 MiB까지 지원합니다.';
  try{await app.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:input.kind==='export_file'?exportFailure:input.kind==='export_markdown'?'Markdown 변환을 완료하지 못했습니다. 원본 파일의 공유 상태를 확인하고 문서 카드에서 다시 요청해 주세요. Markdown은 2 MiB, 전체 패키지는 50 MiB까지 지원합니다.':'한글 문서 요청을 완료하지 못했습니다. 앱의 채널 참여와 파일 공유 상태를 확인한 뒤 다시 요청해 주세요. 문제가 계속되면 관리자에게 앱 연결과 권한 확인을 요청해 주세요.'},signal);}
  catch(error){state='failed';failure=error;}
  report(state,failure);
  // Recording a send attempt first avoids duplicate posts after ambiguous responses or crashes.
  await app.store.atomic<Notice,void>('event_notices',key,current=>({value:current?.state==='attempted'?{...current,state,finishedAt:Date.now(),...(state==='failed'?{errorCode:errorCode(failure)}:{})}:current,expiresAt,result:undefined}));
 }
 private threadKey(actor:Actor,fileId:string){return JSON.stringify([actor.teamId,actor.channelId,actor.threadTs,fileId]);}
 private async remember(actor:Actor,fileId:string){
  const key=this.threadKey(actor,fileId);await this.application.store.atomic('observed',key,()=>({value:{team:actor.teamId,channel:actor.channelId,parent:actor.threadTs,file:fileId},expiresAt:Date.now()+86400_000,result:undefined}));
 }
 async execute(spec:TaskSpec,context:TaskContext):Promise<void>{
  const app=this.application;if(spec.teamId!==app.config.teamId)throw new Error('Wrong workspace');
  if(context.terminalFailure)return;
  const input=await app.store.get<Input>('inputs',spec.cardId);if(!input)throw new Error('Missing event');
  if(input.kind==='file_deleted'||input.kind==='file_unshared'){if(input.fileId)await app.invalidate(input.fileId,input.kind==='file_unshared');return;}
  if(input.kind==='home'){await new Settings(app.config,app.api,undefined,app.store).home(app.config.teamId,input.user!);return;}
  if(input.kind==='retry_preview'||input.kind==='more_pages'||input.kind==='export_markdown'||input.kind==='export_file'){
   const actor=input.actor!;await context.checkpoint();
   try{
    if(input.kind==='export_file'){
     const request=normalizeExportRequest(input.request),result=await app.exportFile(input.cardId!,actor,input.messageTs!,request,context);
     await app.authorize(input.cardId!,actor,context);
     const label=request.format==='txt'?'원문 TXT':request.format==='markdown'?'문서 Markdown ZIP':'선택 쪽 PNG ZIP';
     await app.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:result.url?`${label}을 같은 스레드에 첨부했습니다. <${result.url}|파일 열기>`:`${label}을 같은 스레드에 첨부했습니다.`},context.signal);
    }
    else if(input.kind==='export_markdown'){
     const result=await app.exportMarkdown(input.cardId!,actor,input.messageTs!,context);
     await app.authorize(input.cardId!,actor,context);
     await app.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:result.url?`문서 Markdown ZIP을 같은 스레드에 첨부했습니다. ZIP의 document.md와 report.json을 함께 확인하세요. <${result.url}|Markdown ZIP 받기>`:'문서 Markdown ZIP을 같은 스레드에 첨부했습니다. ZIP의 document.md와 report.json을 함께 확인하세요.'},context.signal);
    }
    else if(input.kind==='retry_preview')await app.retryPreview(input.cardId!,actor,input.messageTs!,spec.cardId);
    else await app.morePages(input.cardId!,actor,input.messageTs!,spec.cardId);
   }catch(error){
    if(!(error instanceof UserError))throw error;
    try{await app.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:userMessage(error)},context.signal);}
    catch(noticeError){notificationFailure('preview_notice',noticeError);throw noticeError;}
   }
   return;
  }
  const actor=input.actor!;
  try{await onboardChannel(app.config,app.api,app.store,actor.channelId,this.botUserId);}catch(error){if(error instanceof UserError&&error.code==='access_denied')return;throw error;}
  if(input.kind==='channel_joined')return;
  if(actor.userId===this.botUserId||await app.mode(actor.channelId)==='off')return;
  await context.checkpoint();
  if(input.kind==='file_shared'){
   const f=object((await app.api.call('files.info',{file:input.fileId},context.signal)).file);
   if(f.user===this.botUserId||f.id!==input.fileId||typeof f.name!=='string'||!/\.(hwp|hwpx)$/i.test(f.name))return;
   const shares=object(f.shares),valid=[object(shares.public??{})[actor.channelId],object(shares.private??{})[actor.channelId]].filter(Array.isArray).flat().map(object).filter(s=>s.share_user_id!==this.botUserId&&s.team_id===actor.teamId&&typeof s.ts==='string'&&/^\d+\.\d+$/.test(s.ts));
   if(valid.length!==1){if(await app.mode(actor.channelId)==='auto')await app.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:'미리보기를 달 메시지를 특정하지 못했습니다. 해당 메시지 메뉴에서 한글 문서 열기를 선택해 주세요.'},context.signal);return;}
   const share=valid[0],parent=share.thread_ts??share.ts;if(typeof parent!=='string'||!/^\d+\.\d+$/.test(parent))return;
   actor.threadTs=parent;actor.reactionTs=String(share.ts);await this.remember(actor,input.fileId!);
   if(await app.mode(actor.channelId)==='auto'){await context.checkpoint();await app.submit(actor,input.fileId!,'thread:'+this.threadKey(actor,input.fileId!));}return;
  }
  let files=input.files??[];
  if(!files.length){
   files=(await app.store.list<{team:string;channel:string;parent:string;file:string}>('observed')).map(([,r])=>r).filter(r=>r.team===actor.teamId&&r.channel===actor.channelId&&r.parent===actor.threadTs).map(r=>r.file);
   // Release the single dispatch slot. A later file_shared task must be able to run.
   if(!files.length&&Date.now()-(input.receivedAt??0)<30_000){eventInputObserved('awaiting_share');throw new AttachmentPendingError();}
  }
  if(!files.length){
   eventInputObserved('attachment_required');
   try{await app.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:'HWP/HWPX 파일과 함께 @rhwp를 멘션해 주세요. 이전 파일은 해당 메시지 메뉴의 한글 문서 열기로 요청할 수 있습니다.'},context.signal);eventInputNoticeFinished('sent');}
   catch(error){eventInputNoticeFinished('failed',error);throw error;}
   return;
  }
  eventInputObserved('files_available');
  if(files.length>10)throw new UserError('too_many_files','한 번에 문서 10개까지 요청할 수 있습니다.');
  for(const id of new Set(files))if(ID.file.test(id)){
   await context.checkpoint();await authorizeFile(app.api,await app.accessConfig(actor),actor,id,context.signal);
   await app.submit(actor,id,'thread:'+this.threadKey(actor,id));
  }
 }
}
