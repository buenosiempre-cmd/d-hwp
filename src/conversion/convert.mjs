import {FAILURE_REASONS,failureCode} from './failures.mjs';
import {spawn} from 'node:child_process';
import {AsyncResource} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {workerEnvironment} from './worker-env.mjs';
import {readFrames,OutputError} from './frames.mjs';
import {normalizeSelectedPages} from './selection.mjs';
import {pageZip} from './zip.mjs';
export {MAX_PDF_BYTES,MAX_PNG_BYTES,MAX_PNG_TOTAL_BYTES,MAX_PREVIEW_PAGES,MAX_MARKDOWN_BYTES,MAX_TEXT_BYTES,MAX_ZIP_BYTES,MAX_MARKDOWN_PACKAGE_BYTES,MAX_MARKDOWN_REPORT_BYTES} from './frames.mjs';
const METRIC_STAGES=new Set(['wasm_compile','runtime_reuse','browser_start','process_start','input','wasm_init','parse','markdown','ocr','text','svg_render','fonts_prepare','browser_render','dom_prepare','page_attach','fonts_ready','pdf','png','output']);
export class ConversionError extends Error {constructor(code,message,stage){super(message);this.code=code;this.stage=stage;}}
export function validMetric(value){
  if(!value||!METRIC_STAGES.has(value.stage)||!['start','finish','failed'].includes(value.phase))return;
  if(value.durationMs!==undefined&&(!Number.isFinite(value.durationMs)||value.durationMs<0||value.durationMs>3600000))return;
  if(value.rssBytes!==undefined&&(!Number.isSafeInteger(value.rssBytes)||value.rssBytes<0))return;
  const details={};
  if(value.phase==='failed'){
    if(value.failureReason!==undefined){if(!FAILURE_REASONS.has(value.failureReason))return;details.failureReason=value.failureReason;}
    for(const [key,max] of [['pageNumber',200],['pageCount',1000000],['svgBytes',Number.MAX_SAFE_INTEGER]]){
      if(value[key]!==undefined){if(!Number.isSafeInteger(value[key])||value[key]<0||value[key]>max)return;details[key]=value[key];}
    }
  }
  return {...details,stage:value.stage,phase:value.phase,...(value.durationMs!==undefined?{durationMs:value.durationMs}:{}),...(value.rssBytes!==undefined?{rssBytes:value.rssBytes}:{})};
}
export function convertPdf(bytes,options={}){return convert(bytes,options,'pdf',0,0);}
export function convertMarkdown(bytes,options={}){return convert(bytes,options,'markdown',0,0);}
export function convertMarkdownPackage(bytes,options={}){return convert(bytes,options,'markdown-package',0,0);}
export function convertText(bytes,options={}){return convert(bytes,options,'text',0,0);}
export function convertSelectedPageImages(bytes,{pages,...options}={}){
  let selection;
  try{selection=normalizeSelectedPages(pages);}catch{return Promise.reject(new ConversionError('conversion_page_selection','1~200쪽 중 최대 10쪽을 선택하세요.'));}
  return convert(bytes,options,'selected',0,0,selection);
}
export async function convertPageZip(bytes,options={}){
  const started=performance.now();
  // An archive is one artifact. Never publish individual pages through callbacks before it is complete.
  const result=await convertSelectedPageImages(bytes,{...options,onPdf:undefined,onPage:undefined});
  if(options.signal?.aborted)throw new ConversionError('conversion_aborted','문서 변환이 취소되었습니다.');
  let zip;
  try{zip=pageZip(result);}catch(error){throw new ConversionError(failureCode(error?.reason),'선택 쪽 ZIP을 만들 수 없습니다.','output');}
  if(performance.now()-started>=(options.timeoutMs??60_000))throw new ConversionError('conversion_timeout','문서 변환 시간이 초과되었습니다.','output');
  return {pageCount:result.pageCount,pages:result.pages.map(image=>image.page),zip};
}
export function convertPreview(bytes,options={}){return convert(bytes,options,'preview',1,3);}
export function convertPageImages(bytes,{start=1,end=10,...options}={}){
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>10)return Promise.reject(new Error('미리보기 페이지 범위가 올바르지 않습니다.'));
  return convert(bytes,options,'images',start,end);
}
// One credential-free process per reusable runtime; at most one active document.
const MAX_PENDING=4,MAX_JOBS=20,IDLE_MS=5*60_000,MAX_RSS_BYTES=768*1024*1024;
let runtime,tail=Promise.resolve(),pending=0;
const killGroup=pid=>{if(!pid)return;try{process.kill(process.platform==='win32'?pid:-pid,'SIGKILL');}catch{}};
function dispose(r){
  if(!r||r.disposed)return;r.disposed=true;clearTimeout(r.idle);
  if(runtime===r)runtime=undefined;
  killGroup(r.server?.process().pid);void r.server?.close().catch(()=>{});killGroup(r.child?.pid);r.child?.stdout.destroy();
  r.child?.stderr.destroy();if(r.child?.connected)r.child.disconnect();
}
export async function closeConversionRuntime(){dispose(runtime);}
process.once('exit',()=>dispose(runtime));
function refs(r,active){
  for(const handle of [r.child,r.child?.stdout,r.child?.stderr,r.child?.channel,r.server?.process(),r.server?.process().stdin,r.server?.process().stdout,r.server?.process().stderr])handle?.[active?'ref':'unref']?.();
}
function startRuntime(metric){
  const r={metric,jobs:0,rss:0,disposed:false};runtime=r;
  r.ready=(async()=>{
    const started=performance.now();metric({stage:'browser_start',phase:'start'});
    const {chromium}=await import('@playwright/test');
    if(r.disposed)throw new ConversionError('conversion_aborted','문서 변환이 취소되었습니다.');
    r.server=await chromium.launchServer({headless:true,env:workerEnvironment(),host:'127.0.0.1',timeout:10000});
    if(r.disposed){killGroup(r.server.process().pid);await r.server.close().catch(()=>{});throw new ConversionError('conversion_aborted','문서 변환이 취소되었습니다.');}
    metric({stage:'browser_start',phase:'finish',durationMs:Math.round(performance.now()-started)});
    const child=spawn(process.execPath,[resolve('.cache/conversion/runtime-child.mjs')],{
      detached:process.platform!=='win32',stdio:['ignore','pipe','pipe','ipc'],serialization:'advanced',env:{...workerEnvironment(),RHWP_PDF_BROWSER_WS:r.server.wsEndpoint()},
    });r.child=child;
    const iterator=child.stdout[Symbol.asyncIterator]();r.stream={[Symbol.asyncIterator]:()=>iterator};
    return new Promise((resolveReady,rejectReady)=>{
      r.failure=error=>{rejectReady(error);r.reject?.(error);};
      child.on('message',message=>{
        if(r.disposed)return;
        if(message?.type==='ready')resolveReady();
        if(message?.type==='failure'){const value=validMetric(message.value);if(value?.phase==='failed'&&value.failureReason){const error=new ConversionError(failureCode(value.failureReason),'문서 변환에 실패했습니다.',value.stage);r.failure(error);}}
        if(message?.type==='metric'){const value=validMetric(message.value);if(value){r.rss=value.rssBytes??r.rss;r.metric?.(value);}}
      });
      child.on('error',()=>r.failure(new ConversionError('conversion_start','문서 변환기를 시작하지 못했습니다.')));
      child.on('exit',()=>{r.failure(new ConversionError('conversion_child','문서 변환에 실패했습니다.'));dispose(r);});
      r.server.on('close',()=>{r.failure(new ConversionError('conversion_child','문서 변환에 실패했습니다.'));dispose(r);});
      child.stderr.resume();
    });
  })();
  r.ready.catch(()=>{});return r;
}
function convert(bytes,{timeoutMs=60_000,onMetric,signal,onPdf,onPage,ocr}={},mode,start,end,selectedPages){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>900_000)return Promise.reject(new ConversionError('conversion_start','변환 제한 시간이 올바르지 않습니다.'));
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>20*1024*1024)return Promise.reject(new ConversionError('conversion_start','문서 크기가 올바르지 않습니다.'));
  if(pending>=MAX_PENDING)return Promise.reject(new ConversionError('conversion_busy','변환 요청이 많습니다. 잠시 후 다시 시도하세요.'));
  // Snapshot bytes only while queued/running; the tail never retains a result document.
  let input=Buffer.from(bytes),timedOut=false,executing=false;
  const controller=new AbortController(),abort=()=>controller.abort();
  let cancel;
  const cancelled=new Promise((_,reject)=>{cancel=()=>{
    input=undefined;if(executing)return;
    reject(new ConversionError(timedOut?'conversion_timeout':'conversion_aborted',timedOut?'문서 변환 시간이 초과되었습니다.':'문서 변환이 취소되었습니다.','queue'));
  };controller.signal.addEventListener('abort',cancel,{once:true});});
  const timer=setTimeout(()=>{timedOut=true;controller.abort(new ConversionError('conversion_timeout','문서 변환 시간이 초과되었습니다.'));},timeoutMs),deadline=Date.now()+timeoutMs;
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  pending++;
  const run=tail.then(()=>{
    if(controller.signal.aborted)throw new ConversionError('conversion_aborted','문서 변환이 취소되었습니다.');
    executing=true;return runConversion(input,{timeoutMs:deadline-Date.now(),onMetric,signal:controller.signal,onPdf,onPage,ocr},mode,start,end,selectedPages);
  }).finally(()=>{pending--;input=undefined;});
  tail=run.then(()=>{},()=>{});
  return Promise.race([run,cancelled]).finally(()=>{
    clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cancel);
  });
}
async function runConversion(bytes,{timeoutMs,onMetric,signal,onPdf,onPage,ocr},mode,start,end,selectedPages){
  if(signal?.aborted)throw new ConversionError('conversion_aborted','문서 변환이 취소되었습니다.');
  if(timeoutMs<=0)throw new ConversionError('conversion_timeout','문서 변환 시간이 초과되었습니다.','queue');
  let stage='runtime_start';
  // Persistent child IPC was created by an earlier request; bind diagnostics to this caller.
  const metric=AsyncResource.bind(value=>{const clean=validMetric(value);if(!clean)return;if(clean.phase==='start')stage=clean.stage;try{onMetric?.(clean);}catch{}});
  let cacheKey;
  try{cacheKey=JSON.parse(await readFile('.cache/conversion/runtime.json','utf8')).cacheKey;
    if(typeof cacheKey!=='string'||!/^[a-f0-9]{64}$/.test(cacheKey))throw new Error();
  }catch{throw new ConversionError('conversion_start','변환 자산 버전을 확인할 수 없습니다.');}
  if(signal?.aborted)throw signal.reason??new ConversionError('conversion_aborted','문서 변환이 취소되었습니다.');
  let r=runtime;
  if(r&&(r.disposed||r.cacheKey!==cacheKey||r.jobs>=MAX_JOBS||r.rss>MAX_RSS_BYTES)){dispose(r);r=undefined;}
  const reused=!!r;
  if(!r){r=startRuntime(metric);r.cacheKey=cacheKey;}
  clearTimeout(r.idle);refs(r,true);r.metric=metric;
  if(reused)metric({stage:'runtime_reuse',phase:'finish',durationMs:0});
  let timer,abort;
  const stopped=new Promise((_,reject)=>{
    const fail=code=>{const error=new ConversionError(code,code==='conversion_timeout'?'문서 변환 시간이 초과되었습니다.':'문서 변환이 취소되었습니다.',stage);reject(error);dispose(r);};
    timer=setTimeout(()=>fail('conversion_timeout'),timeoutMs);
    abort=()=>fail(signal?.reason?.code==='conversion_timeout'?'conversion_timeout':'conversion_aborted');signal?.addEventListener('abort',abort,{once:true});
    r.reject=reject;
  });
  try{
    const result=await Promise.race([stopped,(async()=>{
      await r.ready;
      if(r.disposed)throw new ConversionError('conversion_child','문서 변환에 실패했습니다.',stage);
      childSend(r.child,{type:'convert',mode,start,end,selectedPages,bytes,ocr},r.failure);
      return readFrames(r.stream,mode,start,end,{onPdf,onPage,eof:false,selectedPages});
    })()]);
    r.jobs++;r.metric=undefined;r.reject=undefined;
    refs(r,false);r.idle=setTimeout(()=>dispose(r),IDLE_MS);r.idle.unref();return result;
  }catch(error){
    dispose(r);
    if(error instanceof OutputError)throw new ConversionError('conversion_output','문서 변환 결과를 확인할 수 없습니다.',stage);
    if(error instanceof ConversionError&&!error.stage)error.stage=stage;throw error;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);r.reject=undefined;}
}
function childSend(child,message,fail){try{child.send(message,error=>{if(error)fail(new ConversionError('conversion_child','문서 변환에 실패했습니다.'));});}catch{fail(new ConversionError('conversion_child','문서 변환에 실패했습니다.'));}}
