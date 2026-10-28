import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFrames,OutputError,MAX_MARKDOWN_BYTES,MAX_MARKDOWN_REPORT_BYTES,MAX_MARKDOWN_PACKAGE_BYTES} from '../../src/conversion/frames.mjs';
import {writeArchive} from '../../src/conversion/archive.mjs';

const frame=(value,bytes=Buffer.alloc(0))=>{
  const json=Buffer.from(JSON.stringify(value)),length=Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length,json,bytes]);
};
const info=()=>frame({type:'document',pageCount:2});
const end=()=>frame({type:'end'});
const part=(type,bytes)=>frame({type,bytes:bytes.length},bytes);
const markdown=Buffer.from('# 합성 문서 😀\n\n본문과 각주\n');
const report={schemaVersion:1,status:'needs_review',issues:[{code:'image_ocr_not_performed',message:'그림 확인 필요 😀'}]};
const reportBytes=Buffer.from(JSON.stringify(report));
const zip=writeArchive([{name:'document.md',bytes:markdown},{name:'report.json',bytes:reportBytes}]);
const parts=()=>[info(),part('markdown',markdown),part('report',reportBytes),part('archive',zip),end()];
const consume=(chunks,options)=>readFrames(Readable.from(Array.isArray(chunks)?chunks:[chunks]),'markdown-package',0,0,options);

test('Markdown package frames preserve fragmented multibyte text and all three artifacts atomically',async()=>{
  const wire=Buffer.concat(parts()),events=[];
  const chunks=Array.from(wire,byte=>Buffer.from([byte]));
  const result=await consume(chunks,{onPdf:()=>events.push('pdf'),onPage:()=>events.push('page')});
  assert.deepEqual(result,{markdown,report,zip});
  assert.deepEqual(events,[],'a package never publishes partial visual artifacts');
});

test('Markdown package frames require document, Markdown, report, archive and end in order',async()=>{
  const [document,md,reportFrame,archive,finish]=parts();
  for(const [name,chunks] of [
    ['missing document',[md,reportFrame,archive,finish]],
    ['missing Markdown',[document,reportFrame,archive,finish]],
    ['missing report',[document,md,archive,finish]],
    ['missing archive',[document,md,reportFrame,finish]],
    ['report before Markdown',[document,reportFrame,md,archive,finish]],
    ['archive before report',[document,md,archive,reportFrame,finish]],
    ['duplicate Markdown',[document,md,md,reportFrame,archive,finish]],
    ['duplicate report',[document,md,reportFrame,reportFrame,archive,finish]],
    ['duplicate archive',[document,md,reportFrame,archive,archive,finish]],
    ['wrong artifact kind',[document,part('pdf',markdown),reportFrame,archive,finish]],
  ])await assert.rejects(consume(chunks),OutputError,name);
});

test('Markdown package text and report reject malformed UTF-8 instead of replacement characters',async()=>{
  for(const bytes of [Buffer.from([0xff]),Buffer.from([0xc0,0xaf]),Buffer.from([0xe3,0x81]),Buffer.from([0xed,0xa0,0x80])]){
    await assert.rejects(consume([info(),part('markdown',bytes),part('report',reportBytes),part('archive',zip),end()]),OutputError);
    const malformedReport=Buffer.concat([Buffer.from('{"schemaVersion":1,"value":"'),bytes,Buffer.from('"}')]);
    await assert.rejects(consume([info(),part('markdown',markdown),part('report',malformedReport),part('archive',zip),end()]),OutputError);
  }
});

test('Markdown package report must be valid JSON with the supported object schema',async()=>{
  for(const invalid of ['{','{"schemaVersion":1} trailing','null','[]','true','1','"report"','{}','{"schemaVersion":"1"}','{"schemaVersion":0}','{"schemaVersion":2}']){
    await assert.rejects(consume([info(),part('markdown',markdown),part('report',Buffer.from(invalid)),part('archive',zip),end()]),OutputError,invalid);
  }
});

