// Optional, local-only OCR. A disposable process owns native image/ONNX work.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {dirname,basename,isAbsolute,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ConversionFailure} from './failures.mjs';
import {MAX_MARKDOWN_BYTES,MAX_MARKDOWN_REPORT_BYTES} from './frames.mjs';
import {workerEnvironment} from './worker-env.mjs';

export const OCR_LIMITS=Object.freeze({images:10,imageBytes:5*1024*1024,pixels:16_000_000,timeoutMs:60_000});
export const OCR_PROFILE=Object.freeze({
  engine:'kordoc',version:'4.19.1',
  entrySha256:'890da00e6f0d626c9fa6c0e272cfc8334598e347fe34fe6730970e5329bc010b',
  distSha256:'69793d0bd84a5fbbbfc27d7774664c61f38a6219d6fc86088c92db1a8a2f7d3d',
  files:70,
  models:Object.freeze([
    {file:'det.onnx',sha256:'a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d',bytes:4826518},
    {file:'rec_korean.onnx',sha256:'92f0b7785e64fc9090106a241cf4c1eb97472824558272751b88a2a4476d3a08',bytes:13418787},
    {file:'rec_korean.yml',sha256:'f757fa1c40e99edcf27e9cce879b93eb2a51fa46f5ef39095689b8c37dd75998',bytes:96039},
  ]),
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const validPath=value=>typeof value==='string'&&value.length<4096&&isAbsolute(value)&&!/[\u0000-\u001f]/.test(value);
const namePattern=/^assets\/[a-f0-9]{64}\.(?:png|jpg|gif|webp|bin)$/;
const punctuation=/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g;
const escapeText=value=>value.replace(punctuation,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]??'\\'+c))
  .replace(/(^|\n)([ \t]+)/g,(_m,start,spaces)=>start+[...spaces].map(c=>c==='\t'?'&#9;':'&#32;').join(''))
  .replace(/\r\n|\r|\n/g,'  \n');
