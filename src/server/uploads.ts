import type {SlackApi} from './slack-api';
import type {Actor} from './access';
import type {Config} from './config';
import {ID} from './config';
import {UserError,object} from './errors';
import {parseFileLink} from './commands';
export type ShareReason='file_mismatch'|'shares_missing'|'team_mismatch'|'timestamp_invalid'|'message_mismatch'|'thread_mismatch'|'ambiguous'|'confirmed'|'invalid_response'|'api_error';
export interface ShareCheck {
  readonly shareReason:ShareReason;
  readonly shareRecords?:number;
  readonly shareTeamMatches?:number;
  readonly shareValidTsMatches?:number;
  readonly shareMessageMatches?:number;
  readonly shareThreadMatches?:number;
}
export interface UploadAttempt {fileId?:string;url?:string;streamed?:boolean;completing?:boolean;saved?:boolean;permalink?:string;private?:boolean;completed?:boolean;}
export function savedAttempt(attempt:UploadAttempt):UploadAttempt {
  const {url:_,...record}=attempt;return record;
}
export class Uploads {
  onCheckpoint?:()=>void|Promise<void>;
  private async changed():Promise<void>{await this.checkpoint();await this.onCheckpoint?.();}
  constructor(private api:SlackApi,private config:Config,private fetcher:typeof fetch=fetch,private checkpoint:()=>void|Promise<void>=()=>{}){}
  async store(attempt:UploadAttempt,bytes:Buffer,name:string,actor:Actor,beforeStore:()=>Promise<void>):Promise<{id:string;url?:string}> {
    if(attempt.saved&&!attempt.private)throw new Error('Upload destination cannot change');
    attempt.private=true;return this.share(attempt,bytes,name,actor,beforeStore);
  }
  async sharedMessage(fileId:string,actor:Actor,expectedTs?:string,observer?:(check:ShareCheck)=>void):Promise<string|undefined> {
    const counts:Omit<ShareCheck,'shareReason'>={};
    const observe=(shareReason:ShareReason)=>{
      try{
        const check:ShareCheck={shareReason};
        for(const key of ['shareRecords','shareTeamMatches','shareValidTsMatches','shareMessageMatches','shareThreadMatches'] as const){
          if(counts[key]!==undefined)Object.assign(check,{[key]:counts[key]});
        }
        observer?.(Object.freeze(check));
      }catch{/* Diagnostics cannot change sharing results. */}
    };
    let response:Record<string,unknown>;
    try{response=await this.api.call('files.info',{file:fileId});}
    catch(error){observe('api_error');throw error;}
    try{
      const f=object(response.file);
      if(f.id!==fileId){observe('file_mismatch');return;}
      const shares=object(f.shares);const records=object(shares.public??{})[actor.channelId]??object(shares.private??{})[actor.channelId];
      if(!Array.isArray(records)){observe('shares_missing');return;}
      Object.assign(counts,{shareRecords:records.length});
      const candidates=records.map(object);
      let team=0,ts=0,message=0,thread=0;
      const matches=candidates.filter(s=>{
        if(s.team_id!==actor.teamId)return false;team++;
        if(typeof s.ts!=='string'||!/^\d+\.\d+$/.test(s.ts))return false;ts++;
        if(expectedTs&&s.ts!==expectedTs)return false;message++;
        if(actor.threadTs?s.thread_ts!==actor.threadTs:!!s.thread_ts)return false;thread++;
        return true;
      });
      Object.assign(counts,{shareTeamMatches:team,shareValidTsMatches:ts,shareMessageMatches:message,shareThreadMatches:thread});
      const result=matches.length===1?String(matches[0].ts):undefined;
      observe(!records.length?'shares_missing':!team?'team_mismatch':!ts?'timestamp_invalid':!message?'message_mismatch':!thread?'thread_mismatch':matches.length>1?'ambiguous':'confirmed');
      return result;
    }catch(error){observe('invalid_response');throw error;}
  }
  async share(attempt:UploadAttempt,bytes:Buffer,name:string,actor:Actor,beforeShare:()=>Promise<void>):Promise<{id:string;url?:string}> {
    if(attempt.fileId&&!attempt.streamed&&!attempt.url){attempt.fileId=undefined;}
    if(!attempt.fileId){
      const r=await this.api.call('files.getUploadURLExternal',{filename:name,length:bytes.length});
      if(typeof r.file_id!=='string'||!ID.file.test(r.file_id)||typeof r.upload_url!=='string')throw new UserError('upload_failed','업로드를 준비하지 못했습니다.');
      const url=new URL(r.upload_url);
      if(url.protocol!=='https:'||url.hostname!=='files.slack.com'||url.port||url.username||url.password||!url.pathname.startsWith('/upload/v1/')||url.hash)throw new UserError('upload_url','업로드 주소를 확인할 수 없습니다.');
      attempt.fileId=r.file_id;attempt.url=url.href;await this.changed();
    }
    if(!attempt.streamed){
      try{
        const response=await this.fetcher(attempt.url!,{method:'POST',redirect:'error',headers:{'Content-Type':'application/octet-stream'},body:new Uint8Array(bytes),signal:AbortSignal.timeout(30_000)});
        await response.body?.cancel();if(!response.ok)throw new Error('stream');attempt.streamed=true;await this.changed();
      }catch{attempt.fileId=undefined;attempt.url=undefined;throw new UserError('upload_failed','파일 전송에 실패했습니다. 다시 저장해 주세요.');}
    }
    if(!(attempt.private?attempt.completed:attempt.saved) && !attempt.completing){
      await beforeShare();attempt.completing=true;await this.changed();
      try{
        const result=await this.api.call('files.completeUploadExternal',{files:[{id:attempt.fileId,title:name}],...(attempt.private?{}:{channel_id:actor.channelId,...(actor.threadTs?{thread_ts:actor.threadTs}:{})})});
        if(!Array.isArray(result.files)||!result.files.some(f=>object(f).id===attempt.fileId))throw new Error('missing receipt');
        if(attempt.private)attempt.completed=true;else attempt.saved=true;
      }catch{/* Completion might have succeeded. Reconcile this file ID; never complete a second file. */}
    }
    if(!(attempt.private?attempt.completed:attempt.saved)){
      try {
      const f=object((await this.api.call('files.info',{file:attempt.fileId})).file);
      if(attempt.private&&f.id===attempt.fileId&&f.mode==='hosted'&&f.size===bytes.length&&f.name===name&&typeof f.permalink==='string')attempt.completed=true;
      const shares=object(f.shares);const publicShares=shares.public as Record<string,unknown>|undefined;const privateShares=shares.private as Record<string,unknown>|undefined;
      const records=publicShares?.[actor.channelId]??privateShares?.[actor.channelId];
      if(f.id===attempt.fileId&&Array.isArray(records)&&records.some(r=>{const s=object(r);return s.team_id===actor.teamId&&(!actor.threadTs||s.thread_ts===actor.threadTs);}))attempt.saved=true;
      }catch{/* Reconciliation is inconclusive; retain the original attempt. */}
      if(!(attempt.private?attempt.completed:attempt.saved))throw new UserError('upload_uncertain','저장 결과를 확인 중입니다. 같은 저장 요청으로 다시 확인해 주세요.');
    }
    if(!attempt.permalink){
      try{const f=object((await this.api.call('files.info',{file:attempt.fileId})).file);if(f.id===attempt.fileId&&typeof f.permalink==='string'&&parseFileLink(f.permalink,this.config.workspaceHost)===attempt.fileId)attempt.permalink=f.permalink;}catch{/* Uploaded file remains saved even when the link lookup fails. */}
    }
    await this.changed();return {id:attempt.fileId!,url:attempt.permalink};
  }
}
