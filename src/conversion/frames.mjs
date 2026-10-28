import {normalizeSelectedPages} from './selection.mjs';
export const MAX_PDF_BYTES=50*1024*1024;
export const MAX_PNG_BYTES=5*1024*1024;
export const MAX_PNG_TOTAL_BYTES=25*1024*1024;
export const MAX_PREVIEW_PAGES=10;
export const MAX_MARKDOWN_BYTES=2*1024*1024;
export const MAX_TEXT_BYTES=2*1024*1024;
export const MAX_ZIP_BYTES=26*1024*1024;
export const MAX_MARKDOWN_PACKAGE_BYTES=50*1024*1024;
export const MAX_MARKDOWN_REPORT_BYTES=2*1024*1024;
export class OutputError extends Error {}
const invalid=()=>{throw new OutputError('Invalid conversion output');};
export async function readFrames(stream,mode,start,end,{onPdf,onPage,eof=true,selectedPages}={}){
  let selection;
  if(mode==='selected')try{selection=normalizeSelectedPages(selectedPages);}catch{invalid();}
  const iterator=stream[Symbol.asyncIterator]();let pending=Buffer.alloc(0),total=0;
  async function next(){
    const r=await iterator.next();if(r.done)return false;
    pending=Buffer.from(r.value);total+=pending.length;
    const cap=mode==='markdown-package'?MAX_MARKDOWN_PACKAGE_BYTES+MAX_MARKDOWN_BYTES+MAX_MARKDOWN_REPORT_BYTES:mode==='markdown'?MAX_MARKDOWN_BYTES:mode==='text'?MAX_TEXT_BYTES:mode==='selected'?MAX_PNG_TOTAL_BYTES:MAX_PDF_BYTES+MAX_PNG_TOTAL_BYTES;
    if(total>cap+64*1024)invalid();return true;
  }
  async function read(size){
    const chunks=[];let received=0;
    while(received<size){
      if(!pending.length&&!await next())invalid();
      const count=Math.min(size-received,pending.length);chunks.push(pending.subarray(0,count));pending=pending.subarray(count);received+=count;
    }
    return Buffer.concat(chunks,size);
  }
  async function header(){
    const length=(await read(4)).readUInt32BE();if(length<2||length>4096)invalid();
    try{return JSON.parse((await read(length)).toString('utf8'));}catch{invalid();}
  }
  const info=await header();
  if(info?.type!=='document'||!Number.isSafeInteger(info.pageCount)||info.pageCount<1||info.pageCount>200)invalid();
  const pageCount=info.pageCount,pages=[];let pdf,text,markdownPackage;
  if(selection?.some(page=>page>pageCount))invalid();
  if(mode==='preview'||mode==='pdf'){
    const frame=await header();if(frame?.type!=='pdf'||!Number.isSafeInteger(frame.bytes)||frame.bytes<5||frame.bytes>MAX_PDF_BYTES)invalid();
    pdf=await read(frame.bytes);if(pdf.subarray(0,5).toString()!=='%PDF-')invalid();
    await onPdf?.(pdf,pageCount);
  }else if(mode==='markdown-package'){
    const part=async(type,limit,min=1)=>{const frame=await header();if(frame?.type!==type||!Number.isSafeInteger(frame.bytes)||frame.bytes<min||frame.bytes>limit)invalid();return read(frame.bytes);};
    const markdown=await part('markdown',MAX_MARKDOWN_BYTES),reportBytes=await part('report',MAX_MARKDOWN_REPORT_BYTES),zip=await part('archive',MAX_MARKDOWN_PACKAGE_BYTES,22);
    let report;
    try{const decoder=new TextDecoder('utf-8',{fatal:true});decoder.decode(markdown);report=JSON.parse(decoder.decode(reportBytes));}catch{invalid();}
    if(!report||typeof report!=='object'||Array.isArray(report)||report.schemaVersion!==1||zip.readUInt32LE(0)!==0x04034b50)invalid();
    markdownPackage={markdown,report,zip};
  }else if(mode==='markdown'||mode==='text'){
    const frame=await header();if(frame?.type!==mode||!Number.isSafeInteger(frame.bytes)||frame.bytes<1||frame.bytes>(mode==='text'?MAX_TEXT_BYTES:MAX_MARKDOWN_BYTES))invalid();
    text=await read(frame.bytes);
    try{new TextDecoder('utf-8',{fatal:true}).decode(text);}catch{invalid();}
  }else if(mode!=='images'&&mode!=='selected')invalid();
  let pngBytes=0;
  const expected=selection??((mode==='images'||mode==='preview')?Array.from({length:Math.max(0,Math.min(end,pageCount)-start+1)},(_,i)=>start+i):[]);
  for(const page of expected){
    const frame=await header();
    if(frame?.type!=='png'||frame.page!==page||!Number.isSafeInteger(frame.bytes)||frame.bytes<8||frame.bytes>MAX_PNG_BYTES)invalid();
    pngBytes+=frame.bytes;if(pngBytes>MAX_PNG_TOTAL_BYTES)invalid();
    const png=await read(frame.bytes);if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')invalid();
    const image={page,png};pages.push(image);await onPage?.(image,pageCount);
  }
  if((await header())?.type!=='end'||pending.length)invalid();
  if(eof)while(await next())if(pending.length)invalid();
  return mode==='markdown-package'?markdownPackage:mode==='pdf'?pdf:(mode==='markdown'||mode==='text')?text:mode==='preview'?{pdf,pageCount,pages}:{pageCount,pages};
}
