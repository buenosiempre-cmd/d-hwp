import {setTimeout as delay} from 'node:timers/promises';
import {UserError, object} from './errors';
import {measuredSlack} from './cloud/telemetry';
import {attachSlackDiagnostics,attachResponseSizeDiagnostics,isSlackFailure} from './slack-diagnostics';
export type Method = 'views.publish' | 'reactions.add' | 'reactions.remove' | 'auth.test' | 'conversations.info' | 'conversations.members' | 'files.info' | 'chat.postEphemeral' | 'views.open' | 'chat.postMessage' | 'chat.update' | 'entity.presentDetails' | 'files.getUploadURLExternal' | 'files.completeUploadExternal';
export interface SlackApi {call(method: Method, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>;}
const queryMethods = new Set<Method>(['conversations.info','conversations.members','files.info']);
const reads = new Set<Method>(['auth.test','conversations.info','conversations.members','files.info']);
const JSON_RESPONSE_BYTES=1024*1024;
// File metadata may include previews and share history. Keep a separate, finite budget;
// never trim shares or other authorization evidence to fit the ordinary API budget.
const FILES_INFO_RESPONSE_BYTES=4*JSON_RESPONSE_BYTES;
export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const header=response.headers.get('content-length');
  const length=header!==null&&/^\d+$/.test(header)?Number(header):NaN;
  const declared=Number.isSafeInteger(length)&&length>=0?length:undefined;
  const exceeded=(read:number)=>attachResponseSizeDiagnostics(new UserError('size_limit','파일 또는 응답 크기 제한을 초과했습니다.'),{
    responseBytesRead:read,responseLimitBytes:limit,...(declared===undefined?{}:{responseContentLengthBytes:declared}),
  });
  if (declared!==undefined && declared > limit) {
    await response.body?.cancel().catch(()=>{}); throw exceeded(0);
  }
  if (!response.body) throw new UserError('empty_response','응답을 받지 못했습니다.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size=0;
  try {
    for (;;) {
      const {done,value}=await reader.read(); if (done) break;
      size+=value.byteLength;
      if (size>limit) throw exceeded(size);
      chunks.push(value);
    }
    return Buffer.concat(chunks,size);
  } finally {await reader.cancel().catch(()=>{}); reader.releaseLock();}
}
export class HttpSlackApi implements SlackApi {
  constructor(private token: string, private fetcher: typeof fetch = fetch) {}
  async call(method: Method, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try{return await measuredSlack(method,()=>this.callUnmeasured(method,args,signal));}
    catch(error){
      // An outer tenant wrapper can fail before/after this call while checking installation metadata.
      // Only errors originating in this client receive the opaque provenance marker.
      if(error&&typeof error==='object'&&!isSlackFailure(error))attachSlackDiagnostics(error,undefined);
      throw error;
    }
  }
  private async callUnmeasured(method: Method, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const deadline=AbortSignal.any([AbortSignal.timeout(30_000), ...(signal?[signal]:[])]);
    for (let attempt=0; ; attempt++) {
      deadline.throwIfAborted();
      const requestSignal=AbortSignal.any([deadline,AbortSignal.timeout(10_000)]);
      const url=new URL(`https://slack.com/api/${method}`);
      const query=queryMethods.has(method);
      // Match the Slack SDK's form encoding, including nested blocks/files/view JSON.
      const form=new URLSearchParams(Object.entries(args).filter(([,v])=>v!==undefined&&v!==null).map(([k,v]):[string,string]=>[k,typeof v==='object'?JSON.stringify(v):String(v)]));
      if(query)for(const [key,value] of Object.entries(args))url.searchParams.set(key,String(value));
      const response=await this.fetcher(url.href, {
        method:query?'GET':'POST', redirect:'error', signal:requestSignal,
        headers:{Authorization:`Bearer ${this.token}`,...(query?{}:{'Content-Type':'application/x-www-form-urlencoded'})},
        ...(query?{}:{body:form.toString()}),
      });
      if (reads.has(method) && attempt<2 && (response.status===429 || response.status>=500)) {
        const wait = response.status===429 ? Number(response.headers.get('retry-after'))*1000 : 250*(attempt+1);
        await response.body?.cancel();
        if (!Number.isFinite(wait) || wait<=0 || wait>30_000) throw attachSlackDiagnostics(new UserError('rate_limited','Slack 요청이 지연되고 있습니다. 잠시 후 다시 시도하세요.'),response.status);
        await delay(wait,undefined,{signal:deadline}); continue;
      }
      if (!response.ok) {await response.body?.cancel(); throw attachSlackDiagnostics(new UserError('slack_unavailable','Slack 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.'),response.status);}
      let data:Record<string,unknown>;
      try{data=object(JSON.parse((await readBounded(response,method==='files.info'?FILES_INFO_RESPONSE_BYTES:JSON_RESPONSE_BYTES)).toString()));}
      catch(error){if(error&&typeof error==='object')attachSlackDiagnostics(error,response.status);throw error;}
      if (data.ok!==true) throw attachSlackDiagnostics(new UserError(data.error==='already_reacted'?'already_reacted':data.error==='no_reaction'?'no_reaction':'slack_rejected','Slack에서 요청을 허용하지 않았습니다. 앱 권한과 파일 공유 상태를 확인하세요.'),response.status,data.error);
      return data;
    }
  }
}