test('Markdown package rejects invalid or excessive declared payload lengths without reading a body',async()=>{
  for(const {type,limit,prefix,min} of [
    {type:'markdown',limit:MAX_MARKDOWN_BYTES,prefix:[info()],min:1},
    {type:'report',limit:MAX_MARKDOWN_REPORT_BYTES,prefix:[info(),part('markdown',markdown)],min:1},
    {type:'archive',limit:MAX_MARKDOWN_PACKAGE_BYTES,prefix:[info(),part('markdown',markdown),part('report',reportBytes)],min:22},
  ]){
    for(const length of [undefined,null,'1',-1,0,0.5,Number.MAX_SAFE_INTEGER+1,limit+1,...(min>1?[min-1]:[])]){
      let readBody=false;
      async function* chunks(){yield* prefix;yield frame({type,bytes:length});readBody=true;yield Buffer.from('body must not be requested');}
      await assert.rejects(readFrames(chunks(),'markdown-package',0,0),OutputError,`${type} length ${length}`);
      assert.equal(readBody,false,`${type} rejects its invalid length before reading the payload`);
    }
  }
});

test('Markdown package accepts exact Markdown and report byte limits',async()=>{
  const exactMarkdown=Buffer.alloc(MAX_MARKDOWN_BYTES,0x61);
  const prefix=Buffer.from('{"schemaVersion":1,"padding":"'),suffix=Buffer.from('"}');
  const exactReport=Buffer.concat([prefix,Buffer.alloc(MAX_MARKDOWN_REPORT_BYTES-prefix.length-suffix.length,0x61),suffix]);
  const result=await consume([info(),part('markdown',exactMarkdown),part('report',exactReport),part('archive',zip),end()]);
  assert.deepEqual(result.markdown,exactMarkdown);
  assert.equal(Buffer.byteLength(JSON.stringify(result.report)),MAX_MARKDOWN_REPORT_BYTES);
  assert.deepEqual(result.zip,zip);
});

test('Markdown package requires a ZIP local-file signature and the complete declared archive bytes',async()=>{
  const corrupt=Buffer.from(zip);corrupt[0]=0;
  const emptyZip=Buffer.alloc(22);emptyZip.writeUInt32LE(0x06054b50);
  for(const bytes of [corrupt,emptyZip,Buffer.alloc(22),Buffer.from('%PDF-this is not a zip!')]){
    await assert.rejects(consume([info(),part('markdown',markdown),part('report',reportBytes),part('archive',bytes),end()]),OutputError);
  }
  await assert.rejects(consume([info(),part('markdown',markdown),part('report',reportBytes),frame({type:'archive',bytes:zip.length},zip.subarray(0,-1))]),OutputError);
});

test('Markdown package rejects truncated headers and bodies at each frame boundary',async()=>{
  const values=parts();
  for(let index=0;index<values.length;index++){
    for(const length of [0,1,3,values[index].length-1]){
      await assert.rejects(consume([...values.slice(0,index),values[index].subarray(0,length)]),OutputError,`frame ${index} at ${length}`);
    }
  }
  for(const length of [0,1,4097]){
    const size=Buffer.alloc(4);size.writeUInt32BE(length);
    await assert.rejects(consume(size),OutputError,`invalid header length ${length}`);
  }
});

test('Markdown package requires end and rejects trailing bytes in the same chunk or later chunks',async()=>{
  const values=parts(),wire=Buffer.concat(values);
  await assert.rejects(consume(values.slice(0,-1)),OutputError,'missing end');
  await assert.rejects(consume([...values.slice(0,-1),frame({type:'done'})]),OutputError,'wrong end');
  for(const trailing of [Buffer.from([0]),end(),info(),Buffer.from('unframed content')]){
    await assert.rejects(consume(Buffer.concat([wire,trailing])),OutputError,'same chunk');
    await assert.rejects(consume([wire,Buffer.alloc(0),trailing]),OutputError,'later chunk');
  }
});

test('persistent worker mode stops at end without consuming a later response',async()=>{
  let readPastEnd=false;
  async function* stream(){yield* parts();readPastEnd=true;yield info();}
  assert.deepEqual(await readFrames(stream(),'markdown-package',0,0,{eof:false}),{markdown,report,zip});
  assert.equal(readPastEnd,false);
  await assert.rejects(consume(Buffer.concat([...parts(),Buffer.from([0])]),{eof:false}),OutputError,'buffered garbage is rejected even before EOF');
});