const warnings=new Set(['OCR_LOW_CONF','PARTIAL_PARSE','OCR_FAILED','OTHER_WARNING']);
const reasons=new Set(['unsupported_format','image_byte_limit','image_count_limit','pixel_limit','animated_image','invalid_image','parse_failed','no_text','not_configured','runtime_unavailable','runtime_failed','timed_out']);
const reasonText={unsupported_format:'이 형식의 개체는 그림 OCR 대상이 아닙니다.',image_byte_limit:'그림이 OCR 크기 한도 5 MiB를 넘습니다.',image_count_limit:'한 문서에서 OCR할 수 있는 그림 10개를 넘습니다.',pixel_limit:'그림이 OCR 해상도 한도 1,600만 픽셀을 넘습니다.',animated_image:'여러 프레임이 있는 그림은 자동 인식하지 않았습니다.',invalid_image:'그림을 안전하게 읽을 수 없습니다.',parse_failed:'그림의 글자 인식에 실패했습니다.',no_text:'그림에서 글자를 인식하지 못했습니다.',not_configured:'이 서버에 로컬 OCR이 설정되지 않았습니다.',runtime_unavailable:'검증된 로컬 OCR 프로그램과 모델을 사용할 수 없습니다.',runtime_failed:'로컬 OCR 처리가 완료되지 않았습니다.',timed_out:'OCR 처리 시간 한도를 넘었습니다.'};
const warningText={OCR_LOW_CONF:'인식 신뢰도가 낮아 일부 줄이 제외됐을 수 있습니다.',PARTIAL_PARSE:'그림이나 인식 결과의 일부만 처리됐을 수 있습니다.',OCR_FAILED:'글자 인식 실패 신호가 있습니다.',OTHER_WARNING:'인식 엔진의 추가 검토 신호가 있습니다.'};
const sniff=bytes=>bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'png':bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'jpeg':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':undefined;
const jsonBytes=value=>Buffer.byteLength(JSON.stringify(value));
const checkSize=(markdown,report)=>{
  if(markdown.length>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');
  if(jsonBytes(report)>MAX_MARKDOWN_REPORT_BYTES)throw new ConversionFailure('markdown_package_size');
};
const fixedRecord=(asset,status,reason)=>({name:asset.name,sha256:hash(asset.bytes),bytes:asset.bytes.length,status,...(reason?{reason}:{}),warnings:[]});

/** Pure plan: every embedded asset is accounted for; only bounded raster inputs run. */
export function planOcr(assets){
  if(!Array.isArray(assets)||assets.length>4096)throw new ConversionFailure('markdown_package_size');
  let accepted=0;const names=new Set();
  return assets.map(asset=>{
    if(!asset||!namePattern.test(asset.name)||names.has(asset.name)||!(asset.bytes instanceof Uint8Array))throw new ConversionFailure('markdown_structure');
    names.add(asset.name);const bytes=Buffer.from(asset.bytes),digest=hash(bytes);
    if(!asset.name.includes(digest))throw new ConversionFailure('markdown_structure');
    if(!sniff(bytes))return fixedRecord({...asset,bytes},'skipped','unsupported_format');
    if(bytes.length>OCR_LIMITS.imageBytes)return fixedRecord({...asset,bytes},'skipped','image_byte_limit');
    if(accepted>=OCR_LIMITS.images)return fixedRecord({...asset,bytes},'skipped','image_count_limit');
    accepted++;return fixedRecord({...asset,bytes},'pending');
  });
}

/** Assemble only escaped OCR evidence; XML coverage and all original assets stay intact. */
export function applyOcrResults(extracted,records,{verified=false,runtimeStatus='complete'}={}){
  if(!Buffer.isBuffer(extracted?.markdown)||!extracted.report||extracted.report.schemaVersion!==1)throw new ConversionFailure('markdown_structure');
  if(typeof verified!=='boolean'||!['complete','not_needed','not_configured','runtime_unavailable','runtime_failed','timed_out'].includes(runtimeStatus))throw new ConversionFailure('markdown_structure');
  checkSize(extracted.markdown,extracted.report);
  const planned=planOcr(extracted.assets);
  if(!Array.isArray(records)||records.length!==planned.length)throw new ConversionFailure('markdown_structure');
  const allowedStatus=new Set(['recognized','no_text','failed','skipped','not_configured']);
  let textBytes=0;
  for(let index=0;index<records.length;index++){
    const record=records[index],expected=planned[index];
    if(!record||record.name!==expected.name||record.sha256!==expected.sha256||record.bytes!==expected.bytes||!allowedStatus.has(record.status)
      ||(record.reason!==undefined&&!reasons.has(record.reason))||!Array.isArray(record.warnings)||record.warnings.length>32||record.warnings.some(code=>!warnings.has(code)))throw new ConversionFailure('markdown_structure');
    if(expected.status==='skipped'&&(record.status!==expected.status||record.reason!==expected.reason))throw new ConversionFailure('markdown_structure');
    if(record.status==='recognized'){
      if(typeof record.text!=='string'||!record.text.trim())throw new ConversionFailure('markdown_structure');
      textBytes+=Buffer.byteLength(record.text);if(textBytes>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');
    }else if(record.text!==undefined)throw new ConversionFailure('markdown_structure');
    if((record.width!==undefined||record.height!==undefined)&&(!Number.isSafeInteger(record.width)||record.width<1||!Number.isSafeInteger(record.height)||record.height<1||record.width*record.height>OCR_LIMITS.pixels))throw new ConversionFailure('markdown_structure');
  }
  const report=JSON.parse(JSON.stringify(extracted.report));
  const recognized=records.filter(record=>record.status==='recognized');
  const counts={assets:records.length,attempted:records.filter(record=>['recognized','no_text','failed'].includes(record.status)).length,recognized:recognized.length,failed:records.filter(record=>record.status==='failed'||record.status==='no_text').length,skipped:records.filter(record=>record.status==='skipped'||record.status==='not_configured').length};
  const publicRecords=records.map(record=>({name:record.name,sha256:record.sha256,bytes:record.bytes,status:record.status,...(record.reason?{reason:record.reason}:{}),warnings:record.warnings,
    ...(record.width!==undefined?{width:record.width,height:record.height}:{}),...(record.text!==undefined?{characters:[...record.text].length,textSha256:hash(Buffer.from(record.text))}:{})}));
  report.ocr={engine:OCR_PROFILE.engine,version:OCR_PROFILE.version,offline:true,runtimeVerified:verified,runtimeStatus,
    scope:'Embedded asset bytes, not the document page: cropping, rotation, layering and visual placement are not reconstructed. OCR remains unverified supplementary text.',
    ...(verified?{entrySha256:OCR_PROFILE.entrySha256,distSha256:OCR_PROFILE.distSha256}:{}),
    models:OCR_PROFILE.models.map(model=>({...model,verified})),limits:OCR_LIMITS,counts,status:records.length?'needs_review':'no_assets',assets:publicRecords};
  report.issues??=[];
  if(records.length){
    report.status='needs_review';
    // Picture issues do not carry an asset id. Replace only when every asset
    // succeeded, so a mixed result never clears another picture's warning.
    if(records.every(record=>record.status==='recognized')){
      report.issues=report.issues.map(issue=>issue.code==='image_ocr_not_performed'?{...issue,code:'ocr_requires_review',message:'OCR text is supplementary and may omit or misread content, including numbers and spacing. Compare with the preserved image.'}:issue);
    }
    for(const record of records){
      report.issues.push({code:record.status==='recognized'?'ocr_requires_review':record.status==='not_configured'?'ocr_not_configured':'ocr_'+(record.reason??record.status),sourcePath:record.name,message:record.status==='recognized'?'OCR is an unverified interpretation of the preserved image. Check names, numbers, dates and layout against the source.':'This object was not fully interpreted by OCR. The original bytes remain in the package.'});
    }
  }
  const sections=records.length?['\n\n## 그림 OCR 보충 결과\n\n> 아래 내용은 포함된 원본 그림 전체를 자동 인식한 참고 텍스트입니다. 문서에서 그림을 잘라 보이거나 배치한 모양과 다를 수 있으며, 오독·누락·공백 변경이 있을 수 있습니다. 금액·날짜·이름과 표는 원본 그림을 함께 확인하세요.\n']:[];
  for(const [position,record]of records.entries()){
    const index=position+1;
    sections.push(`\n\n### 포함 개체 ${index}\n\n[원본 개체 확인](${record.name})\n\n`);
    if(record.status==='recognized')sections.push(escapeText(record.text)+'\n');
    else sections.push(`OCR 미완료: ${reasonText[record.reason]??'인식 결과를 확인할 수 없습니다.'} 원본 개체를 확인하세요.\n`);
    if(record.warnings.length)sections.push('\n검토 신호: '+record.warnings.map(code=>warningText[code]).join(' ')+'\n');
  }
  const markdown=Buffer.concat([extracted.markdown,Buffer.from(sections.join(''))]);checkSize(markdown,report);
  return {markdown,assets:extracted.assets,report};
}

/** Import checks are performed before loading any operator-configured JavaScript. */
async function verifyRuntime(modulePath,modelCachePath){
  if(!validPath(modulePath)||!validPath(modelCachePath))throw new Error('runtime');
  const entry=await realpath(modulePath),cache=await realpath(modelCachePath);
  if(basename(entry)!=='index.js'||basename(dirname(entry))!=='dist'||!(await lstat(cache)).isDirectory())throw new Error('runtime');
  const dist=dirname(entry),root=dirname(dist),pkgBytes=await readFile(join(root,'package.json'));
  if(pkgBytes.length>64*1024)throw new Error('runtime');
  const pkg=JSON.parse(pkgBytes);if(pkg.name!=='kordoc'||pkg.version!==OCR_PROFILE.version||pkg.type!=='module')throw new Error('runtime');
  const files=[];let totalBytes=0;
  const walk=async(path,prefix='')=>{
    for(const item of await readdir(path,{withFileTypes:true})){
      const relative=prefix+item.name,full=join(path,item.name);
      if(item.isSymbolicLink())throw new Error('runtime');
      if(item.isDirectory()){if(prefix.split('/').length>4)throw new Error('runtime');await walk(full,relative+'/');}
      else if(/\.(js|cjs|json)$/.test(item.name)){
        const stat=await lstat(full);if(!stat.isFile()||stat.size>4*1024*1024||files.length>=256||(totalBytes+=stat.size)>16*1024*1024)throw new Error('runtime');
        files.push([relative,hash(await readFile(full))]);
      }
    }
  };
  await walk(dist);files.sort(([a],[b])=>a<b?-1:a>b?1:0);
  const digest=hash(Buffer.from(files.map(([name,sha256])=>name+'\0'+sha256+'\n').join('')));
  if(files.length!==OCR_PROFILE.files||digest!==OCR_PROFILE.distSha256||hash(await readFile(entry))!==OCR_PROFILE.entrySha256)throw new Error('runtime');
  for(const model of OCR_PROFILE.models){const path=join(cache,'ppocr',model.file),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==model.bytes||hash(await readFile(path))!==model.sha256)throw new Error('runtime');}
  return {entry,cache};
}

export async function verifyOcrRuntime({modulePath,modelCachePath}={}){
  await verifyRuntime(modulePath,modelCachePath);
  return {engine:OCR_PROFILE.engine,version:OCR_PROFILE.version,entrySha256:OCR_PROFILE.entrySha256,distSha256:OCR_PROFILE.distSha256,modelsVerified:OCR_PROFILE.models.length,offline:true};
}

async function runBatch(items,{modulePath,modelCachePath,timeoutMs}){
  return new Promise(resolveResult=>{
    const results=new Map();let verified=false,settled=false,done=false,totalText=0,status='runtime_unavailable',failure;
    // Inherit the outer runtime's process group: its cancellation kills this
    // native child too. OCR's own deadline kills this direct process only.
    const child=spawn(process.execPath,['--max-old-space-size=256',resolve('src/conversion/ocr.mjs'),'--dhwp-ocr-child'],{
      detached:false,stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',env:{...workerEnvironment(),KORDOC_OFFLINE:'1',KORDOC_MODEL_CACHE:modelCachePath},
    });
    const kill=()=>{try{child.kill('SIGKILL');}catch{}};
    const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);if(child.connected)child.disconnect();resolveResult({results,verified,status,failure});};
    const timer=setTimeout(()=>{status='timed_out';kill();finish();},timeoutMs);
    child.on('message',message=>{
      if(settled)return;
      if(message?.type==='verified'&&message.entrySha256===OCR_PROFILE.entrySha256&&message.distSha256===OCR_PROFILE.distSha256){verified=true;status='runtime_failed';return;}
      if(message?.type==='failure'&&['markdown_size','markdown_package_size'].includes(message.reason)){failure=message.reason;kill();return;}
      if(message?.type==='asset'&&verified&&Number.isInteger(message.index)&&message.index>=0&&message.index<items.length&&!results.has(message.index)){
        const record=message.record;
        if(!record||!['recognized','no_text','failed','skipped'].includes(record.status)||!Array.isArray(record.warnings)||record.warnings.length>32||record.warnings.some(code=>!warnings.has(code))||(record.reason!==undefined&&!reasons.has(record.reason))){kill();return;}
        if(record.status==='recognized'){
          if(typeof record.text!=='string'||!record.text.trim()){kill();return;}
          totalText+=Buffer.byteLength(record.text);if(totalText>MAX_MARKDOWN_BYTES){failure='markdown_size';kill();return;}
        }else if(record.text!==undefined){kill();return;}
        results.set(message.index,record);return;
      }
      if(message?.type==='done'&&verified&&results.size===items.length){done=true;status='complete';return;}
      kill();
    });
    child.once('error',()=>{kill();finish();});
    child.once('exit',code=>{if(code!==0||!done){if(status!=='timed_out')status=verified?'runtime_failed':'runtime_unavailable';}finish();});
    child.send({type:'ocr',modulePath,modelCachePath,items},error=>{if(error){kill();finish();}});
  });
}

