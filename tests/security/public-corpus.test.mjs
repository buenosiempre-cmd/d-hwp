import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validateRegistry,obtainFixture,verifyPackage} from '../../scripts/verify-public-documents.mjs';
import {writeArchive} from '../../src/conversion/archive.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const source=Buffer.from('synthetic-public-source');
const fixture=()=>({id:'fixture',format:'hwpx',repository:'edwardkim/rhwp',commit:'a'.repeat(40),path:'tests/fixture.hwpx',url:'https://raw.githubusercontent.com/edwardkim/rhwp/'+ 'a'.repeat(40)+'/tests/fixture.hwpx',bytes:source.length,sha256:sha(source),license:{spdx:'MIT',url:'https://github.com/edwardkim/rhwp/blob/'+'a'.repeat(40)+'/LICENSE'},expected:{text:['확인 본문'],counts:{paragraphs:1}}});
const temporary=async run=>{const folder=await mkdtemp(join(tmpdir(),'dhwp-public-corpus-'));try{await run(folder);}finally{await rm(folder,{recursive:true,force:true});}};

test('public corpus registry pins immutable sources, bounded sizes, licenses and independent expectations',async()=>{
 const registry=JSON.parse(await readFile('tests/corpus/public-documents.json','utf8'));
 assert.equal(validateRegistry(registry).length,8);
 const base=fixture();assert.equal(validateRegistry({schemaVersion:1,documents:[base]}).length,1);
 for(const change of [{id:'../escape'},{commit:'main'},{sha256:'bad'},{repository:'untrusted/repo'},{path:'../fixture.hwpx'},{url:'https://example.invalid/fixture.hwpx'},{url:base.url+'?redirect=elsewhere'},{bytes:1024*1024+1},{license:{spdx:'unknown',url:base.license.url}},{expected:{text:[],counts:{paragraphs:1}}},{expected:{text:['x'],counts:{privateField:1}}}])assert.throws(()=>validateRegistry({schemaVersion:1,documents:[{...base,...change}]}),{code:'registry_invalid'});
 assert.throws(()=>validateRegistry({schemaVersion:1,documents:[base,base]}),{code:'registry_invalid'});
});

test('offline corpus is a gate: missing, changed or oversized cache files fail without fetching',()=>temporary(async cacheDir=>{
 const item=fixture(),fetcher=()=>assert.fail('offline mode must not fetch');
 await assert.rejects(obtainFixture(item,{cacheDir,offline:true,fetcher}),{code:'offline_fixture_missing'});
 const directory=join(cacheDir,item.id);await mkdir(directory);const path=join(directory,'source.hwpx');
 await writeFile(path,Buffer.alloc(item.bytes,1));await assert.rejects(obtainFixture(item,{cacheDir,offline:true,fetcher}),{code:'source_hash_mismatch'});
 await writeFile(path,Buffer.alloc(item.bytes+1));await assert.rejects(obtainFixture(item,{cacheDir,offline:true,fetcher}),{code:'source_size_mismatch'});
 await writeFile(path,source);assert.deepEqual(await obtainFixture(item,{cacheDir,offline:true,fetcher}),source);
}));

test('online corpus bounds streaming bytes, rejects wrong content and caches only verified source',()=>temporary(async cacheDir=>{
 const item=fixture();let cancelled=false;
 const oversized=new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.alloc(item.bytes+1));},cancel(){cancelled=true;}}));
 await assert.rejects(obtainFixture(item,{cacheDir,fetcher:async()=>oversized}),{code:'source_size_mismatch'});assert.equal(cancelled,true);
 await assert.rejects(obtainFixture(item,{cacheDir,fetcher:async()=>new Response(Buffer.alloc(item.bytes,1))}),{code:'source_hash_mismatch'});
 await assert.rejects(stat(join(cacheDir,item.id,'source.hwpx')),{code:'ENOENT'});
 let requests=0;const actual=await obtainFixture(item,{cacheDir,fetcher:async(url,options)=>{requests++;assert.equal(url,item.url);assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);return new Response(source);}});
 assert.deepEqual(actual,source);assert.equal(requests,1);
 assert.deepEqual(await obtainFixture(item,{cacheDir,offline:true,fetcher:()=>assert.fail('cache must be reused')}),source);
}));

