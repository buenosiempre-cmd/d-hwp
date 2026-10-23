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
  pageCount?:number;images?:{page:number;fileId:string;shared?:boolean}[];imageTarget?:number;imageState?:'pending'|'ready'|'failed';
  imageAttempts?:Map<number,UploadAttempt>;pdfAttempt?:UploadAttempt;imageWork?:Promise<void>;updates?:Promise<void>;
}
export class Documents {
  readonly sessions:SessionAccess; readonly uploads:Uploads; readonly pdf:PdfJobs;
  private cards=new Map<string,Card>(); private closed=false;
  constructor(private config:Config,private api:SlackApi,private preparations:Preparations,private options:{state?:State;sessionStore?:MetadataStore;complete?:(card:Card)=>Promise<void>;now?:()=>number;fetcher?:typeof fetch;convert?:ConstructorParameters<typeof PdfJobs>[0];convertImages?:ConstructorParameters<typeof PdfJobs>[1]}={}) {
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
      const {imageWork:_,updates:__,imageAttempts,pdfAttempt,...record}=card;
      this.options.state?.put('cards',id,{...record,attempts:imageAttempts?[...imageAttempts].map(([page,attempt])=>[page,savedAttempt(attempt)]):undefined,pdfAttempt:pdfAttempt?savedAttempt(pdfAttempt):undefined});
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
    const card:Card={contentHash:job.contentHash,origin:this.config.publicOrigin,id:job.id,actor:{...job.actor},fileId:job.fileId,rootFileId:job.fileId,revision:0,parentTs:job.actor.threadTs,name:job.source.name,size:job.source.size,createdAt:this.now(),pdf:'pending'};
    this.cards.set(card.id,card);this.checkpoint();
    try {await this.authorize(card.id,card.actor);await this.post(card);}
    catch(error){this.checkpoint();throw error;}
    void this.preview(card,job.bytes).catch(()=>{});
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
  async close():Promise<void>{await Promise.allSettled([...this.cards.values()].map(c=>c.imageWork));await this.pdf.close();this.checkpoint();this.closed=true;this.cards.clear();this.sessions.clear();}
}
