import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {crc32} from 'node:zlib';
import init,{HwpDocument} from '@rhwp/core';
import {convertText,convertSelectedPageImages,convertPageZip,convertPageImages,closeConversionRuntime,MAX_TEXT_BYTES,MAX_ZIP_BYTES} from '../../src/conversion/convert.mjs';
import {textFromUnicode} from '../../src/conversion/text.mjs';
import {normalizeSelectedPages} from '../../src/conversion/selection.mjs';
import {pageZip} from '../../src/conversion/zip.mjs';
import {readFrames,OutputError,MAX_PNG_BYTES,MAX_PNG_TOTAL_BYTES} from '../../src/conversion/frames.mjs';
import {failureCode,isPermanentConversionFailure} from '../../src/conversion/failures.mjs';

const png=Buffer.from('89504e470d0a1a0a','hex');
const frame=(header,bytes=Buffer.alloc(0))=>{
  const json=Buffer.from(JSON.stringify(header)),size=Buffer.alloc(4);size.writeUInt32BE(json.length);
  return Buffer.concat([size,json,bytes]);
};
const info=count=>frame({type:'document',pageCount:count});
const end=()=>frame({type:'end'});
const pngFrame=page=>frame({type:'png',page,bytes:png.length},png);

// Parse both ZIP directories and verify every pointer, filename, stored byte length and CRC.
function unzipStored(zip){
  const last=zip.length-22;
  assert.equal(zip.readUInt32LE(last),0x06054b50);
  assert.equal(zip.readUInt16LE(last+4),0);assert.equal(zip.readUInt16LE(last+6),0);
  const count=zip.readUInt16LE(last+8);assert.equal(zip.readUInt16LE(last+10),count);assert.equal(zip.readUInt16LE(last+20),0);
  const directorySize=zip.readUInt32LE(last+12),directoryStart=zip.readUInt32LE(last+16);
  assert.equal(directoryStart+directorySize,last);
  let current=directoryStart,expectedOffset=0;const entries=new Map();
  for(let i=0;i<count;i++){
    assert.equal(zip.readUInt32LE(current),0x02014b50);
    assert.equal(zip.readUInt16LE(current+10),0);assert.equal(zip.readUInt16LE(current+8),0x800);
    assert.equal(zip.readUInt16LE(current+12),0);assert.equal(zip.readUInt16LE(current+14),0x21);
    const crc=zip.readUInt32LE(current+16),length=zip.readUInt32LE(current+20),nameLength=zip.readUInt16LE(current+28),offset=zip.readUInt32LE(current+42);
    assert.equal(zip.readUInt32LE(current+24),length);assert.equal(zip.readUInt16LE(current+30),0);assert.equal(zip.readUInt16LE(current+32),0);
    assert.equal(offset,expectedOffset);assert.equal(zip.readUInt32LE(offset),0x04034b50);
    assert.equal(zip.readUInt16LE(offset+8),0);assert.equal(zip.readUInt16LE(offset+6),0x800);
    assert.equal(zip.readUInt32LE(offset+14),crc);assert.equal(zip.readUInt32LE(offset+18),length);assert.equal(zip.readUInt32LE(offset+22),length);
    assert.equal(zip.readUInt16LE(offset+26),nameLength);assert.equal(zip.readUInt16LE(offset+28),0);
    const name=zip.subarray(current+46,current+46+nameLength).toString('ascii');
    assert.match(name,/^page-\d{3}\.png$/);assert.equal(zip.subarray(offset+30,offset+30+nameLength).toString('ascii'),name);
    assert.equal(entries.has(name),false);
    const bytes=zip.subarray(offset+30+nameLength,offset+30+nameLength+length);
    assert.equal(bytes.length,length);assert.equal(crc32(bytes),crc);entries.set(name,bytes);
    expectedOffset=offset+30+nameLength+length;current+=46+nameLength;
  }
  assert.equal(expectedOffset,directoryStart);assert.equal(current,last);return entries;
}

test('page selection copies, sorts and deduplicates bounded integer page numbers',async()=>{
  const values=[200,12,1,12];assert.deepEqual(normalizeSelectedPages(values),[1,12,200]);assert.deepEqual(values,[200,12,1,12]);
  for(const value of [undefined,[],[0],[201],[-1],[1.5],[NaN],[Infinity],['1'],new Array(1),Array.from({length:11},(_,i)=>i+1),Array(201).fill(1)]){
    assert.throws(()=>normalizeSelectedPages(value),RangeError);
    await assert.rejects(convertSelectedPageImages(Buffer.from('unused'),{pages:value}),error=>error.code==='conversion_page_selection');
  }
  for(const reason of ['page_selection','text_size','text_empty','zip_size'])assert.equal(isPermanentConversionFailure(failureCode(reason)),true);
});