export async function enrichWithOcr(extracted,{modulePath,modelCachePath,timeoutMs=OCR_LIMITS.timeoutMs}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>OCR_LIMITS.timeoutMs)throw new ConversionFailure('markdown_structure');
  if(!Buffer.isBuffer(extracted?.markdown)||!extracted.report||extracted.report.schemaVersion!==1)throw new ConversionFailure('markdown_structure');
  checkSize(extracted.markdown,extracted.report);
  const records=planOcr(extracted.assets),pending=records.map((record,index)=>({record,index})).filter(({record})=>record.status==='pending');
  if(!pending.length)return applyOcrResults(extracted,records,{runtimeStatus:'not_needed'});
  if(!validPath(modulePath)||!validPath(modelCachePath)){
    return applyOcrResults(extracted,records.map(record=>record.status==='pending'?{...record,status:'not_configured',reason:'not_configured'}:record),{runtimeStatus:'not_configured'});
  }
  const batch=await runBatch(pending.map(({index})=>({bytes:Buffer.from(extracted.assets[index].bytes)})),{modulePath,modelCachePath,timeoutMs});
  if(batch.failure)throw new ConversionFailure(batch.failure);
  for(const [position,{index}]of pending.entries()){
    const result=batch.results.get(position);
    records[index]={...records[index],...(result??{status:'failed',reason:batch.status==='timed_out'?'timed_out':batch.verified?'runtime_failed':'runtime_unavailable',warnings:[]})};
  }
  return applyOcrResults(extracted,records,{verified:batch.verified,runtimeStatus:batch.status});
}

