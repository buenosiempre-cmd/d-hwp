// Independent minimal ZIP/XML producer for semantic conversion regressions.
import {crc32} from 'node:zlib';
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
export const paragraph=text=>`<hp:p><hp:run><hp:t>${xml(text)}</hp:t></hp:run></hp:p>`;
export function structuralDocument(body,{extra={},manifest='',spine=''}={}){
  return zip({'Contents/content.hpf':`<package><manifest><item id="s0" href="Contents/section0.xml"/>${manifest}</manifest><spine>${spine||'<itemref idref="s0"/>'}</spine></package>`,'Contents/section0.xml':section(body),...extra});
}
