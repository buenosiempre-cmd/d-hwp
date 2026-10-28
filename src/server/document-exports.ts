import {UserError} from './errors';
import {savedAttempt,type UploadAttempt} from './uploads';

export type ExportRequest={format:'txt'}|{format:'markdown';ocr?:true}|{format:'zip';pages:number[]};
export interface ExportReceipt {request:ExportRequest;attempt?:UploadAttempt;fileId?:string;url?:string;}
export const MAX_DOCUMENT_EXPORTS=20;
const invalid=()=>new UserError('export_selection','1~200쪽 중 최대 10쪽을 선택하세요. 예: 1,3-5,12');

export function parsePageSelection(raw:unknown):number[]{
  if(typeof raw!=='string'||!raw.trim()||raw.length>128)throw invalid();
  const pages=new Set<number>();
  for(const part of raw.split(',')){
    const match=/^\s*([1-9]\d{0,2})(?:\s*-\s*([1-9]\d{0,2}))?\s*$/.exec(part);
    if(!match)throw invalid();
    const start=Number(match[1]),end=Number(match[2]??match[1]);
    if(start>200||end>200||start>end||end-start>=10)throw invalid();
    for(let page=start;page<=end;page++){pages.add(page);if(pages.size>10)throw invalid();}
  }
  return [...pages].sort((a,b)=>a-b);
}
export function normalizeExportRequest(value:unknown):ExportRequest{
  if(!value||typeof value!=='object')throw invalid();
  const request=value as Record<string,unknown>;
  if(request.format==='txt')return {format:'txt'};
  if(request.format==='markdown'){if(request.ocr!==undefined&&typeof request.ocr!=='boolean')throw invalid();return {format:'markdown',...(request.ocr?{ocr:true}:{})};}
  if(request.format!=='zip'||!Array.isArray(request.pages)||!request.pages.length||request.pages.length>200||request.pages.some(page=>!Number.isInteger(page)||page<1||page>200))throw invalid();
  const pages=[...new Set(request.pages as number[])].sort((a,b)=>a-b);
  if(pages.length>10)throw invalid();
  return {format:'zip',pages};
}
export function exportKey(request:ExportRequest):string{
  const normalized=normalizeExportRequest(request);
  return normalized.format==='txt'?'txt':normalized.format==='markdown'?(normalized.ocr?'markdown-v3-ocr':'markdown-v3'):'zip:'+normalized.pages.join(',');
}
export function exportName(name:string,request:ExportRequest):string{
  const base=name.replace(/\.(hwp|hwpx)$/i,'').replace(/[\u0000-\u001f\u007f/\\]/g,'').slice(0,140)||'document';
  return request.format==='txt'?base+'.txt':request.format==='markdown'?base+'_Markdown.zip':base+'_PNG_'+request.pages.join('-')+'.zip';
}
export function savedExports(exports:Record<string,ExportReceipt>|undefined):Record<string,ExportReceipt>|undefined{
  return exports?Object.fromEntries(Object.entries(exports).map(([key,receipt])=>[key,{request:normalizeExportRequest(receipt.request),fileId:receipt.fileId,url:receipt.url,attempt:receipt.attempt?savedAttempt(receipt.attempt):undefined}])):undefined;
}
