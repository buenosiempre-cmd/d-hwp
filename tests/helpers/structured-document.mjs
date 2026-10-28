// Synthetic, independently named coverage markers. No user document is written to disk.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {crc32,deflateSync} from 'node:zlib';
import init,{HwpDocument} from '@rhwp/core';
let initialized;
const checked=value=>{const result=JSON.parse(value);assert.notEqual(result.ok,false,JSON.stringify(result));return result;};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
function pngChunk(type,bytes){
 const name=Buffer.from(type),header=Buffer.alloc(4),tail=Buffer.alloc(4);header.writeUInt32BE(bytes.length);tail.writeUInt32BE(crc32(Buffer.concat([name,bytes])));return Buffer.concat([header,name,bytes,tail]);
}
function syntheticPng(){
 const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 // Four colored pixels; this is not an OCR fixture and contains no hidden text.
 const pixels=Buffer.from([0,255,0,0,0,255,0,0,0,0,255,255,255,255]);
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(pixels)),pngChunk('IEND',Buffer.alloc(0))]);
}

export async function makeComplexDocument(){
 initialized??=init({module_or_path:await readFile('node_modules/@rhwp/core/rhwp_bg.wasm')});await initialized;
 const expected={
  bodyStart:'본문시작확인문구',bodyEnd:'본문마지막확인문구',
  header:'머리말확인문구',footer:'꼬리말확인문구',footnote:'각주확인문구',endnote:'미주확인문구',
  footnoteAnchor:'각주앵커확인문구',endnoteAnchor:'미주앵커확인문구',
  equation:'EQCHECK + x^2 = y',textbox:'글상자확인문구',
  fieldGuide:'누름틀안내확인문구',fieldMemo:'누름틀설명확인문구',fieldName:'누름틀이름확인문구',
  imageDescription:'그림설명확인문구',linkText:'링크표시확인문구',linkUri:'https://example.invalid/structured-coverage?x=1&y=2',
  mergedCells:Array.from({length:9},(_,index)=>`병합표셀${index+1}확인문구`),
  nestedCells:['중첩표첫셀확인문구','중첩표둘째셀확인문구'],outerCell:'바깥표확인문구',
  hostile:'악성문법확인문구 <script>alert("fixture")</script> <img src="https://example.invalid/tracker"> [외부](javascript:alert(1)) ![그림](https://example.invalid/image) & `코드`',
 };
 const image=syntheticPng(),doc=HwpDocument.createEmpty();
 const paragraph=(text='')=>{const index=doc.getParagraphCount(0);checked(doc.insertParagraph(0,index));if(text)checked(doc.insertText(0,index,0,text));return index;};
 try{
  checked(doc.createBlankDocument());checked(doc.insertText(0,0,0,expected.bodyStart));
  checked(doc.createHeaderFooter(0,true,0));checked(doc.insertTextInHeaderFooter(0,true,0,0,0,expected.header));
  checked(doc.createHeaderFooter(0,false,0));checked(doc.insertTextInHeaderFooter(0,false,0,0,0,expected.footer));
  const foot=checked(doc.insertFootnote(0,paragraph(expected.footnoteAnchor),expected.footnoteAnchor.length));
  checked(doc.insertTextInFootnote(0,foot.paraIdx,foot.controlIdx,0,0,expected.footnote));
  const end=checked(doc.insertEndnote(0,paragraph(expected.endnoteAnchor),expected.endnoteAnchor.length));
  checked(doc.insertTextInFootnote(0,end.paraIdx,end.controlIdx,0,0,expected.endnote));
  const equation=checked(doc.insertEquation(0,paragraph(),0,expected.equation,1000,0));
  const field=checked(doc.insertClickHereField(0,paragraph(),0,expected.fieldGuide,expected.fieldMemo,expected.fieldName,true));
  const merged=checked(doc.createTable(0,paragraph(),0,3,3));
  for(const [index,value]of expected.mergedCells.entries())checked(doc.insertTextInCell(0,merged.paraIdx,merged.controlIdx,index,0,0,value));
  checked(doc.mergeTableCells(0,merged.paraIdx,merged.controlIdx,0,0,0,1));
  checked(doc.mergeTableCells(0,merged.paraIdx,merged.controlIdx,1,2,2,2));
  const mergedDimensions=checked(doc.getTableDimensions(0,merged.paraIdx,merged.controlIdx));
  const mergedSpans=Array.from({length:mergedDimensions.cellCount},(_,cell)=>checked(doc.getCellInfo(0,merged.paraIdx,merged.controlIdx,cell)));
  assert.ok(mergedSpans.some(cell=>cell.colSpan===2));assert.ok(mergedSpans.some(cell=>cell.rowSpan===2));
  const donor=checked(doc.createTable(0,paragraph(),0,1,2));
  for(const [index,value]of expected.nestedCells.entries())checked(doc.insertTextInCell(0,donor.paraIdx,donor.controlIdx,index,0,0,value));
  const outer=checked(doc.createTable(0,paragraph(),0,1,1));
  checked(doc.insertTextInCell(0,outer.paraIdx,outer.controlIdx,0,0,0,expected.outerCell));
  checked(doc.copyControl(0,donor.paraIdx,'[]',donor.controlIdx));
  checked(doc.pasteInternalInCell(0,outer.paraIdx,outer.controlIdx,0,0,expected.outerCell.length));
  // Remove the donor so a false positive cannot come from its body-level copy.
  checked(doc.deleteTableControl(0,donor.paraIdx,donor.controlIdx));
  const textbox=checked(doc.createShapeControl(JSON.stringify({sectionIdx:0,paraIdx:paragraph(),charOffset:0,width:14000,height:2500,shapeType:'textbox',treatAsChar:false,textWrap:'InFrontOfText'})));
  checked(doc.insertTextInCell(0,textbox.paraIdx,textbox.controlIdx,0,0,0,expected.textbox));
  const picture=checked(doc.insertPicture(0,paragraph(),0,'[]',image,3000,3000,2,2,'png',expected.imageDescription));
  const target={section:0,para:paragraph(expected.linkText),cellPath:[]};
  const link=doc.insertHyperlinkEx(JSON.stringify({target,start:0,end:expected.linkText.length,uri:expected.linkUri}));assert.ok(Number.isSafeInteger(link));
  paragraph(expected.hostile);paragraph(expected.bodyEnd);
  // Independently assert creation rather than deriving expectations from extraction.
  const controls=JSON.parse(doc.getControls()),cursor=JSON.parse(doc.getCursorModel());
  assert.ok(controls.some(control=>control.ctrlId==='tbl'&&control.list!==0),'A real nested table must exist');
  assert.ok(cursor.lists.some(list=>list.hostListId!==0),'A nested list must exist');
  assert.ok(doc.getFootnoteInfo(0,foot.paraIdx,foot.controlIdx).includes(expected.footnote));
  assert.ok(doc.getFootnoteInfo(0,end.paraIdx,end.controlIdx).includes(expected.endnote));
  assert.ok(doc.getEquationProperties(0,equation.paraIdx,equation.controlIdx,-1,-1).includes(expected.equation));
  assert.ok(doc.getClickHereProps(field.fieldId).includes(expected.fieldMemo));
  assert.ok(doc.getPictureProperties(0,picture.paraIdx,picture.controlIdx).includes(expected.imageDescription));
  assert.ok(doc.getHyperlinkContext(JSON.stringify(target)).includes('structured-coverage'));
  return {hwp:Buffer.from(doc.exportHwp()),hwpx:Buffer.from(doc.exportHwpx()),expected:{...expected,mergedSpans,imageSha256:sha256(image),image},pageCount:doc.pageCount()};
 }finally{doc.free();}
}
