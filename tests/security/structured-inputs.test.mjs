import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {crc32,deflateRawSync} from 'node:zlib';
import {readArchive,writeArchive} from '../../src/conversion/archive.mjs';
import {parseXml,childElements,textContent,attr} from '../../src/conversion/xml.mjs';

// A separate ZIP producer for input-format tests, including data descriptors
// used by streaming HWPX writers. It intentionally permits hostile fixtures.
function inputZip(items){
  const locals=[],centrals=[],locations=[];let offset=0;
  for(const item of items){
    const name=Buffer.from(item.name),content=Buffer.from(item.content??''),method=item.method??8;
    const compressed=item.compressed??(method===8?deflateRawSync(content):content),size=item.size??content.length,crc=item.crc??crc32(content);
    const descriptor=item.descriptor,flags=item.flags??(0x800|(descriptor?8:0)),extra=item.extra??Buffer.alloc(0),localExtra=item.localExtra??extra;
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);
    if(!descriptor){local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(size,22);}
    local.writeUInt16LE(name.length,26);local.writeUInt16LE(localExtra.length,28);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);
    central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);central.writeUInt16LE(extra.length,30);
    central.writeUInt32LE((item.external??0)>>>0,38);central.writeUInt32LE(offset,42);
    const desc=Buffer.alloc(descriptor==='signed'?16:descriptor?12:0);
    if(descriptor){const at=descriptor==='signed'?4:0;if(at)desc.writeUInt32LE(0x08074b50);desc.writeUInt32LE(crc,at);desc.writeUInt32LE(compressed.length,at+4);desc.writeUInt32LE(size,at+8);}
    locations.push({local:offset,data:offset+30+name.length+localExtra.length,descriptor:offset+30+name.length+localExtra.length+compressed.length});
    locals.push(local,name,localExtra,compressed,desc);centrals.push(Buffer.concat([central,name,extra]));
    offset+=local.length+name.length+localExtra.length+compressed.length+desc.length;
  }
  const directoryStart=offset;for(let i=0;i<centrals.length;i++){locations[i].central=offset;offset+=centrals[i].length;}
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(items.length,8);end.writeUInt16LE(items.length,10);end.writeUInt32LE(offset-directoryStart,12);end.writeUInt32LE(directoryStart,16);
  return {bytes:Buffer.concat([...locals,...centrals,end]),locations,directoryStart};
}
const archiveReject=(bytes,options)=>assert.throws(()=>readArchive(bytes,options),error=>error.reason==='archive_input'&&error.message==='archive_input');
const xmlReject=value=>assert.throws(()=>parseXml(value),error=>error.reason==='xml_input'&&error.message==='xml_input');
function extra(id,body=Buffer.alloc(0)){const header=Buffer.alloc(4);header.writeUInt16LE(id);header.writeUInt16LE(body.length,2);return Buffer.concat([header,body]);}

test('bounded ZIP reader accepts actual HWPX, STORE, DEFLATE and both streaming descriptor forms',async()=>{
  const actual=readArchive(await readFile('tests/fixtures/viewer-two-pages.hwpx'));
  assert.equal(actual.get('mimetype').toString(),'application/hwp+zip');assert.ok(actual.has('Contents/section0.xml'));
  const contents=[{name:'mimetype',content:'application/hwp+zip',method:0},{name:'Contents/section0.xml',content:'<p>한글 😀</p>',descriptor:'signed'},{name:'Contents/section1.xml',content:'<p>다음</p>',descriptor:'unsigned'},{name:'empty',content:'',method:8},{name:'Folder/',method:0}];
  const values=readArchive(inputZip(contents).bytes);
  for(const item of contents.filter(item=>!item.name.endsWith('/')))assert.equal(values.get(item.name).toString(),item.content);
  assert.equal(values.has('Folder/'),false);
  const unicode=readArchive(inputZip([{name:'그림/한글.png',content:'한글'}]).bytes);assert.equal(unicode.get('그림/한글.png').toString(),'한글');
});

test('ZIP paths, duplicate aliases, file-directory collisions and special files fail closed',()=>{
  for(const name of ['../secret','/root','C:drive','a\\b','a/../b','a/./b','a//b','a\0b','a.','a /b'])archiveReject(inputZip([{name,content:'PRIVATE'}]).bytes);
  for(const names of [['A','a'],['é','e\u0301'],['a','a/b'],['a/','A']])archiveReject(inputZip(names.map(name=>({name,method:0}))).bytes);
  for(const external of [0xa000<<16,0x1000<<16,0x6000<<16,0x4000<<16])archiveReject(inputZip([{name:'bad',external}]).bytes);
  archiveReject(inputZip([{name:'directory/',content:'not empty',method:0}]).bytes);
  archiveReject(inputZip([{name:'한글',flags:0}]).bytes);
});

