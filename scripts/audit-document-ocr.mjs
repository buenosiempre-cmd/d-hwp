// End-to-end local OCR audit. Explicit synthetic image, pinned local engine/models.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import init,{HwpDocument} from '@rhwp/core';
import {convertMarkdownPackage,closeConversionRuntime} from '../src/conversion/convert.mjs';
import {readArchive} from '../src/conversion/archive.mjs';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--module'||args[2]!=='--model-cache'||args[4]!=='--image'||args[6]!=='--output-dir')throw new Error('Use --module PATH --model-cache PATH --image SYNTHETIC_PNG --output-dir DIRECTORY.');
const image=await readFile(args[5]),imageHash=createHash('sha256').update(image).digest('hex');
assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
const width=image.readUInt32BE(16),height=image.readUInt32BE(20);
assert.ok(width>0&&height>0&&width*height<=16_000_000&&image.length<=5*1024*1024);
await init({module_or_path:await readFile('node_modules/@rhwp/core/rhwp_bg.wasm')});
const doc=HwpDocument.createEmpty(),checked=value=>{assert.notEqual(JSON.parse(value).ok,false);};
const output=resolve(args[7]);await mkdir(output,{recursive:true});const evidence={formats:{}};
try{
 checked(doc.createBlankDocument());checked(doc.insertText(0,0,0,'그림 속 글자 독립 검증'));
 checked(doc.insertParagraph(0,1));checked(doc.insertPicture(0,1,0,'[]',image,40000,Math.round(40000*height/width),width,height,'png','합성 한글 OCR 시험 그림'));
 for(const format of ['hwp','hwpx']){
  const original=Buffer.from(format==='hwp'?doc.exportHwp():doc.exportHwpx());
  const started=performance.now();
  const result=await convertMarkdownPackage(original,{timeoutMs:120_000,ocr:{modulePath:resolve(args[1]),modelCachePath:resolve(args[3])}});
  const entries=readArchive(result.zip),ocr=result.report.ocr;
  assert.equal(ocr.runtimeStatus,'complete');assert.ok(ocr.counts.recognized>0);
  assert.deepEqual(entries.get(`source/original.${format}`),original);
  assert.deepEqual(entries.get(`assets/${imageHash}.png`),image);
  assert.match(entries.get('README.md').toString(),/OCR 보충/);
  assert.match(result.markdown.toString(),/그림 OCR 보충 결과/);
  assert.equal(result.report.status,'needs_review');
  await writeFile(resolve(output,format+'-ocr.zip'),result.zip);
  await writeFile(resolve(output,format+'-ocr.md'),result.markdown);
  evidence.formats[format]={elapsedMs:Math.round(performance.now()-started),packageBytes:result.zip.length,imageSha256:imageHash,sourceSha256:result.report.source.sha256,ocr};
 }
 await writeFile(resolve(output,'audit.json'),JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({formats:Object.fromEntries(Object.entries(evidence.formats).map(([format,value])=>[format,{elapsedMs:value.elapsedMs,recognized:value.ocr.counts.recognized,originalAndImageVerified:true}]))}));
}finally{doc.free();await closeConversionRuntime();}
