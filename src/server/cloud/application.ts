import type {NoticeReason} from './tasks';
import {isSourceUnavailable} from '../source-failure';
import {isPermanentConversionFailure} from '../../conversion/failures.mjs';
import {createHash,randomUUID} from 'node:crypto';
import {measured,conversionMetric,milestone,errorCode,notificationFailure,unshareVisibilityUnavailable,shareCheckFinished,artifactFinished} from './telemetry';
import {setTimeout as delay} from 'node:timers/promises';
import type {MetadataStore} from './metadata';
import {BoundedWork,serialWrites} from '../concurrency';
import {SharedSessions} from './sessions';
import {DurableTasks,MAX_TASK_ATTEMPTS,TerminalNoticeFailure,type TaskSpec,type TaskContext} from './tasks';
import {withLease,type LeaseContext} from './lease';
import type {Config} from '../config';
import {ID} from '../config';
import {authorizeFile,authorizeBotChannel,type Actor,type SourceFile} from '../access';
import {sharedChannels} from '../file-sharing';
import type {SlackApi} from '../slack-api';
import type {Card} from '../documents';
import type {Session} from '../sessions';
import type {Receipt} from '../saves';
import {downloadFile} from '../download';
import {Uploads,savedAttempt,type UploadAttempt} from '../uploads';
import {documentMetadata,documentMessage,browserEditorUrl} from '../document-message';
import {UserError,denied} from '../errors';
import {slackDiagnostics,isSlackFailure} from '../slack-diagnostics';
import {validateDocument} from '../validate-document';
import {validateInput} from '../../shared/errors';
import {convertPreview,convertPageImages,convertMarkdown,MAX_MARKDOWN_BYTES,type PageImage} from '../../conversion/convert.mjs';
import type {Mode} from '../commands';
import {normalizeExportRequest,exportKey,exportName,savedExports,MAX_DOCUMENT_EXPORTS,type ExportRequest} from '../document-exports';
import {convertText,convertPageZip,MAX_TEXT_BYTES,MAX_ZIP_BYTES} from '../../conversion/convert.mjs';
interface CloudCard extends Omit<Card,'imageAttempts'|'imageWork'|'updates'> {attempts?:Record<string,UploadAttempt>;fence?:string;removed?:boolean;previewRequestId?:string;pdfPreparedAt?:number;slackPublishedAt?:number;}
interface Request {actor:Actor;fileId:string;mode?:Mode;}
interface SaveOperation {hash:string;cardId:string;attempt:UploadAttempt;receipt:Receipt;}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const stableId=(value:string)=>{const h=hash(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export class CloudApplication {
  readonly sessions:SharedSessions;
  constructor(readonly config:Config,readonly api:SlackApi,readonly store:MetadataStore,readonly tasks:DurableTasks,private options:{download?:typeof downloadFile;convert?:typeof convertPreview;images?:typeof convertPageImages;markdown?:typeof convertMarkdown;text?:typeof convertText;zip?:typeof convertPageZip;fetcher?:typeof fetch;noticeIdentity?:{generation:string;botUserId:string;check:()=>Promise<void>}}={}){
    this.sessions=new SharedSessions(store,async(id,actor)=>{await this.authorize(id,actor);});
  }
  async mode(channel:string):Promise<'auto'|'mention'|'off'>{
    const p=await this.store.get<{mode:'auto'|'mention'|'off'}>('channels',channel);
    if(p)return p.mode;
    return await this.store.get('settings','initialized')?'off':this.config.channelIds.has(channel)?'auto':'off';
  }
  async accessConfig(actor:Actor):Promise<Config>{
    if(actor.teamId!==this.config.teamId||!ID.user.test(actor.userId)||!ID.channel.test(actor.channelId)||await this.mode(actor.channelId)==='off')denied();
    return {...this.config,channelIds:new Set([actor.channelId])};
  }
  async authorize(id:string,actor:Actor,context?:TaskContext):Promise<CloudCard>{return (await this.authorizedSource(id,actor,context)).card;}
  private async authorizedSource(id:string,actor:Actor,context?:TaskContext):Promise<{card:CloudCard;source:SourceFile}>{
    return measured('authorize',()=>this.authorizeUnmeasured(id,actor,context));
  }
  private async authorizeUnmeasured(id:string,actor:Actor,context?:TaskContext):Promise<{card:CloudCard;source:SourceFile}>{
    const config=await this.accessConfig(actor),card=await this.store.get<CloudCard>('cards',id);
    if(!card||card.removed||card.actor.teamId!==actor.teamId||card.actor.channelId!==actor.channelId)denied();
    const api=context?this.guarded(context):this.api;
    const source=await authorizeFile(api,config,actor,card.fileId,context?.signal);
    if(card.rootFileId!==card.fileId)await authorizeFile(api,config,actor,card.rootFileId,context?.signal);
    if(source.name!==card.name||source.size!==card.size)denied();return {card,source};
  }
  async ensureSource(id:string,actor:Actor,outer?:AbortSignal):Promise<Buffer>{
    // Reuse only the file info validated in this call; never cache permissions between requests.
    const {source}=await this.authorizedSource(id,actor),signal=AbortSignal.any([AbortSignal.timeout(30_000),...(outer?[outer]:[])]);
    const bytes=await measured('download',()=>(this.options.download??downloadFile)(source,actor,this.config.botToken,signal));
    const fresh=await this.authorize(id,actor);
    if(fresh.contentHash&&hash(bytes)!==fresh.contentHash)throw new UserError('source_changed','원본 내용이 변경되었습니다. 다시 요청하세요.');
    return bytes; // No cross-request document cache.
  }
  async present(id:string,actor:Actor,triggerId:string):Promise<void>{
    const card=await this.authorize(id,actor);
    if(this.config.editorMode==='browser'){await this.api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:'<'+browserEditorUrl(card,this.config.publicOrigin!)+'|rhwp에서 편집> · Slack 계정으로 로그인해 주세요.'});return;}
    const ticket=await this.sessions.issue(id,actor);
    await this.api.call('entity.presentDetails',{trigger_id:triggerId,metadata:documentMetadata(card,this.config.publicOrigin!,`${this.config.editorOrigin??this.config.publicOrigin}/editor/#ticket=${ticket}`)});
  }
  async matchesUrl(id:string,url:unknown):Promise<boolean>{
    const card=await this.store.get<CloudCard>('cards',id);
    return !!card&&!card.removed&&typeof url==='string'&&[this.config.publicOrigin,card.origin].some(origin=>!!origin&&url===`${origin}/documents/${id}`);
  }
  async submit(actor:Actor,fileId:string,key:string,mode:Mode='open'):Promise<string>{
    await this.accessConfig(actor);if(!ID.file.test(fileId))denied();
    // Preserve request identities imported from the single-server deployment.
    if(key.startsWith('thread:')){
      const oldId=await this.store.get<string>('threads',key.slice(7));
      if(oldId){const old=await this.authorize(oldId,actor);if(old.fileId!==fileId)throw new Error('Imported thread conflict');return oldId;}
    }
    const id=stableId(JSON.stringify([actor.teamId,actor.channelId,key]));
    await this.store.atomic<Request,void>('preparations',id,current=>{
      if(current&&(current.fileId!==fileId||current.actor.teamId!==actor.teamId||current.actor.channelId!==actor.channelId||(current.mode??'open')!==mode))throw new Error('Request conflict');
      return {value:current??{actor,fileId,mode},result:undefined};
    });
    if(!await this.store.get('cards',id))await this.reaction(id,actor,'pending',false);
    await this.tasks.enqueue('prepare:'+id,{teamId:actor.teamId,cardId:id,kind:'prepare'});return id;
  }
  async retryPreview(id:string,actor:Actor,messageTs:string,requestId?:string):Promise<void>{
    return this.schedulePreview(id,actor,messageTs,'preview',requestId);
  }
  async morePages(id:string,actor:Actor,messageTs:string,requestId?:string):Promise<void>{
    return this.schedulePreview(id,actor,messageTs,'images',requestId);
  }
  async exportMarkdown(id:string,actor:Actor,messageTs:string,task?:TaskContext):Promise<{id:string;url?:string}>{
    await this.authorize(id,actor,task);
    return this.locked(id,async(card,lease)=>{
      const context:LeaseContext={...lease,signal:AbortSignal.any([lease.signal,...(task?[task.signal]:[])]),checkpoint:async()=>{await lease.checkpoint();await task?.checkpoint();}};
      await context.checkpoint();await this.authorize(id,actor,context);
      if(card.messageTs!==messageTs)denied();
      if(card.markdownFileId&&card.markdownAttempt?.saved)return {id:card.markdownFileId,url:card.markdownUrl};
      const source=await this.ensureSource(id,actor,context.signal);
      const bytes=await (this.options.markdown??convertMarkdown)(source,{timeoutMs:120_000,signal:context.signal});
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MARKDOWN_BYTES)throw new UserError('markdown_output','Markdown 변환 결과를 확인할 수 없습니다.');
      await this.authorize(id,actor,context);
      const destination={...actor,threadTs:card.actor.threadTs??card.messageTs};
      const result=await this.uploads(card,context).share(card.markdownAttempt??={},bytes,card.name.replace(/\.(hwp|hwpx)$/i,'').slice(0,170)+'.md',destination,async()=>{await this.authorize(id,actor,context);});
      card.markdownFileId=result.id;card.markdownUrl=result.url;await this.write(card,context);
      try{await this.update(card,actor,context);}catch{/* The confirmed file receipt remains authoritative. */}
      return result;
    });
  }
  async exportFile(id:string,actor:Actor,messageTs:string,value:ExportRequest,task?:TaskContext):Promise<{id:string;url?:string}>{
    const request=normalizeExportRequest(value),key=exportKey(request);
    await this.authorize(id,actor,task);
    return this.locked(id,async(card,lease)=>{
      const context:LeaseContext={...lease,signal:AbortSignal.any([lease.signal,...(task?[task.signal]:[])]),checkpoint:async()=>{await lease.checkpoint();await task?.checkpoint();}};
      await context.checkpoint();await this.authorize(id,actor,context);
      if(card.messageTs!==messageTs)denied();
      if(request.format==='zip'&&card.pageCount&&request.pages.some(page=>page>card.pageCount!))throw new UserError('export_selection',`이 문서는 ${card.pageCount}쪽입니다. 문서 안의 쪽을 선택하세요.`);
      card.exports??={};
      let receipt=card.exports[key];
      if(receipt&&exportKey(normalizeExportRequest(receipt.request))!==key)denied();
      if(!receipt&&Object.keys(card.exports).length>=MAX_DOCUMENT_EXPORTS)throw new UserError('export_limit','이 문서의 내보내기는 서로 다른 형식·쪽 선택 20개까지 지원합니다. 기존 선택으로 다시 요청해 주세요.');
      const source=await this.ensureSource(id,actor,context.signal),sourceHash=hash(source);
      if(!card.contentHash){
        // Migrated cards need a durable baseline before any export is generated.
        // Never bind an older upload (including a different selection) to unknown bytes.
        if(Object.values(card.exports).some(value=>value.fileId||value.attempt?.fileId))throw new UserError('source_changed','기존 내보내기의 원본을 확인할 수 없습니다. 원본 파일에서 문서를 다시 요청해 주세요.');
        card.contentHash=sourceHash;await this.write(card,context);
      }
      if(receipt?.fileId&&receipt.attempt?.saved)return {id:receipt.fileId,url:receipt.url};
      if(!receipt){receipt=card.exports[key]={request};await this.write(card,context);}
      try{
      let bytes:Buffer;
      if(request.format==='txt'){
        bytes=await (this.options.text??convertText)(source,{timeoutMs:120_000,signal:context.signal});
        if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_TEXT_BYTES)throw new UserError('export_output','TXT 변환 결과를 확인할 수 없습니다.');
        try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new UserError('export_output','TXT 변환 결과를 확인할 수 없습니다.');}
      }else{
        const result=await (this.options.zip??convertPageZip)(source,{pages:request.pages,timeoutMs:120_000,signal:context.signal});
        if(!Number.isSafeInteger(result.pageCount)||result.pageCount<1||result.pageCount>200||(card.pageCount!==undefined&&card.pageCount!==result.pageCount)||!Array.isArray(result.pages)||result.pages.length!==request.pages.length||result.pages.some((page,index)=>page!==request.pages[index]||page>result.pageCount)||!Buffer.isBuffer(result.zip)||result.zip.length<22||result.zip.length>MAX_ZIP_BYTES||result.zip.readUInt32LE(0)!==0x04034b50)throw new UserError('export_output','선택한 쪽의 ZIP 변환 결과를 확인할 수 없습니다.');
        bytes=result.zip;
      }
      // A permission or same-size source change during conversion must prevent publication.
      if(hash(await this.ensureSource(id,actor,context.signal))!==sourceHash)throw new UserError('source_changed','원본 내용이 변경되었습니다. 다시 요청하세요.');
      await context.checkpoint();
      const destination={...actor,threadTs:card.actor.threadTs??card.messageTs};
      const result=await this.uploads(card,context).share(receipt.attempt??={},bytes,exportName(card.name,request),destination,async()=>{await this.authorize(id,actor,context);});
      receipt.fileId=result.id;receipt.url=result.url;await this.write(card,context);
      return result;
      }catch(error){
        // Invalid/out-of-range requests must not consume the finite receipt slots.
        // An allocated or uncertain upload must survive for reconciliation.
        if(!receipt.attempt?.fileId&&!receipt.attempt?.completing){delete card.exports[key];try{await this.write(card,context);}catch{/* Preserve the original failure. */}}
        throw error;
      }
    });
  }
  private async schedulePreview(id:string,actor:Actor,messageTs:string,kind:'preview'|'images',requestId?:string):Promise<void>{
    await this.authorize(id,actor);
    const taskId=await this.locked(id,async(card,context)=>{
      if(card.messageTs!==messageTs)denied();
      if(kind==='preview'&&card.pdf==='ready'&&card.imageState==='ready')return;
      if(kind==='images'){
        if(!card.pageCount||card.pdf!=='ready')throw new UserError('pages_pending','PDF를 준비 중입니다. 잠시 후 다시 시도하세요.');
        if(card.imageState==='ready'&&(card.images?.length??0)>=Math.min(10,card.pageCount))return;
      }
      const resumed=!!requestId&&card.previewRequestId===requestId;
      if(card.recovery&&card.recovery.state!=='failed'&&!resumed)throw new UserError('pages_pending','이미 접수되어 처리 중입니다. 잠시 후 다시 확인하세요.');
      const next=resumed&&card.recovery?card.recovery.taskId:await this.tasks.reserve(
        requestId?'preview-action:'+requestId:(kind==='preview'?'preview-retry:':'images:')+id+':'+(card.recovery?.taskId??'initial'),
        {teamId:actor.teamId,cardId:id,kind,actor});
      card.previewRequestId=requestId;
      card.recovery={taskId:next,state:'running',attempt:0,maxAttempts:MAX_TASK_ATTEMPTS};
      if(card.pdf!=='ready')card.pdf='pending';card.imageState='pending';
      await this.write(card,context);
      // A failed progress notification must not cancel already reserved work.
      try{await this.update(card,actor,context);}catch(error){notificationFailure('preview_progress',error);}
      return next;
    });
    if(taskId)await this.tasks.dispatch(taskId);
  }
  private guarded(context:TaskContext):SlackApi{return {call:async(method,args,signal)=>{
    await context.checkpoint();
    const combined=AbortSignal.any([context.signal,...(signal?[signal]:[])]);
    let result:Record<string,unknown>;
    try{result=await this.api.call(method,args,combined);}
    catch(error){
      if(context.terminalNotice?.phase!=='notice'||!isSlackFailure(error))throw error;
      await context.checkpoint();combined.throwIfAborted();
      throw new TerminalNoticeFailure(error);
    }
    if(context.terminalNotice?.phase==='notice')await context.checkpoint();
    return result;
  }};}
  private async write(card:CloudCard,context:LeaseContext):Promise<void>{
    await context.checkpoint();
    await this.store.atomic<CloudCard,void>('cards',card.id,current=>{
      if(!current||current.removed||current.fence!==context.owner)throw new Error('Card ownership changed');
      const persisted={...card,exports:savedExports(card.exports),markdownAttempt:card.markdownAttempt?savedAttempt(card.markdownAttempt):undefined,pdfAttempt:card.pdfAttempt?savedAttempt(card.pdfAttempt):undefined,attempts:card.attempts?Object.fromEntries(Object.entries(card.attempts).map(([key,value])=>[key,savedAttempt(value)])):undefined};
      return {value:{...persisted,sequence:Math.max(card.sequence??0,current.sequence??0),fence:context.owner},result:undefined};
    });
  }
  private async locked<T>(id:string,run:(card:CloudCard,context:LeaseContext)=>Promise<T>):Promise<T>{
    return withLease(this.store,'card:'+id,async context=>{
      const card=await this.store.atomic<CloudCard,CloudCard>('cards',id,current=>{
        if(!current||current.removed)denied();const value={...current,fence:context.owner};return {value,result:value};
      });return run(card,context);
    });
  }
  private uploads(card:CloudCard,context:LeaseContext,checkpoint=()=>this.write(card,context)):Uploads {
    return new Uploads(this.guarded(context),this.config,async(url,init)=>{
      await context.checkpoint();return (this.options.fetcher??fetch)(url,{...init,signal:AbortSignal.any([context.signal,...(init?.signal?[init.signal]:[])])});
    },checkpoint);
  }
  private async post(card:CloudCard,context:LeaseContext):Promise<void>{return measured('card_post',()=>this.postUnmeasured(card,context));}
  private async postUnmeasured(card:CloudCard,context:LeaseContext):Promise<void>{
    const api=this.guarded(context),uploads=this.uploads(card,context);
    if(card.messageTs)return;
    if(card.posting){
      const ts=await uploads.sharedMessage(card.fileId,{...card.actor,threadTs:card.parentTs},undefined,check=>shareCheckFinished(check,'source'));
      if(!ts)throw new UserError('card_pending','기존 카드의 공유 결과를 확인 중입니다.');
      card.messageTs=ts;card.actor.threadTs??=ts;await this.write(card,context);return;
    }
    card.posting=true;await this.write(card,context);await this.authorize(card.id,card.actor);
    const posted=await api.call('chat.postMessage',{...documentMessage(card,this.config.publicOrigin!,this.config.editorMode),client_msg_id:card.id,...(card.parentTs?{thread_ts:card.parentTs}:{})});
    if(typeof posted.ts!=='string'||!/^\d+\.\d+$/.test(posted.ts))throw new Error('Missing message receipt');
    card.messageTs=posted.ts;
    await this.recordNoticeTarget(card);
    card.actor.threadTs??=posted.ts;await this.write(card,context);milestone('first_card');
  }
  // Mint only after this application directly receives an authenticated post receipt.
  // Reconciled/shared message timestamps cannot establish ownership of a legacy card.
  private async recordNoticeTarget(card:CloudCard):Promise<void>{
    const identity=this.options.noticeIdentity;
    if(identity&&card.messageTs){await identity.check();card.noticeTarget={fileId:card.fileId,cardId:card.id,teamId:card.actor.teamId,channelId:card.actor.channelId,messageTs:card.messageTs,generation:identity.generation,botUserId:identity.botUserId};}
  }
  private async update(card:CloudCard,actor:Actor,context:LeaseContext):Promise<void>{return measured('card_update',()=>this.updateUnmeasured(card,actor,context));}
  private async updateUnmeasured(card:CloudCard,actor:Actor,context:LeaseContext):Promise<void>{
    await this.write(card,context);await this.authorize(card.id,actor);
    await this.guarded(context).call('chat.update',{...documentMessage(card,this.config.publicOrigin!,this.config.editorMode),ts:card.messageTs});
  }
  private async confirm(card:CloudCard,fileId:string,actor:Actor,context:LeaseContext,authorizationId=card.id):Promise<void>{return measured('share_confirm',()=>this.confirmUnmeasured(card,fileId,actor,context,authorizationId));}
  private async confirmUnmeasured(card:CloudCard,fileId:string,actor:Actor,context:LeaseContext,authorizationId:string):Promise<void>{
    const uploads=this.uploads(card,context);
    for(let i=0;i<6;i++){
      await this.authorize(authorizationId,actor);
      if(await uploads.sharedMessage(fileId,{...card.actor,threadTs:card.parentTs},card.messageTs,check=>shareCheckFinished(check,fileId===card.pdfFileId?'pdf':card.images?.some(page=>page.fileId===fileId)?'png':fileId===card.fileId?'source':'other',i+1)))return;
      if(i<5)await delay(200*2**i,undefined,{signal:context.signal});
    }
    throw new UserError('share_pending','파일 공유 결과를 확인 중입니다.');
  }
  async execute(spec:TaskSpec,task:TaskContext):Promise<void>{
    if(task.terminalFailure){await this.failed(spec,task,task.terminalFailure,true);return;}
    try{await this.executeWork(spec,task);}
    catch(error){
      const final=!!task.finalAttempt||isPermanentConversionFailure(errorCode(error));
      // DurableTasks commits the business failure before starting any terminal Slack notice.
      await this.failed(spec,final?{...task,terminalNotice:{phase:'bookkeeping'}}:task,errorCode(error),final).catch(()=>{});
      throw error;
    }
  }
  private async statusTarget(card:CloudCard,spec:TaskSpec,context:TaskContext):Promise<NoticeReason|undefined>{
    const identity=this.options.noticeIdentity;
    const fresh=await this.store.get<CloudCard>('cards',card.id);
    if(!fresh||fresh.removed||(fresh.recovery&&fresh.recovery.taskId!==card.recovery?.taskId))return 'superseded';
    const target=fresh.noticeTarget;
    if(!identity)return 'installation_mismatch';
    await identity.check();await context.checkpoint();
    if(!target)return 'receipt_missing';
    if(target.generation!==identity.generation||target.botUserId!==identity.botUserId)return 'installation_mismatch';
    if(target.fileId!==fresh.fileId||target.fileId!==card.fileId||fresh.messageTs!==card.messageTs||fresh.actor.channelId!==card.actor.channelId||fresh.actor.teamId!==card.actor.teamId||target.cardId!==spec.cardId||target.cardId!==card.id||target.teamId!==spec.teamId||target.teamId!==card.actor.teamId||target.channelId!==card.actor.channelId||target.messageTs!==card.messageTs||
      (spec.actor&&(spec.actor.teamId!==target.teamId||spec.actor.channelId!==target.channelId)))return 'target_mismatch';
  }
  private async failed(spec:TaskSpec,task:TaskContext,code:string,final:boolean):Promise<void>{
    await task.checkpoint();
    const card=await this.store.get<CloudCard>('cards',spec.cardId);
    if(!card){
      if(task.terminalNotice){task.terminalNotice.result='skipped';task.terminalNotice.reason='card_missing';return;}
      if(spec.kind==='prepare'){
        const request=await this.store.get<Request>('preparations',spec.cardId);
        if(request){await authorizeFile(this.api,await this.accessConfig(request.actor),request.actor,request.fileId);await this.reaction(spec.cardId,request.actor,final?'failed':'pending',true);}
      }
      return;
    }
    if(spec.teamId!==this.config.teamId||card.actor.teamId!==spec.teamId)denied();
    await this.locked(card.id,async(current,lease)=>{
      const context:LeaseContext={...lease,terminalNotice:task.terminalNotice,signal:AbortSignal.any([task.signal,lease.signal]),checkpoint:async()=>{await task.checkpoint();await lease.checkpoint();}};
      await context.checkpoint();
      // A deadline notification from an older generation cannot overwrite a manual retry.
      if(current.removed||(current.recovery&&current.recovery.taskId!==task.id)||(current.pdf==='ready'&&current.imageState==='ready')){
        if(task.terminalNotice){task.terminalNotice.result='skipped';task.terminalNotice.reason='superseded';}return;
      }
      current.recovery={taskId:task.id??'legacy',state:final?'failed':'retrying',attempt:task.attempt??1,maxAttempts:task.maxAttempts??MAX_TASK_ATTEMPTS,errorCode:code};
      if(current.pdf!=='ready')current.pdf=final?'failed':'pending';
      if(current.imageState!=='ready')current.imageState=final?'failed':'pending';
      // A revoked actor must not prevent durable failure bookkeeping.
      if(task.terminalNotice?.phase!=='notice')await this.write(current,context);
      if(task.terminalNotice?.phase==='bookkeeping'){
        // Read current policy before consuming an external attempt, without calling Slack.
        await this.mode(current.actor.channelId);
        task.terminalNotice.result=current.messageTs?'ready':'skipped';if(!current.messageTs)task.terminalNotice.reason='message_missing';return;
      }
      if(current.messageTs){
        try{await this.authorize(current.id,spec.actor??current.actor,context);}
        catch(error){
          const missing=isSourceUnavailable(error);
          // Reserve this final status for the durable notice state machine, not business retries.
          if(missing&&task.terminalNotice?.phase!=='notice')return;
          if(!missing&&(!(error instanceof UserError)||error.code!=='access_denied'))throw error;
          const blocked=await this.statusTarget(current,spec,context);
          if(blocked){if(task.terminalNotice){task.terminalNotice.result='skipped';task.terminalNotice.reason=blocked;}return;}
          try{await authorizeBotChannel(this.guarded(context),await this.accessConfig(current.actor),current.actor,context.signal);}
          catch(denial){
            if(task.terminalNotice&&denial instanceof UserError&&denial.code==='access_denied'){task.terminalNotice.result='skipped';task.terminalNotice.reason='channel_access_unavailable';return;}
            if(task.terminalNotice)task.terminalNotice.reason='channel_access_unavailable';
            throw denial;
          }
          // Never reuse documentMessage here: its file_ids/metadata can share new files.
          const text=missing?(current.pdfPreparedAt?'PDF는 생성됐지만 원본 파일에 접근할 수 없어 Slack 게시를 완료하지 못했습니다. 원본의 존재와 앱에 공유된 상태를 확인해 주세요.':'원본 파일에 접근할 수 없어 PDF·이미지 준비를 완료하지 못했습니다. 원본의 존재와 앱에 공유된 상태를 확인해 주세요.'):'문서 접근을 확인할 수 없어 PDF·이미지 준비가 중단되었습니다. 채널 참여와 문서 접근 권한을 확인해 주세요.';
          if(task.terminalNotice)task.terminalNotice.reason=missing?'source_unavailable':'access_unavailable';
          const changed=await this.statusTarget(current,spec,context);
          if(changed){if(task.terminalNotice){task.terminalNotice.result='skipped';task.terminalNotice.reason=changed;}return;}
          await this.options.noticeIdentity!.check();
          await this.guarded(context).call('chat.update',{channel:current.actor.channelId,ts:current.messageTs,text,blocks:[
            {type:'section',text:{type:'plain_text',text}},
          ],parse:'none',unfurl_links:false,unfurl_media:false});
          if(task.terminalNotice)task.terminalNotice.result='sent';
          if(!missing)await this.reaction(current.id,current.actor,final?'failed':'pending',true).catch(()=>{});
          return;
        }
        // A status update must not re-share uploaded but unconfirmed files.
        const {file_ids:_files,metadata:_metadata,...notice}=documentMessage(current,this.config.publicOrigin!,this.config.editorMode);
        await this.guarded(context).call('chat.update',{...notice,ts:current.messageTs});
        if(task.terminalNotice)task.terminalNotice.result='sent';
      }
      else if(task.terminalNotice)task.terminalNotice.result='skipped';
      await this.reaction(current.id,current.actor,final?'failed':'pending',true).catch(()=>{});
    });
  }
  private async executeWork(spec:TaskSpec,task:TaskContext):Promise<void>{
    if(spec.teamId!==this.config.teamId)denied();
    if(spec.kind==='prepare'){
      const request=await this.store.get<Request>('preparations',spec.cardId);if(!request)throw new Error('Missing request');
      const config=await this.accessConfig(request.actor),source=await authorizeFile(this.api,config,request.actor,request.fileId,task.signal);
      await this.reaction(spec.cardId,request.actor,'pending',true);
      await task.checkpoint();const bytes=await measured('download',()=>(this.options.download??downloadFile)(source,request.actor,this.config.botToken,task.signal));
      const fresh=await authorizeFile(this.api,config,request.actor,request.fileId,task.signal);if(fresh.name!==source.name||fresh.size!==source.size||fresh.downloadUrl!==source.downloadUrl)denied();
      await this.store.atomic<CloudCard,void>('cards',spec.cardId,current=>({value:current??{requestedMode:request.mode,id:spec.cardId,actor:{...request.actor},fileId:source.id,rootFileId:source.id,name:source.name,size:source.size,contentHash:hash(bytes),origin:this.config.publicOrigin,createdAt:Date.now(),revision:0,parentTs:request.actor.threadTs,pdf:'pending',imageState:'pending'},result:undefined}));
      await this.locked(spec.cardId,async(card,context)=>{await task.checkpoint();await this.post(card,context);});
      await this.tasks.enqueue('preview:'+spec.cardId,{teamId:spec.teamId,cardId:spec.cardId,kind:'preview'});
      if(request.mode==='markdown'){
        const card=await this.authorize(spec.cardId,request.actor,task);
        const inputId=hash('markdown-command:'+spec.cardId);
        await this.store.atomic('inputs',inputId,current=>({value:current??{kind:'export_markdown',actor:request.actor,cardId:card.id,messageTs:card.messageTs,terminalNoticeRequested:true},expiresAt:Date.now()+7*86400_000,result:undefined}));
        await this.tasks.enqueue('event:'+inputId,{teamId:spec.teamId,cardId:inputId,kind:'event',terminalNoticeRequested:true});
      }
      return;
    }
    await this.locked(spec.cardId,async(card,lease)=>{
      const context:LeaseContext={...lease,signal:AbortSignal.any([task.signal,lease.signal]),checkpoint:async()=>{await task.checkpoint();await lease.checkpoint();}};
      const actor=spec.actor??card.actor;await this.authorize(card.id,actor);
      if(spec.kind==='preview'&&card.pdf==='ready'&&card.imageState==='ready')return;
      await this.reaction(card.id,card.actor,'pending',true);
      card.recovery={taskId:task.id??'legacy',state:'running',attempt:task.attempt??1,maxAttempts:task.maxAttempts??MAX_TASK_ATTEMPTS};
      if(card.pdf!=='ready')card.pdf='pending';card.imageState='pending';
      await this.write(card,context);
      try{await this.update(card,actor,context);}catch(error){notificationFailure('preview_progress',error);}
      const bytes=await this.ensureSource(card.id,actor,context.signal);
      const serial=serialWrites(),persist=()=>serial(()=>this.write(card,context)),publish=()=>serial(()=>this.update(card,actor,context));
      const recordPdf=async(pdf:Buffer)=>{
        if(!pdf.subarray(0,5).equals(Buffer.from('%PDF-')))throw new Error('Invalid PDF completion evidence');
        if(!card.pdfPreparedAt){card.pdfPreparedAt=Date.now();await persist();artifactFinished('pdf_prepared');}
      };
      const pool=new BoundedWork(this.config.imageUploadConcurrency??1),pdfWork=new BoundedWork(1);
      const finishUploads=async()=>{
        // Neither failure may release the lease while the other upload still runs.
        const results=await Promise.allSettled([pdfWork.finish(),pool.finish()]);
        for(const result of results)if(result.status==='rejected')throw result.reason;
      };
      const uploads=this.uploads(card,context,persist),check=async()=>{await this.authorize(card.id,actor);};
      const target=spec.kind==='preview'?3:10;
      const setCount=async(count:number)=>{
        await context.checkpoint();
        if(card.pageCount&&card.pageCount!==count)throw new Error('Page count changed');
        card.pageCount=count;card.imageTarget=Math.min(target,count);
      };
      const publishPdf=async(pdf:Buffer,count:number)=>{
        await setCount(count);
        if(!card.pdfFileId){
          if(!card.pdfPreparedAt)await recordPdf(pdf);
          card.pdfAttempt??={};
          const f=await measured('upload_pdf',()=>uploads.store(card.pdfAttempt!,pdf,card.name.replace(/\.(hwp|hwpx)$/i,'.pdf'),actor,check));
          if(!f.url)throw new Error('PDF permalink missing');card.pdfFileId=f.id;card.pdfUrl=f.url;await persist();
        }
        if(card.pdf!=='ready'||(!!card.pdfPreparedAt&&!card.slackPublishedAt)){
          await publish();await this.confirm(card,card.pdfFileId,actor,context);
          card.pdf='ready';await publish();milestone('pdf_ready');
          if(card.pdfPreparedAt&&!card.slackPublishedAt){card.slackPublishedAt=Date.now();await persist();artifactFinished('slack_published');}
        }
      };
      const uploadPage=async(page:PageImage,count:number)=>{
        await setCount(count);card.images??=[];card.attempts??={};
        if(card.images.some(p=>p.page===page.page))return;
        const attempt=card.attempts[String(page.page)]??={};
        const f=await measured('upload_png',()=>uploads.store(attempt,page.png,`${card.name.replace(/\.(hwp|hwpx)$/i,'')}_${String(page.page).padStart(3,'0')}.png`,actor,check));
        await serial(async()=>{card.images!.push({page:page.page,fileId:f.id});card.images!.sort((a,b)=>a.page-b.page);await this.write(card,context);});
        if(page.page===1){
          await publish();await this.confirm(card,f.id,actor,context);
          card.images.find(p=>p.page===1)!.shared=true;await persist();milestone('first_image');
        }
      };
      try{
      if(card.pdfFileId){
        // Completed Slack receipts survive worker restarts. No PDF bytes or re-upload needed.
        if(!card.pageCount)throw new Error('Completed PDF has no page count');
        await publishPdf(Buffer.alloc(0),card.pageCount);
      }
      const limit=Math.min(target,card.pageCount??target);
      const first=Array.from({length:limit},(_,i)=>i+1).find(page=>!card.images?.some(p=>p.page===page));
      if(!card.pdfFileId){
        const result=await measured('conversion',()=>(this.options.convert??convertPreview)(bytes,{timeoutMs:120_000,signal:context.signal,onMetric:conversionMetric,onPdf:async(pdf,count)=>{await setCount(count);await recordPdf(pdf);await pdfWork.add(()=>publishPdf(pdf,count));},onPage:(page,count)=>pool.add(()=>uploadPage(page,count))}));
        // Also support non-streaming converter adapters. Receipts make this idempotent.
        await pdfWork.finish();await publishPdf(result.pdf,result.pageCount);await pool.finish();for(const page of result.pages)await uploadPage(page,result.pageCount);
      }else if(first!==undefined){
        const result=await measured('conversion',()=>(this.options.images??convertPageImages)(bytes,{start:first,end:limit,timeoutMs:120_000,signal:context.signal,onMetric:conversionMetric,onPage:(page,count)=>pool.add(()=>uploadPage(page,count))}));
        await pool.finish();for(const page of result.pages.filter(p=>p.page<=limit))await uploadPage(page,result.pageCount);
      }
      }finally{await finishUploads();}
      if(card.images?.some(page=>!page.shared))await this.update(card,actor,context);
      for(const page of card.images??[])if(!page.shared){await this.confirm(card,page.fileId,actor,context);page.shared=true;}
      card.imageState='ready';card.recovery=undefined;await this.update(card,actor,context);milestone('all_ready');await this.reaction(card.id,card.actor,'ready',true);
    });
    if(spec.kind==='preview'){
      const card=await this.store.get<CloudCard>('cards',spec.cardId);
      if(card?.requestedMode==='png'&&card.pdf==='ready'&&card.pageCount&&card.pageCount>3)await this.tasks.enqueue('png-command:'+card.id,{teamId:spec.teamId,cardId:card.id,kind:'images',actor:spec.actor??card.actor});
    }
  }
  private async reaction(id:string,actor:Actor,state:'pending'|'ready'|'failed',validated:boolean):Promise<void>{
    if(!this.config.reactions||!actor.reactionTs)return;
    const key=JSON.stringify([actor.teamId,actor.channelId,actor.reactionTs]);
    type Works=Record<string,{state:'pending'|'ready'|'failed';validated:boolean}>;
    await this.store.atomic<Works,void>('reaction_groups',key,current=>({value:{...current,[id]:{state,validated:validated||current?.[id]?.validated===true}},expiresAt:Date.now()+7*86400_000,result:undefined}));
    // Cosmetic errors never repeat document conversion. A subsequent transition retries them.
    await withLease(this.store,'reaction:'+hash(key),async context=>{
      const works=Object.values(await this.store.get<Works>('reaction_groups',key)??{});if(!works.some(w=>w.validated))return;
      const name=works.some(w=>w.state==='pending')?'hourglass_flowing_sand':works.some(w=>w.state==='failed')?'warning':'white_check_mark';
      for(const emoji of ['hourglass_flowing_sand','white_check_mark','warning']){
        await context.checkpoint();await this.api.call(emoji===name?'reactions.add':'reactions.remove',{channel:actor.channelId,timestamp:actor.reactionTs,name:emoji}).catch(()=>{});
      }
    }).catch(()=>{});
  }
  async status(session:Session,id:string):Promise<Receipt>{
    this.saveId(id);await this.authorize(session.cardId,session.actor);
    const op=await this.store.get<SaveOperation>('saves',this.saveKey(session,id));if(!op)throw new UserError('save_missing','저장 요청을 찾을 수 없습니다.');
    if(!op.receipt.saved)return op.receipt;
    const card=await this.authorize(op.cardId,session.actor);return {...op.receipt,pdf:card.pdf,pdfUrl:card.pdfUrl};
  }
  private saveId(id:string):void{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new UserError('request_id','저장 요청 식별자가 올바르지 않습니다.');}
  private saveKey(s:Session,id:string):string{return JSON.stringify([s.actor.teamId,s.actor.userId,s.actor.channelId,s.cardId,id]);}
  async save(session:Session,id:string,format:string,bytes:Buffer):Promise<Receipt>{
    this.saveId(id);validateInput(bytes);if(!['hwp','hwpx'].includes(format)||(bytes[0]===0x50)!==(format==='hwpx'))throw new UserError('format','문서 형식이 올바르지 않습니다.');
    const parent=await this.authorize(session.cardId,session.actor);if(!parent.actor.threadTs)denied();
    const key=this.saveKey(session,id),digest=hash(Buffer.concat([Buffer.from(format),bytes]));
    return withLease(this.store,'save:'+hash(key),async context=>{
      let op=await this.store.get<SaveOperation>('saves',key);
      if(op&&op.hash!==digest)throw new UserError('save_conflict','같은 저장 요청의 문서 내용이 다릅니다.');
      if(op?.receipt.saved){await this.tasks.enqueue('preview:'+op.cardId,{teamId:session.actor.teamId,cardId:op.cardId,kind:'preview'});return this.status(session,id);}
      if(!op){
        const family=(await this.store.list<CloudCard>('cards')).map(([,c])=>c).filter(c=>c.rootFileId===parent.rootFileId&&c.actor.channelId===parent.actor.channelId);
        const floor=Math.max(parent.revision,...family.map(c=>Math.max(c.revision,c.sequence??0)));
        const number=await this.store.atomic<number,number>('sequences',JSON.stringify([parent.actor.channelId,parent.rootFileId]),current=>{const n=Math.max(current??0,floor)+1;return {value:n,result:n};});
        op={hash:digest,cardId:randomUUID(),attempt:{},receipt:{requestId:id,saved:false,name:parent.name.replace(/(?:_편집본(?:_\d+)?)?\.(hwp|hwpx)$/i,'').slice(0,170)+`_편집본_${number}.${format}`,pdf:'waiting'}};
        await this.store.atomic('saves',key,()=>({value:op,result:undefined}));
      }
      const operation=op;
      const checkpoint=async()=>{await context.checkpoint();await this.store.atomic('saves',key,()=>({value:{...operation,attempt:savedAttempt(operation.attempt)},result:undefined}));};
      if(!operation.attempt.fileId)await validateDocument(bytes);
      const uploads=new Uploads(this.guarded(context),this.config,async(url,init)=>{await context.checkpoint();return (this.options.fetcher??fetch)(url,{...init,signal:AbortSignal.any([context.signal,...(init?.signal?[init.signal]:[])])});},checkpoint);
      const f=await uploads.store(operation.attempt,bytes,operation.receipt.name,session.actor,async()=>{await this.authorize(session.cardId,session.actor);});
      await this.store.atomic<CloudCard,void>('cards',operation.cardId,current=>({value:current??{id:operation.cardId,actor:{...session.actor,threadTs:parent.actor.threadTs},parentTs:parent.actor.threadTs,parentId:parent.id,fileId:f.id,rootFileId:parent.rootFileId,name:operation.receipt.name,size:bytes.length,createdAt:Date.now(),origin:this.config.publicOrigin,contentHash:hash(bytes),revision:Number(/_편집본_(\d+)\./.exec(operation.receipt.name)?.[1]??1),pdf:'pending',imageState:'pending'},result:undefined}));
      // The revision is private until posted; check the parent until the new file has been shared.
      await this.locked(operation.cardId,async(card,lease)=>{
        if(!card.messageTs&&!card.posting){card.posting=true;await this.write(card,lease);await this.authorize(parent.id,session.actor);
          const r=await this.guarded(lease).call('chat.postMessage',{...documentMessage(card,this.config.publicOrigin!,this.config.editorMode),client_msg_id:card.id,thread_ts:card.parentTs});
          if(typeof r.ts!=='string'||!/^\d+\.\d+$/.test(r.ts))throw new Error('Missing message receipt');
          card.messageTs=r.ts;await this.recordNoticeTarget(card);await this.write(card,lease);}
        if(!card.messageTs){const ts=await uploads.sharedMessage(f.id,{...card.actor,threadTs:card.parentTs},undefined,check=>shareCheckFinished(check,'source'));if(!ts)throw new UserError('upload_uncertain','저장 결과를 확인 중입니다. 같은 저장 요청으로 다시 확인하세요.');card.messageTs=ts;await this.write(card,lease);}
        if(this.config.editorMode==='browser'){
          // Slack chat.postMessage does not attach file_ids. Add the private revision
          // through chat.update before checking its own channel shares.
          await this.authorize(parent.id,session.actor);
          await this.guarded(lease).call('chat.update',{...documentMessage(card,this.config.publicOrigin!,this.config.editorMode),ts:card.messageTs});
        }
        await this.confirm(card,f.id,session.actor,lease,parent.id);
        await this.authorize(card.id,session.actor);
      });
      operation.receipt={...operation.receipt,saved:true,fileId:f.id,url:f.url,pdf:'pending'};await checkpoint();
      await this.tasks.enqueue('preview:'+operation.cardId,{teamId:session.actor.teamId,cardId:operation.cardId,kind:'preview'});
      return {...operation.receipt};
    });
  }
  async invalidate(fileId:string,unshared=false):Promise<void>{
    if(unshared){
      const cards=await this.store.list<CloudCard>('cards');
      const observed=await this.store.list<{file:string}>('observed');
      if(!cards.some(([,card])=>card.fileId===fileId||card.rootFileId===fileId)&&!observed.some(([,record])=>record.file===fileId))return;
    }
    let keep:ReadonlySet<string>|undefined;
    if(unshared){
      try{keep=await sharedChannels(this.api,this.config.teamId,fileId);}
      catch(error){
        const diagnostics=slackDiagnostics(error);
        if(ID.file.test(fileId)&&error instanceof UserError&&error.code==='slack_rejected'&&diagnostics.httpStatus===200&&diagnostics.slackError==='file_not_found'){
          // Unavailable is not deleted or unshared everywhere. Requests still authorize
          // the source/root on every use; preserve links and credentials for reshare.
          unshareVisibilityUnavailable();return;
        }
        throw error;
      }
    }
    for(const [id,card] of await this.store.list<CloudCard>('cards'))if((card.fileId===fileId||card.rootFileId===fileId)&&!keep?.has(card.actor.channelId)){
      await this.store.atomic<CloudCard,void>('cards',id,current=>({value:current?{...current,removed:true}:undefined,result:undefined}));await this.sessions.invalidate(id);
    }
    for(const [id,record] of await this.store.list<{file:string;channel:string}>('observed'))if(record.file===fileId&&!keep?.has(record.channel)){
      await this.store.atomic<{file:string;channel:string},void>('observed',id,current=>({value:current?.file===fileId&&!keep?.has(current.channel)?undefined:current,result:undefined}));
    }
  }
}
