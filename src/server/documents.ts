import {documentMetadata,documentGallery,documentMessage} from './document-message';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {authorizeFile, type Actor} from './access';
import type {Config} from './config';
import type {SlackApi} from './slack-api';
import type {Preparations,Job} from './jobs';
import {Sessions,type SessionAccess} from './sessions';
import {SharedSessions} from './cloud/sessions';
import type {MetadataStore} from './cloud/metadata';
import {Uploads,savedAttempt,type UploadAttempt} from './uploads';
import type {PageImages,PageImage} from '../conversion/convert.mjs';
import {convertMarkdown,MAX_MARKDOWN_BYTES,convertText,convertPageZip,MAX_TEXT_BYTES,MAX_ZIP_BYTES} from '../conversion/convert.mjs';
import {normalizeExportRequest,exportKey,exportName,savedExports,MAX_DOCUMENT_EXPORTS,type ExportRequest,type ExportReceipt} from './document-exports';
import {PdfJobs} from './pdf-jobs';
import type {State} from './state';
import {denied,UserError} from './errors';
export interface Card {
  noticeTarget?:{fileId:string;cardId:string;teamId:string;channelId:string;messageTs:string;generation:string;botUserId:string};
  id:string;actor:Actor;fileId:string;rootFileId:string;name:string;size:number;createdAt:number;
  origin?:string;contentHash?:string;
  revision:number;sequence?:number;parentId?:string;parentTs?:string;messageTs?:string;posting?:boolean;
  recovery?:{taskId:string;state:'running'|'retrying'|'failed';attempt:number;maxAttempts:number;errorCode?:string};
  pdf:'pending'|'ready'|'failed';pdfUrl?:string;pdfFileId?:string;
  requestedMode?:import('./commands').Mode;
  markdownAttempt?:UploadAttempt;markdownFileId?:string;markdownUrl?:string;
  exports?:Record<string,ExportReceipt>;
  pageCount?:number;images?:{page:number;fileId:string;shared?:boolean}[];imageTarget?:number;imageState?:'pending'|'ready'|'failed';
  imageAttempts?:Map<number,UploadAttempt>;pdfAttempt?:UploadAttempt;imageWork?:Promise<void>;updates?:Promise<void>;
}
export class Documents {
  readonly sessions:SessionAccess; readonly uploads:Uploads; readonly pdf:PdfJobs;
  private cards=new Map<string,Card>(); private closed=false;
  private markdownWork=new Map<string,Promise<{id:string;url?:string}>>();
  private exportWork=new Map<string,Promise<{id:string;url?:string}>>();
  constructor(private config:Config,private api:SlackApi,private preparations:Preparations,private options:{state?:State;sessionStore?:MetadataStore;complete?:(card:Card)=>Promise<void>;now?:()=>number;fetcher?:typeof fetch;convert?:ConstructorParameters<typeof PdfJobs>[0];convertImages?:ConstructorParameters<typeof PdfJobs>[1];markdown?:typeof convertMarkdown;text?:typeof convertText;zip?:typeof convertPageZip}={}) {
    this.now=options.now??Date.now;
    const checkSession=async(id:string,actor:Actor)=>{await this.authorize(id,actor);};
    this.sessions=options.sessionStore?new SharedSessions(options.sessionStore,checkSession,this.now):new Sessions(this.now,checkSession);
    this.uploads=new Uploads(api,config,options.fetcher,()=>this.checkpoint());this.pdf=new PdfJobs(options.convert,options.convertImages);
    for(const [id,record] of options.state?.all<Card & {attempts?:[number,UploadAttempt][]}>('cards')??[]){
      const {attempts,...card}=record;if(card.actor.teamId!==config.teamId)continue;
      if(attempts)card.imageAttempts=new Map(attempts);this.cards.set(id,card);
    }
  }
  private now:()=>number;
  checkpoint():void {
    for(const [id,card] of this.cards){
      const {imageWork:_,updates:__,imageAttempts,pdfAttempt,markdownAttempt,exports,...record}=card;
      this.options.state?.put('cards',id,{...record,exports:savedExports(exports),attempts:imageAttempts?[...imageAttempts].map(([page,attempt])=>[page,savedAttempt(attempt)]):undefined,pdfAttempt:pdfAttempt?savedAttempt(pdfAttempt):undefined,markdownAttempt:markdownAttempt?savedAttempt(markdownAttempt):undefined});
    }
  }
  pendingIds():string[]{return [...this.cards.values()].filter(c=>c.pdf==='pending'||c.imageState==='pending').map(c=>c.id);}
  has(id:string):boolean{return this.cards.has(id);}
  matchesUrl(id:string,url:unknown):boolean {
    const card=this.cards.get(id);return typeof url==='string'&&(url===this.url(id)||(!!card?.origin&&url===`${card.origin}/documents/${id}`));
  }
  async ensureSource(id:string,actor:Actor):Promise<Buffer>{
    const card=await this.authorize(id,actor);
    const bytes=await this.preparations.restore(id,actor,card.fileId);
    await this.authorize(id,actor);
    if(card.contentHash&&createHash('sha256').update(bytes).digest('hex')!==card.contentHash)throw new UserError('source_changed','원본 파일 내용이 변경되었습니다. 원본 메시지에서 다시 요청해 주세요.');
    return bytes;
  }
  async recover():Promise<void>{
    for(const card of this.cards.values()){
      if(card.pdf!=='pending'&&card.imageState!=='pending')continue;
      try {
        await this.authorize(card.id,card.actor);
        if(!card.messageTs){
          // A lost post response cannot be blindly repeated. Only a unique share is accepted.
          if(card.posting)await this.confirmShare(card,card.fileId,()=>this.authorize(card.id,card.actor));
          else await this.post(card);
        }
        const bytes=await this.ensureSource(card.id,card.actor);
        if(card.pdf==='ready'&&card.pageCount)await this.morePages(card.id,card.actor,card.messageTs!);
        else await this.preview(card,bytes);
      }catch{card.pdf=card.pdf==='ready'?'ready':'failed';card.imageState='failed';await this.options.complete?.(card).catch(()=>{});}
      this.checkpoint();
    }
    // Command intent and upload receipts survive a restart, including a lost upload response.
    for(const card of this.cards.values()){
      if(!card.messageTs)continue;
      try{
        if(card.requestedMode==='markdown'&&!card.markdownAttempt?.saved)await this.exportMarkdown(card.id,card.actor,card.messageTs);
        if(card.requestedMode==='png'&&card.pdf==='ready'&&card.imageState==='ready'&&(card.images?.length??0)<Math.min(10,card.pageCount??0))await this.morePages(card.id,card.actor,card.messageTs);
      }catch{/* Preserve receipts and allow a member to retry from the document card. */}
    }
  }
  url(id:string):string{return `${this.config.publicOrigin}/documents/${id}`;}
  async authorize(id:string,actor:Actor):Promise<Card> {
    this.sweep();const card=this.cards.get(id);
    if(!card)throw new UserError('card_missing','문서 연결을 찾을 수 없습니다. 원본 메시지 메뉴의 한글 문서 열기로 다시 요청해 주세요.');
    if(this.closed||card.actor.teamId!==actor.teamId||card.actor.channelId!==actor.channelId)denied();
    const source=await authorizeFile(this.api,this.config,actor,card.fileId);
    // A revision cannot be used to bypass revocation of the original document.
    if(card.rootFileId!==card.fileId)await authorizeFile(this.api,this.config,actor,card.rootFileId);
    if(this.closed||this.cards.get(id)!==card||source.name!==card.name||source.size!==card.size)denied();
    return card;
  }
  source(id:string):Buffer {
    const job=this.preparations.get(id);
    if(!job?.bytes||job.state!=='ready')throw new UserError('source_expired','문서 준비가 만료되었습니다. /rhwp open으로 다시 요청하세요.');
    return job.bytes;
  }
  private metadata(card:Card,previewUrl?:string){return documentMetadata(card,this.config.publicOrigin!,previewUrl);}
  private gallery(card:Card){return documentGallery(card);}
  private message(card:Card){return documentMessage(card,this.config.publicOrigin!);}
  private update(card:Card,actor=card.actor):Promise<void>{
    const next=(card.updates??Promise.resolve()).catch(()=>{}).then(async()=>{
      this.checkpoint();await this.authorize(card.id,actor);await this.api.call('chat.update',{...this.message(card),ts:card.messageTs,...(this.gallery(card).length?{file_ids:this.gallery(card).map(image=>image.fileId)}:{})});
    });card.updates=next;return next;
  }
  private async post(card:Card):Promise<void> {
    if(card.messageTs||card.posting)return;
    card.posting=true; // An uncertain response is reconciled through this private file's share, never reposted.
    this.checkpoint();const posted=await this.api.call('chat.postMessage',{...this.message(card),client_msg_id:card.id,...(card.parentTs?{thread_ts:card.parentTs}:{})});
    if(typeof posted.ts!=='string'||!/^\d+\.\d+$/.test(posted.ts))throw new UserError('card_failed','문서 카드의 대화를 확인하지 못했습니다. 같은 저장 요청으로 다시 확인하세요.');
    card.messageTs=posted.ts;card.actor.threadTs??=posted.ts;this.checkpoint();
  }
  private async confirmShare(card:Card,fileId:string,check:()=>Promise<unknown>):Promise<void> {
    for(let i=0;i<6;i++){
      await check();
      const ts=await this.uploads.sharedMessage(fileId,{...card.actor,threadTs:card.parentTs},card.messageTs);
      if(ts){card.messageTs??=ts;card.actor.threadTs??=ts;this.checkpoint();return;}
      if(i<5)await delay(200*2**i);
    }
    throw new UserError('card_pending','카드의 파일 공유를 확인 중입니다. 같은 저장 요청으로 다시 확인하세요.');
  }
  async publish(job:Readonly<Job>):Promise<void> {
    if(!job.source||!job.bytes||job.state!=='ready')return;
    this.sweep();if(this.closed||this.cards.size>=1000)throw new UserError('busy','문서 요청이 많습니다.');
    const card:Card={requestedMode:job.mode,contentHash:job.contentHash,origin:this.config.publicOrigin,id:job.id,actor:{...job.actor},fileId:job.fileId,rootFileId:job.fileId,revision:0,parentTs:job.actor.threadTs,name:job.source.name,size:job.source.size,createdAt:this.now(),pdf:'pending'};
    this.cards.set(card.id,card);this.checkpoint();
    try {await this.authorize(card.id,card.actor);await this.post(card);}
    catch(error){this.checkpoint();throw error;}
    void this.preview(card,job.bytes).then(async()=>{if(job.mode==='png'&&card.pdf==='ready'&&card.messageTs)await this.morePages(card.id,job.actor,card.messageTs);}).catch(()=>{});
    if(job.mode==='markdown')await this.exportMarkdown(card.id,job.actor,card.messageTs!);
  }
  async exportMarkdown(id:string,actor:Actor,messageTs:string):Promise<{id:string;url?:string}>{
    const card=await this.authorize(id,actor);if(card.messageTs!==messageTs)denied();
    const existing=this.markdownWork.get(id);
    if(existing){const result=await existing;await this.authorize(id,actor);return result;}
    const work=(async()=>{
      if(card.markdownFileId&&card.markdownAttempt?.saved)return {id:card.markdownFileId,url:card.markdownUrl};
      const source=await this.ensureSource(id,actor);
      const bytes=await (this.options.markdown??convertMarkdown)(source,{timeoutMs:120_000});
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MARKDOWN_BYTES)throw new UserError('markdown_output','Markdown 변환 결과를 확인할 수 없습니다.');
      await this.authorize(id,actor);
      const destination={...actor,threadTs:card.actor.threadTs??card.messageTs};
      const result=await this.uploads.share(card.markdownAttempt??={},bytes,card.name.replace(/\.(hwp|hwpx)$/i,'').slice(0,170)+'.md',destination,async()=>{await this.authorize(id,actor);});
      card.markdownFileId=result.id;card.markdownUrl=result.url;this.checkpoint();
      await this.update(card,actor).catch(()=>{});
      return result;
    })();
    this.markdownWork.set(id,work);
    try{return await work;}finally{if(this.markdownWork.get(id)===work)this.markdownWork.delete(id);}
  }
  async exportFile(id:string,actor:Actor,messageTs:string,input:ExportRequest):Promise<{id:string;url?:string}>{
    const request=normalizeExportRequest(input),key=exportKey(request),workKey=id+':'+key;
    const card=await this.authorize(id,actor);if(card.messageTs!==messageTs)denied();
    if(request.format==='zip'&&card.pageCount&&request.pages.some(page=>page>card.pageCount!))throw new UserError('export_selection',`이 문서는 ${card.pageCount}쪽입니다. 문서 안의 쪽을 선택하세요.`);
    const existing=this.exportWork.get(workKey);
    if(existing){const result=await existing;await this.authorize(id,actor);return result;}
    card.exports??={};
    if(!card.exports[key]&&Object.keys(card.exports).length>=MAX_DOCUMENT_EXPORTS)throw new UserError('export_limit','이 문서에서는 서로 다른 내보내기를 20개까지 만들 수 있습니다. 이전 선택으로 다시 받거나 원본 메시지에서 새 변환 카드를 준비하세요.');
    const receipt=card.exports[key]??={request};this.checkpoint();
    const work=(async()=>{
      const source=await this.ensureSource(id,actor);
      // Imported cards may predate content hashes. Pin the first export before
      // any upload; an older unbound upload cannot be trusted against new bytes.
      if(!card.contentHash){
        if(Object.values(card.exports!).some(item=>item.fileId||item.attempt?.fileId))throw new UserError('source_changed','이전 내보내기의 원본 버전을 확인할 수 없습니다. 새 변환 카드를 준비하세요.');
        card.contentHash=createHash('sha256').update(source).digest('hex');this.checkpoint();
      }
      if(receipt.fileId&&receipt.attempt?.saved)return {id:receipt.fileId,url:receipt.url};
      let bytes:Buffer;
      if(request.format==='txt'){
        bytes=await (this.options.text??convertText)(source,{timeoutMs:120_000});
        if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_TEXT_BYTES)throw new UserError('export_output','TXT 변환 결과를 확인할 수 없습니다. 텍스트가 없거나 2 MiB를 넘는 문서일 수 있습니다.');
        try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new UserError('export_output','TXT 문자 인코딩을 확인할 수 없습니다.');}
      }else{
        const result=await (this.options.zip??convertPageZip)(source,{pages:request.pages,timeoutMs:120_000});
        bytes=result.zip;
        if(!Number.isInteger(result.pageCount)||result.pageCount<1||result.pageCount>200||(card.pageCount&&result.pageCount!==card.pageCount)||request.pages.some(page=>page>result.pageCount)||!Array.isArray(result.pages)||result.pages.length!==request.pages.length||result.pages.some((page,index)=>page!==request.pages[index])||!Buffer.isBuffer(bytes)||bytes.length<22||bytes.length>MAX_ZIP_BYTES||bytes.readUInt32LE(0)!==0x04034b50)throw new UserError('export_output','선택 쪽 ZIP 변환 결과를 확인할 수 없습니다.');
      }
      await this.authorize(id,actor);
      const destination={...actor,threadTs:card.actor.threadTs??card.messageTs};
      const result=await this.uploads.share(receipt.attempt??={},bytes,exportName(card.name,request),destination,async()=>{await this.authorize(id,actor);});
      receipt.fileId=result.id;receipt.url=result.url;this.checkpoint();return result;
    })();
    this.exportWork.set(workKey,work);
    try{return await work;}catch(error){
      // A failed conversion consumes no receipt slot. Never discard an allocated upload.
      if(!receipt.attempt?.fileId&&!receipt.attempt?.completing){delete card.exports[key];this.checkpoint();}
      throw error;
    }finally{if(this.exportWork.get(workKey)===work)this.exportWork.delete(workKey);}
  }
  revisionName(parent:Card,format:string):string {
    const number=Math.max(0,...[...this.cards.values()].filter(c=>c.rootFileId===parent.rootFileId&&c.actor.channelId===parent.actor.channelId).map(c=>Math.max(c.revision,c.sequence??0)))+1;
    parent.sequence=number;this.checkpoint();
    return parent.name.replace(/(?:_편집본(?:_\d+)?)?\.(hwp|hwpx)$/i,'').slice(0,170)+`_편집본_${number}.${format}`;
  }
  async publishRevision(id:string,parentId:string,actor:Actor,fileId:string,name:string,bytes:Buffer):Promise<Card> {
    const parent=await this.authorize(parentId,actor);
    if(!parent.actor.threadTs)denied();
    let card=this.cards.get(id);
    if(!card){
      this.sweep();if(this.closed||this.cards.size>=1000)throw new UserError('busy','문서 요청이 많습니다.');
      const job=this.preparations.retain(id,actor,fileId,name,bytes);
      card={contentHash:job.contentHash,origin:this.config.publicOrigin,id,actor:{...actor,threadTs:parent.actor.threadTs},fileId,rootFileId:parent.rootFileId,parentId,parentTs:parent.actor.threadTs,name,size:job.source!.size,revision:Number(/_편집본_(\d+)\./.exec(name)?.[1]??1),createdAt:this.now(),pdf:'pending'};
      this.cards.set(id,card);this.checkpoint();
    }
    this.preparations.retain(id,actor,fileId,name,bytes);
    try{await this.post(card);}catch{/* Reconcile the same file and card after an uncertain post. */}
    await this.confirmShare(card,fileId,()=>this.authorize(parentId,actor));
    await this.authorize(card.id,actor);
    return card;
  }
  private async storeImage(card:Card,image:PageImage,actor:Actor):Promise<void>{
    card.images??=[];if(card.images.some(p=>p.page===image.page))return;
    const attempts=card.imageAttempts??=new Map();let attempt=attempts.get(image.page);
    if(!attempt){attempt={};attempts.set(image.page,attempt);}
    const name=card.name.replace(/\.(hwp|hwpx)$/i,'')+'_'+String(image.page).padStart(2,'0')+'페이지.png';
    const file=await this.uploads.store(attempt,image.png,name,actor,async()=>{await this.authorize(card.id,actor);});
    card.images.push({page:image.page,fileId:file.id});this.checkpoint();
  }
  private async shareImages(card:Card,images:PageImage[],actor:Actor):Promise<void>{
    for(let i=0;i<images.length;i+=2){
      const batch=images.slice(i,i+2);
      const results=await Promise.allSettled(batch.map(image=>this.storeImage(card,image,actor)));
      await this.update(card,actor);
      for(const image of batch){const stored=this.gallery(card).find(p=>p.page===image.page);if(stored){await this.confirmShare(card,stored.fileId,()=>this.authorize(card.id,actor));stored.shared=true;}}
      if(results.some(r=>r.status==='rejected'))throw new UserError('image_failed','일부 페이지 이미지를 준비하지 못했습니다. 다시 요청하세요.');
    }
  }
  async preview(card:Card,bytes:Buffer):Promise<void>{
    if(card.imageWork)return card.imageWork;
    card.imageState='pending';card.imageTarget=3;this.checkpoint();
    const work=this.pdf.run(bytes,async(pdf,result)=>{
      card.pageCount=result?.pageCount;card.imageTarget=result?Math.min(3,result.pageCount):0;
      const first=result?.pages.slice(0,1)??[];
      const ready=await Promise.allSettled([
        (async()=>{if(card.pdfFileId&&card.pdfUrl)return;const file=await this.uploads.store(card.pdfAttempt??={},pdf,card.name.replace(/\.(hwp|hwpx)$/i,'.pdf'),card.actor,async()=>{await this.authorize(card.id,card.actor);});
          if(!file.url)throw new Error('Missing PDF permalink');card.pdfFileId=file.id;card.pdfUrl=file.url;})(),
        ...first.map(image=>this.storeImage(card,image,card.actor)),
      ]);
      if(ready[0].status==='rejected')card.pdf='failed';
      await this.update(card);
      if(card.pdfFileId){await this.confirmShare(card,card.pdfFileId,()=>this.authorize(card.id,card.actor));card.pdf='ready';await this.update(card);}
      for(const image of first){const stored=card.images?.find(p=>p.page===image.page);if(stored){await this.confirmShare(card,stored.fileId,()=>this.authorize(card.id,card.actor));stored.shared=true;}}
      await this.shareImages(card,result?.pages.slice(1)??[],card.actor);
      card.imageState=ready.slice(1).some(r=>r.status==='rejected')?'failed':'ready';
      await this.update(card);
    }).catch(async()=>{
      if(card.pdf!=='ready')card.pdf='failed';card.imageState='failed';
      if(!this.closed&&this.cards.get(card.id)===card&&card.messageTs)await this.update(card).catch(()=>{});
    });
    card.imageWork=work;try{await work;}finally{if(card.imageWork===work)card.imageWork=undefined;this.checkpoint();await this.options.complete?.(card).catch(()=>{});}
  }
  async morePages(id:string,actor:Actor,messageTs:string):Promise<void>{
    const card=await this.authorize(id,actor);if(card.messageTs!==messageTs)denied();
    if(card.imageWork)return card.imageWork;
    if(!card.pageCount)throw new UserError('pages_pending','페이지 수를 확인하지 못했습니다. 문서를 다시 요청하세요.');
    const target=card.imageState==='failed'||card.imageState==='pending'?(card.imageTarget??3):Math.min(10,card.pageCount);
    const have=new Set((card.images??[]).filter(p=>p.shared).map(p=>p.page));
    const missing=Array.from({length:target},(_,i)=>i+1).filter(page=>!have.has(page));if(!missing.length)return;
    const bytes=await this.ensureSource(id,actor);card.imageTarget=target;card.imageState='pending';
    const work=(async()=>{
      await this.update(card,actor);
      await this.pdf.images(bytes,missing[0],target,async(result:PageImages)=>{
        if(result.pageCount!==card.pageCount)throw new Error('Page count changed');
        await this.shareImages(card,result.pages.filter(p=>!have.has(p.page)),actor);
        card.imageState='ready';await this.update(card,actor);
      });
    })().catch(async()=>{card.imageState='failed';await this.update(card,actor).catch(()=>{});});
    card.imageWork=work;try{await work;}finally{if(card.imageWork===work)card.imageWork=undefined;this.checkpoint();await this.options.complete?.(card).catch(()=>{});}
  }
  async present(id:string,actor:Actor,triggerId:string):Promise<void> {
    const card=await this.authorize(id,actor);if(!card.messageTs)throw new UserError('card_pending','카드 게시 결과를 확인 중입니다. 잠시 후 다시 열어 주세요.');await this.ensureSource(id,actor);
    const ticket=await this.sessions.issue(id,{...actor,threadTs:card.actor.threadTs});
    await this.api.call('entity.presentDetails',{trigger_id:triggerId,metadata:this.metadata(card,`${this.config.editorOrigin??this.config.publicOrigin}/editor/#ticket=${ticket}`)});
  }
  async invalidate(team:string,file:string,keep?:ReadonlySet<string>):Promise<void> {
    for(const [id,c] of this.cards)if(c.actor.teamId===team&&(c.fileId===file||c.rootFileId===file)&&!keep?.has(c.actor.channelId)){this.preparations.invalidateCard(id);this.cards.delete(id);this.options.state?.delete('cards',id);await this.sessions.invalidate(id);}
  }
  sweep():void {for(const [id,c] of this.cards)if(!this.options.state&&this.now()-c.createdAt>=24*60*60_000){this.cards.delete(id);void Promise.resolve(this.sessions.invalidate(id)).catch(()=>{});}this.sessions.sweep();}
  async close():Promise<void>{await Promise.allSettled([...this.cards.values()].map(c=>c.imageWork).concat([...this.markdownWork.values(),...this.exportWork.values()].map(p=>p.then(()=>{}))));await this.pdf.close();this.checkpoint();this.closed=true;this.cards.clear();this.sessions.clear();}
}