test('TXT preserves Unicode, whitespace and literal markup; empty or oversized text is never substituted or truncated',()=>{
  const source='한글 😀\r\n\t값  2\n<table> &amp; [링크](https://example.invalid)\n마지막\n';
  assert.deepEqual(textFromUnicode(JSON.stringify(source)),Buffer.from(source));
  const exact='가'.repeat(Math.floor(MAX_TEXT_BYTES/3))+'a'.repeat(MAX_TEXT_BYTES%3);
  assert.equal(textFromUnicode(JSON.stringify(exact)).length,MAX_TEXT_BYTES);
  for(const value of ['', ' \r\n\t'])assert.throws(()=>textFromUnicode(JSON.stringify(value)),error=>error.reason==='text_empty');
  assert.throws(()=>textFromUnicode(JSON.stringify(exact+'a')),error=>error.reason==='text_size');
  for(const value of [null,'private malformed input','{}','null','[1]','12','"\\ud800"'])assert.throws(()=>textFromUnicode(value),error=>error.reason==='conversion_error'&&!error.message.includes('private'));
});

test('TXT frames require bounded UTF-8, the requested type and a complete protocol',async()=>{
  const bytes=Buffer.from('한글 본문\n');
  const body=Buffer.concat([info(1),frame({type:'text',bytes:bytes.length},bytes),end()]);
  assert.deepEqual(await readFrames(Readable.from(Array.from(body,byte=>Buffer.from([byte]))),'text',0,0),bytes);
  for(const value of [
    Buffer.concat([info(1),frame({type:'text',bytes:MAX_TEXT_BYTES+1})]),
    Buffer.concat([info(1),frame({type:'text',bytes:0}),end()]),
    Buffer.concat([info(1),frame({type:'markdown',bytes:bytes.length},bytes),end()]),
    Buffer.concat([info(1),frame({type:'text',bytes:1},Buffer.from([0xff])),end()]),
    body.subarray(0,body.length-1),Buffer.concat([body,Buffer.from('private extra data')]),
  ])await assert.rejects(readFrames(Readable.from([value]),'text',0,0),OutputError);
});

test('selected-page frames reject missing, repeated, unrequested, reordered and out-of-document pages before success',async()=>{
  const consume=(body,pages=[12,40,80],onPage)=>readFrames(Readable.from(body),'selected',0,0,{selectedPages:pages,onPage});
  const good=[info(80),pngFrame(12),pngFrame(40),pngFrame(80),end()];
  assert.deepEqual((await consume(good)).pages.map(image=>image.page),[12,40,80]);
  for(const body of [
    [info(80),pngFrame(40),pngFrame(12),pngFrame(80),end()],
    [info(80),pngFrame(12),pngFrame(12),pngFrame(80),end()],
    [info(80),pngFrame(12),pngFrame(40),end()],
    [info(80),pngFrame(12),pngFrame(40),pngFrame(79),end()],
    [...good,Buffer.from('extra')],
    [info(80),frame({type:'png',page:12,bytes:MAX_PNG_BYTES+1})],
    [info(80),frame({type:'png',page:12,bytes:8},Buffer.alloc(8)),end()],
  ])await assert.rejects(consume(body),OutputError);
  let delivered=0;
  await assert.rejects(consume([info(79),pngFrame(12)],undefined,()=>delivered++),OutputError);
  assert.equal(delivered,0);
  await assert.rejects(consume(good,[]),OutputError);
  const largePng=Buffer.alloc(MAX_PNG_BYTES);png.copy(largePng);
  await assert.rejects(consume([info(80),...Array.from({length:6},(_,i)=>frame({type:'png',page:i+1,bytes:largePng.length},largePng)),end()],[1,2,3,4,5,6]),OutputError);
});

test('bounded ZIP uses deterministic safe names, correct CRC and consistent central/local directories',()=>{
  const images={pageCount:200,pages:[{page:1,png},{page:200,png:Buffer.concat([png,Buffer.from('synthetic')])}]};
  const first=pageZip(images);assert.deepEqual(pageZip(images),first);assert.ok(first.length<=MAX_ZIP_BYTES);
  const entries=unzipStored(first);assert.deepEqual([...entries.keys()],['page-001.png','page-200.png']);
  for(const image of images.pages)assert.deepEqual(entries.get(`page-${String(image.page).padStart(3,'0')}.png`),image.png);
  const corrupted=Buffer.from(first);corrupted[30+'page-001.png'.length]^=1;assert.throws(()=>unzipStored(corrupted));
  for(const result of [
    {pageCount:1,pages:[{page:2,png}]},{pageCount:2,pages:[{page:1,png},{page:1,png}]},
    {pageCount:2,pages:[{page:2,png},{page:1,png}]},{pageCount:1,pages:[]},
    {pageCount:1,pages:[{page:1,png:Buffer.alloc(8)}]},
    {pageCount:1,pages:[{page:1,png:Buffer.alloc(MAX_PNG_BYTES+1)}]},
  ])assert.throws(()=>pageZip(result));
  const large=Buffer.alloc(MAX_PNG_BYTES);png.copy(large);
  const pages=Array.from({length:5},(_,i)=>({page:i+1,png:large}));
  assert.ok(pageZip({pageCount:6,pages}).length<MAX_ZIP_BYTES);
  assert.throws(()=>pageZip({pageCount:6,pages:[...pages,{page:6,png}]}),error=>error.reason==='preview_size');
  assert.equal(pages.reduce((total,image)=>total+image.png.length,0),MAX_PNG_TOTAL_BYTES);
});

