import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {enrichWithOcr,applyOcrResults,planOcr,OCR_LIMITS,OCR_PROFILE} from '../../src/conversion/ocr.mjs';
import {MAX_MARKDOWN_BYTES,MAX_MARKDOWN_REPORT_BYTES} from '../../src/conversion/frames.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const png=index=>Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('synthetic-'+index)]);
const asset=(bytes=png(1),extension='png')=>({name:`assets/${sha(bytes)}.${extension}`,bytes,mime:'image/png'});
const extracted=(assets=[asset()])=>({markdown:Buffer.from('# 원문\n\n구조에서 추출한 본문\n'),assets,report:{schemaVersion:1,status:'needs_review',coverage:{xmlTextNodes:3,renderedTextNodes:3,unaccountedTextNodes:0},issues:[{code:'image_ocr_not_performed',sourcePath:'Contents/section0.xml/pic','message':'original issue'}]}});
const recognized=(input,text='동국대학교 2026-10-28 1,234,567원')=>planOcr(input.assets).map(record=>({...record,status:'recognized',text,warnings:[],width:100,height:30}));

test('OCR adds separate escaped evidence while preserving source, image bytes and XML coverage',()=>{
 const input=extracted(),before=JSON.stringify(input.report);
 const result=applyOcrResults(input,recognized(input,'한글 <script>alert(1)</script> ![외부](https://example.invalid) [링크](javascript:x)\n# 제목 & 원문'),{verified:true});
 assert.equal(result.assets,input.assets);assert.equal(result.assets[0].bytes,input.assets[0].bytes);
 assert.ok(result.markdown.subarray(0,input.markdown.length).equals(input.markdown));
 assert.deepEqual(result.report.coverage,input.report.coverage);assert.equal(JSON.stringify(input.report),before);
 assert.match(result.markdown.toString(),/그림 OCR 보충 결과/);
 assert.ok(result.markdown.toString().includes(`[원본 개체 확인](${input.assets[0].name})`));
 assert.doesNotMatch(result.markdown.toString(),/<script>|!\[외부\]|\]\(javascript:|https:\/\//);
 assert.match(result.markdown.toString(),/&lt;script&gt;/);
 assert.equal(result.report.ocr.runtimeVerified,true);assert.equal(result.report.ocr.version,OCR_PROFILE.version);
 assert.equal(result.report.ocr.counts.recognized,1);assert.equal(result.report.ocr.assets[0].sha256,sha(input.assets[0].bytes));
 assert.equal(result.report.status,'needs_review');assert.equal(result.report.ocr.status,'needs_review');
 assert.ok(result.report.issues.every(issue=>issue.code!=='image_ocr_not_performed'));
 assert.ok(result.report.issues.some(issue=>issue.code==='ocr_requires_review'));
 assert.equal(result.report.ocr.assets[0].text,undefined,'OCR text is in Markdown, while the report keeps its hash and counts');
});

test('OCR plans report unsupported, byte-limited and count-limited assets instead of silently dropping them',()=>{
 const inputs=Array.from({length:11},(_,i)=>asset(png(i)));
 const oversized=Buffer.alloc(OCR_LIMITS.imageBytes+1);Buffer.from('89504e470d0a1a0a','hex').copy(oversized);
 inputs.push(asset(oversized),asset(Buffer.from('unknown OLE object'),'bin'));
 const plan=planOcr(inputs);
 assert.equal(plan.filter(record=>record.status==='pending').length,10);
 assert.equal(plan[10].reason,'image_count_limit');assert.equal(plan[11].reason,'image_byte_limit');assert.equal(plan[12].reason,'unsupported_format');
 assert.equal(plan.length,inputs.length);
 const exact=Buffer.alloc(OCR_LIMITS.imageBytes);Buffer.from('89504e470d0a1a0a','hex').copy(exact);
 assert.equal(planOcr([asset(exact)])[0].status,'pending');
 for(const invalid of [[{...inputs[0],name:'assets/user.png'}],[{...inputs[0],bytes:png(99)}],[inputs[0],inputs[0]]])assert.throws(()=>planOcr(invalid),{reason:'markdown_structure'});
});

test('partial OCR, empty recognition and low-confidence warnings remain visible with original image issues',()=>{
 const input=extracted([asset(png(1)),asset(png(2)),asset(png(3))]),records=planOcr(input.assets);
 records[0]={...records[0],status:'recognized',text:'일부 본문',warnings:['OCR_LOW_CONF','PARTIAL_PARSE']};
 records[1]={...records[1],status:'no_text',reason:'no_text',warnings:['OCR_FAILED']};
 records[2]={...records[2],status:'failed',reason:'timed_out',warnings:[]};
 const result=applyOcrResults(input,records,{verified:true,runtimeStatus:'timed_out'});
 assert.deepEqual(result.report.ocr.counts,{assets:3,attempted:3,recognized:1,failed:2,skipped:0});
 assert.ok(result.report.issues.some(issue=>issue.code==='image_ocr_not_performed'));
 assert.ok(result.markdown.toString().includes('신뢰도가 낮아 일부 줄이 제외'));
 assert.ok(result.markdown.toString().includes('처리 시간 한도'));
 assert.deepEqual(result.report.ocr.assets[0].warnings,['OCR_LOW_CONF','PARTIAL_PARSE']);
 assert.equal(result.assets.length,3);
});

test('recognized raster and unsupported object retain a visible unresolved source warning',()=>{
 const input=extracted([asset(png(1)),asset(Buffer.from('GIF89a'),'gif')]),records=planOcr(input.assets);
 records[0]={...records[0],status:'recognized',text:'인식된 그림',warnings:[]};
 const result=applyOcrResults(input,records,{verified:true});
 assert.deepEqual(result.report.ocr.counts,{assets:2,attempted:1,recognized:1,failed:0,skipped:1});
 assert.ok(result.report.issues.some(issue=>issue.code==='image_ocr_not_performed'));
 assert.equal(result.report.ocr.assets[1].reason,'unsupported_format');
 assert.ok(result.markdown.toString().includes(`[원본 개체 확인](${input.assets[1].name})`));
 assert.equal(result.assets,input.assets);
});

test('absent OCR configuration is explicit and does not start an external engine',async()=>{
 for(const options of [{},{modulePath:'relative',modelCachePath:'/tmp'},{modulePath:'/tmp/bad\0path',modelCachePath:'/tmp'}]){
  const result=await enrichWithOcr(extracted(),options);
  assert.equal(result.report.ocr.runtimeVerified,false);assert.equal(result.report.ocr.runtimeStatus,'not_configured');
  assert.equal(result.report.ocr.assets[0].status,'not_configured');assert.equal(result.report.ocr.assets[0].reason,'not_configured');
 }
 const noAssets=extracted([]),result=await enrichWithOcr(noAssets,{modulePath:'/not/used',modelCachePath:'/not/used'});
 assert.equal(result.report.ocr.status,'no_assets');assert.deepEqual(result.markdown,noAssets.markdown);
 for(const timeoutMs of [0,-1,60001,NaN,Infinity])await assert.rejects(enrichWithOcr(extracted(),{timeoutMs}),{reason:'markdown_structure'});
});

test('bad result identity, states, warnings, pixels and aggregate text fail before publication',()=>{
 const input=extracted(),good=recognized(input);
 for(const patch of [{name:'assets/other.png'},{sha256:'0'.repeat(64)},{bytes:123},{status:'pending'},{warnings:['DOCUMENT_PRIVATE_TEXT']},{width:100000,height:100000},{text:''}]){
  assert.throws(()=>applyOcrResults(input,[{...good[0],...patch}]),{reason:'markdown_structure'});
 }
 assert.throws(()=>applyOcrResults(input,[]),{reason:'markdown_structure'});
 assert.throws(()=>applyOcrResults(input,[{...good[0],text:'가'.repeat(MAX_MARKDOWN_BYTES)}]),{reason:'markdown_size'});
 assert.throws(()=>applyOcrResults(input,[{...good[0],text:'*'.repeat(MAX_MARKDOWN_BYTES/2)}]),{reason:'markdown_size'},'escaping may exceed the limit; never truncate');
 const hugeReport=extracted();hugeReport.report.extra='x'.repeat(MAX_MARKDOWN_REPORT_BYTES);
 assert.throws(()=>applyOcrResults(hugeReport,recognized(hugeReport)),{reason:'markdown_package_size'});
});

test('operator module version alone cannot bypass pinned integrity or execute replacement code',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dhwp-ocr-untrusted-'));
 try{
  const dist=join(directory,'dist'),models=join(directory,'models'),marker=join(directory,'should-not-execute');
  await mkdir(dist);await mkdir(models);
  await writeFile(join(directory,'package.json'),JSON.stringify({name:'kordoc',version:'4.19.1',type:'module'}));
  await writeFile(join(dist,'index.js'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export const VERSION='4.19.1';`);
  const input=extracted(),result=await enrichWithOcr(input,{modulePath:join(dist,'index.js'),modelCachePath:models,timeoutMs:10_000});
  assert.equal(result.report.ocr.runtimeVerified,false);assert.equal(result.report.ocr.runtimeStatus,'runtime_unavailable');
  assert.equal(result.report.ocr.assets[0].reason,'runtime_unavailable');
  await assert.rejects(access(marker));assert.equal(result.assets,input.assets);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('OCR deadline kills the disposable process and reports unfinished assets',async()=>{
 const result=await enrichWithOcr(extracted(),{modulePath:'/synthetic/missing/dist/index.js',modelCachePath:'/synthetic/missing/models',timeoutMs:1});
 assert.equal(result.report.ocr.runtimeStatus,'timed_out');assert.equal(result.report.ocr.assets[0].reason,'timed_out');
 assert.equal(result.report.status,'needs_review');
});