async function childMain(){
  let used=false;
  const send=value=>new Promise((resolveSend,reject)=>{if(!process.connected){reject(new Error('channel'));return;}process.send(value,error=>error?reject(error):resolveSend());});
  process.once('disconnect',()=>process.exit(1));
  process.on('message',async request=>{
    if(used){process.exit(1);return;}used=true;
    try{
      if(process.env.KORDOC_OFFLINE!=='1'||request?.type!=='ocr'||!Array.isArray(request.items)||!request.items.length||request.items.length>OCR_LIMITS.images)throw new Error('request');
      const profile=await verifyRuntime(request.modulePath,request.modelCachePath);
      if(process.env.KORDOC_MODEL_CACHE!==request.modelCachePath)throw new Error('cache');
      // Pinned Kordoc uses fetch for model retrieval; deny it as well as its own
      // offline guard. Documents are supplied as bytes, never external URLs.
      globalThis.fetch=async()=>{throw new Error('offline');};
      const require=createRequire(profile.entry),sharp=require('sharp');
      const kordoc=await import(pathToFileURL(profile.entry).href);
      if(kordoc.VERSION!==OCR_PROFILE.version||typeof kordoc.parse!=='function')throw new Error('runtime');
      await send({type:'verified',entrySha256:OCR_PROFILE.entrySha256,distSha256:OCR_PROFILE.distSha256});
      let totalText=0;
      for(let index=0;index<request.items.length;index++){
        const bytes=request.items[index]?.bytes;
        if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>OCR_LIMITS.imageBytes||!sniff(bytes))throw new Error('request');
        let record;
        try{
          const metadata=await sharp(bytes,{limitInputPixels:OCR_LIMITS.pixels,failOn:'error',sequentialRead:true}).metadata();
          if(!Number.isSafeInteger(metadata.width)||!Number.isSafeInteger(metadata.height)||metadata.width<1||metadata.height<1||metadata.width*metadata.height>OCR_LIMITS.pixels)record={status:'skipped',reason:'pixel_limit',warnings:[]};
          else if((metadata.pages??1)!==1)record={status:'skipped',reason:'animated_image',warnings:[]};
          else if(!['png','jpeg','webp'].includes(metadata.format))record={status:'skipped',reason:'unsupported_format',warnings:[]};
          else{
            const result=await kordoc.parse(bytes,{ocr:true,formulaOcr:false,plain:true,tableFormat:'gfm'});
            const codes=Array.isArray(result.warnings)?result.warnings.map(warning=>warnings.has(warning?.code)?warning.code:'OTHER_WARNING'):[];
            if(codes.length>32)throw new ConversionFailure('markdown_package_size');
            if(!result.success||typeof result.markdown!=='string')record={status:'failed',reason:'parse_failed',warnings:codes};
            else if(!result.markdown.trim())record={status:'no_text',reason:'no_text',warnings:codes};
            else{totalText+=Buffer.byteLength(result.markdown);if(totalText>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');record={status:'recognized',text:result.markdown,warnings:codes,width:metadata.width,height:metadata.height};}
          }
        }catch(error){if(error instanceof ConversionFailure)throw error;record={status:'failed',reason:typeof error?.message==='string'&&/pixel limit/i.test(error.message)?'pixel_limit':'invalid_image',warnings:[]};}
        await send({type:'asset',index,record});
      }
      await send({type:'done'});process.exit(0);
    }catch(error){if(error instanceof ConversionFailure)await send({type:'failure',reason:error.reason}).catch(()=>{});process.exit(1);}
  });
}
if(process.argv[2]==='--dhwp-ocr-child'&&process.argv[1]===fileURLToPath(import.meta.url))await childMain();