for(const format of ['hwp','hwpx'])test(`real ${format} TXT preserves Korean and table text without generated Markdown`,async()=>{
  const bytes=await readFile(`tests/fixtures/viewer-two-pages.${format}`),events=[];
  const text=await convertText(bytes,{onPdf:()=>events.push('pdf'),onPage:()=>events.push('png')});
  assert.deepEqual(events,[]);assert.ok(text.length<=MAX_TEXT_BYTES);
  for(const word of ['한글 문서 미리보기','항목','내용','상태','정상','두 번째 페이지','English 123'])assert.ok(text.toString().includes(word),word);
  await init({module_or_path:await readFile('node_modules/@rhwp/core/rhwp_bg.wasm')});
  const doc=new HwpDocument(bytes);
  try{assert.deepEqual(text,Buffer.from(JSON.parse(doc.getTextFileUnicode())));}finally{doc.free();}
});

test('real selected pages preserve legacy pixels, reject any out-of-document selection and snapshot the request',async()=>{
  const bytes=await readFile('tests/fixtures/viewer-two-pages.hwp'),pages=[2,1,2],events=[];
  const running=convertSelectedPageImages(bytes,{pages,onPdf:()=>events.push('pdf'),onPage:image=>events.push(image.page)});
  pages.push(200);pages[0]=199;
  const selected=await running,legacy=await convertPageImages(bytes,{start:1,end:2});
  assert.deepEqual(events,[1,2]);assert.deepEqual(selected,legacy);
  let delivered=0;
  await assert.rejects(convertSelectedPageImages(bytes,{pages:[1,3],onPage:()=>delivered++}),error=>error.code==='conversion_page_selection');
  assert.equal(delivered,0);
  assert.ok((await convertText(bytes)).length>0,'a failed selection must not poison the next runtime');
});

test('real 80-page document exports only pages 12, 40 and 80 and the ZIP contains exactly their PNG bytes',async()=>{
  const bytes=await readFile('tests/fixtures/shared-image-svg-limit.hwp'),events=[];
  const selected=await convertSelectedPageImages(bytes,{pages:[80,12,40,12],timeoutMs:120_000,onPage:image=>events.push(image.page)});
  assert.equal(selected.pageCount,80);assert.deepEqual(events,[12,40,80]);
  assert.deepEqual(selected.pages.map(image=>image.page),[12,40,80]);
  assert.notDeepEqual(selected.pages[0].png,selected.pages[1].png,'page-specific fixture labels must select distinct source pages');
  assert.notDeepEqual(selected.pages[1].png,selected.pages[2].png);
  const archive=await convertPageZip(bytes,{pages:[40,80,12],timeoutMs:120_000,onPage:()=>assert.fail('ZIP must not publish individual PNGs')});
  assert.equal(archive.pageCount,80);assert.deepEqual(archive.pages,[12,40,80]);assert.ok(archive.zip.length<=MAX_ZIP_BYTES);
  const entries=unzipStored(archive.zip);assert.deepEqual([...entries.keys()],['page-012.png','page-040.png','page-080.png']);
  for(const image of selected.pages)assert.deepEqual(entries.get(`page-${String(image.page).padStart(3,'0')}.png`),image.png);
  const single=await convertSelectedPageImages(bytes,{pages:[80],timeoutMs:120_000});
  assert.deepEqual(single.pages[0].png,selected.pages[2].png,'selection retries must retain the same page geometry');
  await closeConversionRuntime();
});

test('TXT and ZIP cancellation/timeout discard their runtime and a later document succeeds',async()=>{
  const bytes=await readFile('tests/fixtures/viewer-two-pages.hwpx'),controller=new AbortController();controller.abort();
  for(const convert of [options=>convertText(bytes,options),options=>convertPageZip(bytes,{pages:[1],...options})]){
    await assert.rejects(convert({signal:controller.signal}),error=>error.code==='conversion_aborted');
    await assert.rejects(convert({timeoutMs:1}),error=>error.code==='conversion_timeout');
  }
  assert.ok((await convertText(bytes)).length>0);await closeConversionRuntime();
});