test('ZIP integrity rejects bad CRC, local-central disagreement, forged sizes and malformed descriptors',()=>{
  archiveReject(inputZip([{name:'a',content:'body',crc:0}]).bytes);
  archiveReject(inputZip([{name:'a',content:'body',size:2,method:0}]).bytes);
  // Deflate declares one byte but expands much further: maxOutputLength stops it.
  archiveReject(inputZip([{name:'a',content:'a'.repeat(1024*1024),size:1}]).bytes);
  const base=inputZip([{name:'a',content:'body'}]);
  const cases=[bytes=>bytes.writeUInt32LE(1,14),bytes=>bytes.writeUInt16LE(0,8),bytes=>bytes.writeUInt16LE(0,6),bytes=>{bytes[30]=0x62;},bytes=>bytes.writeUInt32LE(0xffffffff,base.locations[0].central+20),bytes=>bytes.writeUInt16LE(1,base.locations[0].central+34)];
  for(const change of cases){const bytes=Buffer.from(base.bytes);change(bytes);archiveReject(bytes);}
  const streamed=inputZip([{name:'a',content:'body',descriptor:'signed'}]);streamed.bytes[streamed.locations[0].descriptor+4]^=1;archiveReject(streamed.bytes);
  const deflated=deflateRawSync(Buffer.from('body'));archiveReject(inputZip([{name:'a',content:'body',compressed:Buffer.concat([deflated,Buffer.from('hidden')])}]).bytes);
});

test('ZIP encryption, ZIP64, alternate Unicode names and broken extra fields are rejected',()=>{
  for(const flags of [1,0x40,0x2000])archiveReject(inputZip([{name:'a',flags}]).bytes);
  for(const id of [0x0001,0x9901,0x0017])archiveReject(inputZip([{name:'a',extra:extra(id)}]).bytes);
  archiveReject(inputZip([{name:'a',extra:Buffer.from([1,2,3])}]).bytes);
  archiveReject(inputZip([{name:'a',extra:Buffer.concat([extra(0x9999),extra(0x9999)])}]).bytes);
  const body=Buffer.alloc(5);body[0]=1;body.writeUInt32LE(crc32(Buffer.from('a')),1);
  archiveReject(inputZip([{name:'a',extra:extra(0x7075,Buffer.concat([body,Buffer.from('../b')]))}]).bytes);
  assert.equal(readArchive(inputZip([{name:'a',extra:extra(0x7075,Buffer.concat([body,Buffer.from('a')]))}]).bytes).get('a').length,0);
  const invalidUtf=inputZip([{name:'a'}]);invalidUtf.bytes[30]=0xff;invalidUtf.bytes[invalidUtf.locations[0].central+46]=0xff;archiveReject(invalidUtf.bytes);
});

test('ZIP offsets reject overlaps, self-extracting prefixes, hidden local data and trailing bytes',()=>{
  const base=inputZip([{name:'a',content:'a'},{name:'b',content:'b'}]);
  const overlap=Buffer.from(base.bytes);overlap.writeUInt32LE(0,base.locations[1].central+42);archiveReject(overlap);
  const prefix=Buffer.concat([Buffer.from('prefix'),base.bytes]);
  for(const location of base.locations)prefix.writeUInt32LE(location.local+6,location.central+6+42);
  prefix.writeUInt32LE(base.directoryStart+6,prefix.length-22+16);archiveReject(prefix);
  const gap=Buffer.concat([base.bytes.subarray(0,base.directoryStart),Buffer.from('hidden'),base.bytes.subarray(base.directoryStart)]);
  gap.writeUInt32LE(base.directoryStart+6,gap.length-22+16);archiveReject(gap);
  archiveReject(Buffer.concat([base.bytes,Buffer.from('trailing')]));
  const disk=Buffer.from(base.bytes);disk.writeUInt16LE(1,disk.length-22+4);archiveReject(disk);
});

test('ZIP resource caps apply before inflation and cannot be raised by options',()=>{
  const bytes=inputZip([{name:'a',content:'123456'},{name:'b',content:'123456'}]).bytes;
  for(const options of [{maxEntries:1},{maxEntryBytes:5},{maxTotalBytes:10},{maxInputBytes:22},{maxEntries:4097},{maxEntryBytes:33*1024*1024},{maxTotalBytes:65*1024*1024},{maxInputBytes:51*1024*1024},{maxEntries:NaN},{maxEntries:0},{unknown:1}])archiveReject(bytes,options);
});

