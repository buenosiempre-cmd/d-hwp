import test from 'node:test';
import assert from 'node:assert/strict';
import {crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {extractStructuredMarkdown} from '../../src/conversion/structured-markdown.mjs';
import {ConversionFailure} from '../../src/conversion/failures.mjs';

// An independent, uncompressed ZIP builder makes XML edge cases independent of RHWP.
function zip(entries){
  const local=[],central=[];let offset=0;
  for(const [path,value]of Object.entries(entries)){
    const name=Buffer.from(path),bytes=Buffer.isBuffer(value)?value:Buffer.from(value),checksum=crc32(bytes);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt32LE(checksum,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
    local.push(header,name,bytes);
    const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt32LE(checksum,16);directory.writeUInt32LE(bytes.length,20);directory.writeUInt32LE(bytes.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);central.push(directory,name);offset+=header.length+name.length+bytes.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,directory,end]);
}
const xml=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const section=body=>`<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`;
const paragraph=text=>`<hp:p><hp:run><hp:t>${xml(text)}</hp:t></hp:run></hp:p>`;
function document(body,{extra={},manifest='',spine=''}={}){
  return zip({'Contents/content.hpf':`<package><manifest><item id="s0" href="Contents/section0.xml"/>${manifest}</manifest><spine>${spine||'<itemref idref="s0"/>'}</spine></package>`,'Contents/section0.xml':section(body),...extra});
}
const extract=(hwpx,options={})=>extractStructuredMarkdown({hwpx,sourceFormat:'hwpx',pageCount:1,...options});
const restore=text=>text.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g,'$1').replace(/&#32;/g,' ').replace(/&#9;/g,'\t').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const failure=code=>error=>error instanceof ConversionFailure&&error.message===code;

test('spine order, unsupported body text and metadata attributes remain auditable',()=>{
  const result=extract(document(paragraph('첫구역')+'<hp:vendor privateNote="속성의견"><hp:t>미지원 본문</hp:t></hp:vendor>',{
    extra:{'Contents/section1.xml':section(paragraph('둘째구역')),'Contents/memos.xml':'<memos><revision privateText="삭제 전 원문" reviewer="검토자">수정 메모</revision></memos>'},
    manifest:'<item id="s1" href="Contents/section1.xml"/>',spine:'<itemref idref="s1"/><itemref idref="s0"/>'
  }));
  const text=restore(result.markdown.toString());
  assert.ok(text.indexOf('둘째구역')<text.indexOf('첫구역'));
  for(const value of ['미지원 본문','속성의견','삭제 전 원문','검토자','수정 메모'])assert.ok(text.includes(value),value);
  assert.equal(result.report.coverage.xmlTextNodes,4);assert.equal(result.report.coverage.unaccountedTextNodes,0);
  assert.equal(result.report.coverage.renderedTextNodes,4);assert.equal(result.report.status,'needs_review');
  for(const code of ['unknown_element','unknown_metadata','supplementary_xml_text'])assert.ok(result.report.issues.some(item=>item.code===code),code);
});

test('known elements with unknown attributes and foreign namespaces do not silently discard them',()=>{
  const result=extract(document('<hp:p secretLabel="속성 보존"><x:t xmlns:x="urn:vendor" marker="확인값">외부 namespace 본문</x:t></hp:p>'));
  const text=restore(result.markdown.toString());
  for(const value of ['속성 보존','확인값','외부 namespace 본문'])assert.ok(text.includes(value));
  assert.ok(result.report.issues.some(item=>item.code==='unknown_attributes'));
  assert.ok(result.report.issues.some(item=>item.code==='unknown_namespace'));
});

test('field instructions, field name, decoded hyperlink target and raw command are retained',()=>{
  const uri='https://example.invalid/문서?a=1&b=2',command=uri.replace(':','\\:')+';1;0;0;';
  const result=extract(document(`<hp:p><hp:run><hp:ctrl><hp:fieldBegin id="1" type="CLICK_HERE" name="필드 이름"><hp:parameters><hp:stringParam name="Command">누름틀 안내 및 도움말</hp:stringParam></hp:parameters></hp:fieldBegin><hp:fieldEnd beginIDRef="1"/><hp:fieldBegin id="2" type="HYPERLINK"><hp:parameters><hp:stringParam name="Command">${xml(command)}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>링크 표시</hp:t></hp:run></hp:p>`));
  const text=restore(result.markdown.toString());
  for(const value of ['필드 이름','누름틀 안내 및 도움말',uri,command,'링크 표시'])assert.ok(text.includes(value),value);
  assert.equal(result.report.counts.fields,2);assert.doesNotMatch(result.markdown.toString(),/\]\(https?:/);
});

test('merged and nested tables keep independent coordinates and stable table IDs',()=>{
  const cell=(row,column,rows,columns,body)=>`<hp:tc><hp:subList>${body}</hp:subList><hp:cellAddr rowAddr="${row}" colAddr="${column}"/><hp:cellSpan rowSpan="${rows}" colSpan="${columns}"/></hp:tc>`;
  const nested=`<hp:tbl rowCnt="1" colCnt="1"><hp:tr>${cell(0,0,1,1,paragraph('중첩표'))}</hp:tr></hp:tbl>`;
  const outer=`<hp:tbl rowCnt="2" colCnt="2"><hp:tr>${cell(0,0,2,1,paragraph('세로 병합'))}${cell(0,1,1,1,paragraph('부모 셀')+nested)}</hp:tr><hp:tr>${cell(1,1,1,1,paragraph('마지막 셀'))}</hp:tr></hp:tbl>`;
  const result=extract(document(outer)),text=result.markdown.toString();
  assert.equal(result.report.counts.tables,2);assert.equal(result.report.counts.cells,4);
  assert.deepEqual(result.report.tables[0].cells[0],{row:1,column:1,rowSpan:2,colSpan:1});
  assert.match(text,/### 표 1 \(table-1\)/);assert.match(text,/### 표 2 \(table-2\).*부모 표 table-1/);
  assert.ok(text.indexOf('부모 셀')<text.indexOf('중첩표'));
  assert.throws(()=>extract(document('<hp:tbl rowCnt="1" colCnt="1"><hp:tr>'+cell(0,0,1,1,paragraph('첫셀'))+cell(0,0,1,1,paragraph('겹친셀'))+'</hp:tr></hp:tbl>')),failure('markdown_structure'));
});

test('headers, notes, equations and text boxes survive outside ordinary body text',()=>{
  const content=`<hp:p><hp:run><hp:ctrl><hp:header applyPageType="BOTH"><hp:subList>${paragraph('머리말')}</hp:subList></hp:header><hp:footer><hp:subList>${paragraph('꼬리말')}</hp:subList></hp:footer><hp:footNote number="1"><hp:subList>${paragraph('각주')}</hp:subList></hp:footNote><hp:endNote number="2"><hp:subList>${paragraph('미주')}</hp:subList></hp:endNote></hp:ctrl><hp:equation><hp:script>x^2 + y = z</hp:script></hp:equation><hp:rect><hp:drawText><hp:subList>${paragraph('글상자')}</hp:subList></hp:drawText></hp:rect></hp:run></hp:p>`;
  const result=extract(document(content)),text=restore(result.markdown.toString());
  for(const value of ['머리말','꼬리말','각주','미주','x^2 + y = z','글상자'])assert.ok(text.includes(value));
  for(const key of ['headers','footers','footnotes','endnotes','equations','textBoxes'])assert.equal(result.report.counts[key],1,key);
  assert.equal(result.report.coverage.xmlTextNodes,result.report.coverage.renderedTextNodes);
});

test('superscript, subscript, deletion and numbering ambiguity are visible',()=>{
  const header='<head><charPr id="1"><supscript/></charPr><charPr id="2"><subscript/></charPr><charPr id="3"><strikeout shape="SOLID"/></charPr><paraPr id="1"><heading type="NUMBER" level="0" idRef="1"/></paraPr></head>';
  const result=extract(document('<hp:p paraPrIDRef="1"><hp:run><hp:t>10</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>4</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>2</hp:t></hp:run><hp:run charPrIDRef="3"><hp:t>삭제 금액</hp:t></hp:run></hp:p>',{extra:{'Contents/header.xml':header}}));
  const text=restore(result.markdown.toString());assert.ok(text.includes('10〔위첨자: 4〕'));assert.ok(text.includes('〔아래첨자: 2〕'));assert.ok(text.includes('〔취소선: 삭제 금액〕'));
  assert.ok(result.report.issues.some(item=>item.code==='numbering_requires_review'));
});

test('source HTML and Markdown remain literal while raster assets use only local hash names',()=>{
  const hostile='<script>alert(1)</script> <img src="https://example.invalid/x"> ![x](https://example.invalid/x) [x](javascript:alert(1)) & `code`',png=Buffer.from('89504e470d0a1a0a0001020304','hex'),svg=Buffer.from('<svg onload="alert(1)"></svg>');
  const result=extract(document(paragraph(hostile)+'<hp:pic><hp:img binaryItemIDRef="image"/><hp:shapeComment>그림 설명</hp:shapeComment></hp:pic><hp:pic><hp:img binaryItemIDRef="vector"/></hp:pic>',{extra:{'BinData/source.png':png,'BinData/source.svg':svg},manifest:'<item id="image" href="BinData/source.png"/><item id="vector" href="BinData/source.svg"/>'}));
  const text=result.markdown.toString();assert.ok(restore(text).includes(hostile));assert.doesNotMatch(text,/<script|<img|<svg|!\[[^\]]*\]\(https?:|\]\(javascript:/i);
  const digest=createHash('sha256').update(png).digest('hex');assert.deepEqual(result.assets.find(asset=>asset.name===`assets/${digest}.png`).bytes,png);
  assert.equal(result.assets.find(asset=>asset.bytes.equals(svg)).mime,'application/octet-stream');assert.ok(result.assets.find(asset=>asset.bytes.equals(svg)).name.endsWith('.bin'));
  assert.ok(text.includes('그림 설명'));assert.ok(result.report.issues.some(item=>item.code==='image_ocr_not_performed'));assert.equal(result.report.status,'needs_review');
});

test('unresolved external resources and HWP engine limits cannot claim full extraction',()=>{
  const result=extract(document(paragraph('본문'),{manifest:'<item id="external" href="https://example.invalid/secret"/>'}),{sourceFormat:'hwp',engineLoss:{count:0},unicode:'본문',controls:[]});
  assert.equal(result.report.status,'needs_review');for(const code of ['unresolved_manifest_item','hwp_import_scope'])assert.ok(result.report.issues.some(item=>item.code===code));
  assert.match(result.report.coverage.scope,/does not prove/);assert.equal(result.report.engineText.characters,2);
  const loss=extract(document(paragraph('본문')),{sourceFormat:'hwp',engineLoss:{count:1}});assert.ok(loss.report.issues.some(item=>item.code==='engine_reported_loss'));
});

test('output and cumulative table limits fail without returning truncated Markdown',()=>{
  assert.throws(()=>extract(document(paragraph('&'.repeat(450000)))),failure('markdown_size'));
  assert.throws(()=>extract(document('<hp:tbl rowCnt="1000" colCnt="100"/><hp:tbl rowCnt="1000" colCnt="100"/>')),failure('markdown_package_size'));
  assert.throws(()=>extract(document(paragraph('본문')),{sourceFormat:'docx'}),failure('markdown_structure'));
});

test('engine text missing from the XML model is retained as a disclosed fallback',()=>{
  const result=extract(document(paragraph('XML 본문')),{sourceFormat:'hwp',unicode:'XML 본문\r\n구조 변환에서 빠진 내용'});
  assert.ok(restore(result.markdown.toString()).includes('구조 변환에서 빠진 내용'));
  assert.equal(result.report.engineText.unmatchedFragments,1);assert.ok(result.report.issues.some(item=>item.code==='engine_text_not_in_xml'));
  assert.equal(result.report.coverage.xmlTextNodes,1,'engine-only fallback is not falsely counted as XML text');
});

test('paragraph assembly does not trim authored text edge whitespace',()=>{
  const result=extract(document(paragraph('\n  원문 끝 공백 \t\n'))),text=result.markdown.toString();
  assert.ok(text.includes('&#10;&#32;&#32;원문 끝 공백&#32;&#9;&#10;'));
  assert.equal(result.report.coverage.xmlTextCharacters,result.report.coverage.renderedTextCharacters);
});

test('qualified attribute collisions retain the unconsumed qualified value',()=>{
  const result=extract(document('<hp:fieldBegin xmlns:x="urn:vendor" name="visible" x:name="HIDDEN_ATTRIBUTE" type="FORM"/>'));
  const text=restore(result.markdown.toString());assert.ok(text.includes('visible'));assert.ok(text.includes('HIDDEN_ATTRIBUTE'));assert.ok(text.includes('/@x:name'));
  assert.equal(result.report.status,'needs_review');assert.ok(result.report.issues.some(item=>item.code==='unknown_attributes'));
  const single=extract(document('<hp:fieldBegin xmlns:x="urn:vendor" x:name="UNIQUE_QUALIFIED_NAME" type="FORM"/>'));
  assert.equal(restore(single.markdown.toString()).split('UNIQUE_QUALIFIED_NAME').length-1,1,'a uniquely resolved qualified key is consumed exactly once');
});

test('engine comparison consumes each occurrence and cannot join separate paragraph boundaries',()=>{
  const repeated=extract(document(paragraph('KEEP')+paragraph('REPEATED')),{unicode:'KEEP\nREPEATED\nREPEATED\nREPEATED'});
  assert.equal(repeated.report.engineText.unmatchedFragments,2);assert.equal(restore(repeated.markdown.toString()).split('REPEATED').length-1,3,'both missing repetitions survive the fallback');
  assert.ok(repeated.report.issues.some(item=>item.code==='engine_text_not_in_xml'));
  const boundary=extract(document(paragraph('A')+paragraph('B')),{unicode:'AB'});
  assert.equal(boundary.report.engineText.unmatchedFragments,1);assert.ok(restore(boundary.markdown.toString()).includes('- AB'));
  const inOrder=extract(document(paragraph('KEEP')+paragraph('REPEATED')+paragraph('REPEATED')),{unicode:'KEEP\nREPEATED\nREPEATED'});
  assert.equal(inOrder.report.engineText.unmatchedFragments,0);
});
