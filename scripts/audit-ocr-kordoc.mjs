// Explicit local image audit. The OCR runtime is pinned and offline; no documents
// or images are sent to a network service. Keep outputs outside tracked sources.
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {enrichWithOcr} from '../src/conversion/ocr.mjs';
const args=process.argv.slice(2);
if(args.length!==8||args[0]!=='--module'||args[2]!=='--model-cache'||args[4]!=='--image'||args[6]!=='--output')throw new Error('Use --module PATH --model-cache PATH --image PATH --output JSON_PATH.');
const bytes=await readFile(resolve(args[5])),sha256=createHash('sha256').update(bytes).digest('hex');
const extension=bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'png':bytes[0]===0xff?'jpg':'webp';
const source={markdown:Buffer.from('# OCR 검증 문서\n'),assets:[{name:`assets/${sha256}.${extension}`,bytes}],report:{schemaVersion:1,status:'needs_review',coverage:{scope:'OCR-only image audit; no XML content was parsed.'},issues:[]}};
const started=performance.now();
const result=await enrichWithOcr(source,{modulePath:resolve(args[1]),modelCachePath:resolve(args[3])});
await writeFile(resolve(args[7]),JSON.stringify({report:result.report,markdown:result.markdown.toString()},null,2)+'\n');
console.log(JSON.stringify({elapsedMs:Math.round(performance.now()-started),ocr:result.report.ocr}));
if(result.report.ocr.counts.recognized===0)process.exitCode=1;