test('package writer is deterministic, CRC-correct and accepts only fixed server-generated paths',()=>{
  const source=Buffer.from('synthetic source'),items=[{name:'document.md',bytes:Buffer.from('# 문서')},{name:'report.json',bytes:Buffer.from('{"schemaVersion":1}')},{name:'source/original.hwp',bytes:source},{name:'assets/'+'a'.repeat(64)+'.png',bytes:Buffer.from('png')},{name:'source/structure/Contents/section0.xml',bytes:Buffer.from('<p/>')}];
  const first=writeArchive(items),second=writeArchive(items);assert.deepEqual(first,second);
  const read=readArchive(first);for(const item of items)assert.deepEqual(read.get(item.name),item.bytes);
  for(const name of ['../document.md','Document.md','source/../../x','assets/user.png','assets/'+'a'.repeat(64)+'.png?x','source/structure/a/../b','arbitrary.txt'])assert.throws(()=>writeArchive([{name,bytes:source}]),{reason:'markdown_package_size'});
  assert.throws(()=>writeArchive([items[0],items[0]]),{reason:'markdown_package_size'});
  assert.throws(()=>writeArchive([{name:'source/structure/a',bytes:source},{name:'source/structure/a/b',bytes:source}]),{reason:'markdown_package_size'});
  assert.throws(()=>writeArchive(items,{maxBytes:22}),{reason:'markdown_package_size'});
  assert.throws(()=>writeArchive(items,{maxBytes:51*1024*1024}),{reason:'markdown_package_size'});
});

test('XML keeps namespaces, mixed content, CDATA, Unicode and attribute identities without prototype pollution',()=>{
  const root=parseXml(Buffer.from('\ufeff<?xml version="1.0" encoding="UTF-8"?><h:p xmlns:h="urn:p" xmlns:a="urn:a" xmlns:b="urn:b" __proto__="safe" a:id="1" b:id="2">앞&amp;<h:t xml:space="preserve"> 글 😀 </h:t><![CDATA[<literal>]]>뒤</h:p>'));
  assert.equal(root.name,'p');assert.equal(root.qname,'h:p');assert.equal(root.uri,'urn:p');assert.equal(Object.getPrototypeOf(root.attrs),null);
  assert.equal(attr(root,'__proto__'),'safe');assert.equal(attr(root,'id'),undefined);assert.equal(attr(root,'a:id'),'1');
  assert.equal(textContent(root),'앞& 글 😀 <literal>뒤');assert.equal(childElements(root,'t').length,1);assert.equal(attr(childElements(root)[0],'xml:space'),'preserve');
  assert.equal(textContent(parseXml('<p><![CDATA[<!DOCTYPE literal>]]><!-- <!ENTITY literal> --></p>')),'<!DOCTYPE literal>');
});

test('XML rejects DTD/entity expansion, external references, bad Unicode and malformed documents without echoing content',()=>{
  for(const value of ['<!DOCTYPE p SYSTEM "file:///PRIVATE"><p/>','<!DOCTYPE p [<!ENTITY secret SYSTEM "https://PRIVATE.invalid/">]><p>&secret;</p>','<!DOCTYPE p [<!ENTITY a "EXPANSION">]><p>&a;</p>','<p>&secret;</p>','<p>&#x110000;</p>','<p>&#0;</p>','<p>PRIVATE','<p x="1" x="2"/>','<p xmlns:a="urn:x" xmlns:b="urn:x" a:x="1" b:x="2"/>','<a/><b/>','<?xml version="1.0" encoding="UTF-16"?><p/>','<p>\ud800</p>',Buffer.from([0x3c,0x70,0x3e,0xff,0x3c,0x2f,0x70,0x3e])])xmlReject(value);
  assert.equal(textContent(parseXml('<p>&amp;secret;</p>')),'&secret;');
});

test('XML depth, node, attribute and byte budgets fail instead of returning partial trees',()=>{
  assert.equal(textContent(parseXml('<p>'.repeat(128)+'ok'+'</p>'.repeat(128))),'ok');
  xmlReject('<p>'.repeat(129)+'no'+'</p>'.repeat(129));
  xmlReject('<p>'+Array.from({length:200_000},()=>'<x/>').join('')+'</p>');
  xmlReject('<p '+Array.from({length:129},(_,i)=>`a${i}="x"`).join(' ')+'/>');
  xmlReject('<p a="'+'x'.repeat(65_537)+'"/>');
  xmlReject('<p>'+ 'x'.repeat(16*1024*1024)+'</p>');
});