test('online corpus rejects a response whose final URL differs from the pinned URL',()=>temporary(async cacheDir=>{
 const response=new Response(source);Object.defineProperty(response,'url',{value:'https://example.invalid/redirect'});
 await assert.rejects(obtainFixture(fixture(),{cacheDir,fetcher:async()=>response}),{code:'source_redirect_rejected'});
}));

test('corpus output gate detects missing content, structure, source, assets and false coverage',()=>{
 const item=fixture(),asset=Buffer.from('synthetic-picture'),name='assets/'+sha(asset)+'.png';
 const report={schemaVersion:1,source:{format:'hwpx',bytes:source.length,sha256:sha(source)},counts:{paragraphs:1},pageCount:1,assets:[{name,bytes:asset.length,sha256:sha(asset),mime:'image/png'}],coverage:{xmlTextNodes:1,renderedTextNodes:1,unaccountedTextNodes:0,xmlTextCharacters:5,renderedTextCharacters:5},status:'needs_review',issues:[{code:'image_ocr_not_performed'}]};
 const make=(overrides={})=>{const md=overrides.markdown??Buffer.from('# 문서\n\n## 구역 1\n\n확인 본문'),audit=overrides.report??report;return {markdown:md,report:audit,zip:writeArchive([{name:'document.md',bytes:md},{name:'report.json',bytes:Buffer.from(JSON.stringify(audit))},{name:'source/original.hwpx',bytes:overrides.source??source},{name,bytes:overrides.asset??asset}])};};
 assert.equal(verifyPackage(item,source,make()).passed,true);
 assert.throws(()=>verifyPackage(item,source,make({markdown:Buffer.from('## 제목\n\n## 구역 1\n다른 내용')})),{code:'expected_text_missing'});
 assert.throws(()=>verifyPackage(item,source,make({markdown:Buffer.from('## 제목\n\n## 구역 1\n다른 내용\n## 이름·설명·링크 등 부가 속성\n확인 본문')})),{code:'expected_text_missing'});
 assert.throws(()=>verifyPackage(item,source,make({report:{...report,counts:{paragraphs:2}}})),{code:'expected_structure_mismatch'});
 assert.throws(()=>verifyPackage(item,source,make({source:Buffer.from('not original')})),{code:'package_source_mismatch'});
 assert.throws(()=>verifyPackage(item,source,make({asset:Buffer.from('not image')})),{code:'package_asset_mismatch'});
 assert.throws(()=>verifyPackage(item,source,make({report:{...report,coverage:{...report.coverage,unaccountedTextNodes:1}}})),{code:'xml_coverage_mismatch'});
 assert.throws(()=>verifyPackage({...item,expected:{...item.expected,minimumRasterAssets:2}},source,make()),{code:'expected_images_missing'});
 assert.throws(()=>verifyPackage({...item,expected:{...item.expected,requiredIssueCodes:['dynamic_page_number_requires_review']}},source,make()),{code:'expected_review_warning_missing'});
 const cellItem={...item,expected:{...item.expected,cellText:[{table:2,row:1,column:1,text:'1'}]}};
 const md=Buffer.from('# 문서\n\n## 구역 1\n확인 본문\n\n**table-2-r1c1 · 행 1, 열 1 · rowSpan=1, colSpan=1**\n\n1\n');
 assert.equal(verifyPackage(cellItem,source,make({markdown:md})).passed,true);
 assert.throws(()=>verifyPackage({...cellItem,expected:{...cellItem.expected,cellText:[{table:3,row:1,column:1,text:'1'}]}},source,make({markdown:md})),{code:'expected_cell_text_mismatch'});
});
