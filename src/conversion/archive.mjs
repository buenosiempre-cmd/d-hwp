import {crc32,inflateRawSync} from 'node:zlib';
import {ConversionFailure} from './failures.mjs';

const LIMITS=Object.freeze({maxInputBytes:50*1024*1024,maxTotalBytes:64*1024*1024,maxEntryBytes:32*1024*1024,maxEntries:4096});
const MAX_OUTPUT_BYTES=50*1024*1024;
const invalid=()=>{throw new ConversionFailure('archive_input');};
const outputInvalid=()=>{throw new ConversionFailure('markdown_package_size');};
const decoder=new TextDecoder('utf-8',{fatal:true});

function limits(options){
  if(!options||typeof options!=='object'||Array.isArray(options))invalid();
  if(Object.keys(options).some(key=>!Object.hasOwn(LIMITS,key)))invalid();
  const result={...LIMITS};
  for(const key of Object.keys(LIMITS))if(options[key]!==undefined){
    if(!Number.isSafeInteger(options[key])||options[key]<1||options[key]>LIMITS[key])invalid();
    result[key]=options[key];
  }
  return result;
}
function validPath(name){
  if(!name||Buffer.byteLength(name)>1024||/[\\:\u0000-\u001f\u007f]/.test(name)||name.startsWith('/'))return false;
  const path=name.endsWith('/')?name.slice(0,-1):name;
  return !!path&&!path.split('/').some(part=>!part||part==='.'||part==='..'||/[ .]$/.test(part));
}
function nameFrom(raw,flags){
  if(!(flags&0x800)&&raw.some(byte=>byte>0x7f))invalid();
  let name;try{name=decoder.decode(raw);}catch{invalid();}
  if(!validPath(name))invalid();return name;
}
function extraFields(bytes,rawName,name){
  const seen=new Set();
  for(let at=0;at<bytes.length;){
    if(at+4>bytes.length)invalid();
    const id=bytes.readUInt16LE(at),length=bytes.readUInt16LE(at+2);at+=4;
    if(at+length>bytes.length||seen.has(id))invalid();seen.add(id);
    const value=bytes.subarray(at,at+length);at+=length;
    if(id===0x0001||id===0x9901||id===0x0017)invalid(); // ZIP64 and encryption.
    if(id===0x7075){
      if(value.length<5||value[0]!==1||value.readUInt32LE(1)!==crc32(rawName))invalid();
      let unicode;try{unicode=decoder.decode(value.subarray(5));}catch{invalid();}
      if(unicode!==name)invalid(); // Do not permit a second, disagreeing pathname.
    }
  }
}

/** Read a bounded ZIP entirely in memory. No entry is ever extracted to disk. */
export function readArchive(input,options={}){
  try{return read(input,limits(options));}catch{invalid();}
}
function read(input,cap){
  if(!(input instanceof Uint8Array)||input.byteLength<22||input.byteLength>cap.maxInputBytes)invalid();
  const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength);
  let end=-1;
  for(let at=bytes.length-22;at>=Math.max(0,bytes.length-22-65535);at--){
    if(bytes.readUInt32LE(at)===0x06054b50&&at+22+bytes.readUInt16LE(at+20)===bytes.length){end=at;break;}
  }
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0)invalid();
  const count=bytes.readUInt16LE(end+10),directoryBytes=bytes.readUInt32LE(end+12),directoryStart=bytes.readUInt32LE(end+16);
  if(count!==bytes.readUInt16LE(end+8)||count===0xffff||count>cap.maxEntries||directoryBytes===0xffffffff||directoryStart===0xffffffff||directoryStart+directoryBytes!==end)invalid();
  if(end>=20&&bytes.readUInt32LE(end-20)===0x07064b50)invalid();
  const entries=[],names=new Map();let cursor=directoryStart,total=0;
  for(let i=0;i<count;i++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)invalid();
    const needed=bytes.readUInt16LE(cursor+6),flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10);
    const crc=bytes.readUInt32LE(cursor+16),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24);
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32);
    const disk=bytes.readUInt16LE(cursor+34),external=bytes.readUInt32LE(cursor+38),offset=bytes.readUInt32LE(cursor+42);
    const next=cursor+46+nameLength+extraLength+commentLength;
    if(next>end||!nameLength||needed>20||(flags&~0x080e)||![0,8].includes(method)||(method===0&&(flags&6))||disk!==0||offset===0xffffffff||compressed===0xffffffff||size===0xffffffff||size>cap.maxEntryBytes)invalid();
    const rawName=bytes.subarray(cursor+46,cursor+46+nameLength),name=nameFrom(rawName,flags);
    extraFields(bytes.subarray(cursor+46+nameLength,cursor+46+nameLength+extraLength),rawName,name);
    const directory=name.endsWith('/'),kind=(external>>>16)&0xf000;
    if(kind!==0&&kind!==0x8000&&kind!==0x4000)invalid();
    if((kind===0x4000||external&0x10)&&!directory||directory&&kind===0x8000||directory&&(size!==0||method!==0||compressed!==0))invalid();
    const canonical=(directory?name.slice(0,-1):name).normalize('NFC').toLowerCase();
    if(names.has(canonical))invalid();names.set(canonical,{directory});
    total+=size;if(total>cap.maxTotalBytes)invalid();
    if(method===0&&compressed!==size)invalid();
    entries.push({name,rawName,needed,flags,method,crc,compressed,size,offset,directory,time:bytes.readUInt32LE(cursor+12)});
    cursor=next;
  }
  if(cursor!==end)invalid();
  // A regular file cannot simultaneously act as another entry's directory.
  for(const name of names.keys()){
    const parts=name.split('/');for(let i=1;i<parts.length;i++)if(names.get(parts.slice(0,i).join('/'))?.directory===false)invalid();
  }
  for(const entry of entries){
    const {offset,rawName,needed,flags,method,crc,compressed,size,name,time}=entry;
    if(offset+30>directoryStart||bytes.readUInt32LE(offset)!==0x04034b50||bytes.readUInt16LE(offset+4)!==needed||bytes.readUInt16LE(offset+6)!==flags||bytes.readUInt16LE(offset+8)!==method||bytes.readUInt32LE(offset+10)!==time)invalid();
    const localCrc=bytes.readUInt32LE(offset+14),localCompressed=bytes.readUInt32LE(offset+18),localSize=bytes.readUInt32LE(offset+22);
    const nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28),dataStart=offset+30+nameLength+extraLength;
    if(dataStart>directoryStart||nameLength!==rawName.length||!bytes.subarray(offset+30,offset+30+nameLength).equals(rawName))invalid();
    extraFields(bytes.subarray(offset+30+nameLength,dataStart),rawName,name);
    if(flags&8){if((localCrc!==0&&localCrc!==crc)||(localCompressed!==0&&localCompressed!==compressed)||(localSize!==0&&localSize!==size))invalid();}
    else if(localCrc!==crc||localCompressed!==compressed||localSize!==size)invalid();
    const dataEnd=dataStart+compressed;if(dataEnd>directoryStart)invalid();
    let localEnd=dataEnd;
    if(flags&8){
      const lengths=[];
      if(dataEnd+16<=directoryStart&&bytes.readUInt32LE(dataEnd)===0x08074b50&&bytes.readUInt32LE(dataEnd+4)===crc&&bytes.readUInt32LE(dataEnd+8)===compressed&&bytes.readUInt32LE(dataEnd+12)===size)lengths.push(16);
      if(dataEnd+12<=directoryStart&&bytes.readUInt32LE(dataEnd)===crc&&bytes.readUInt32LE(dataEnd+4)===compressed&&bytes.readUInt32LE(dataEnd+8)===size)lengths.push(12);
      if(lengths.length!==1)invalid();localEnd+=lengths[0];
    }
    Object.assign(entry,{dataStart,dataEnd,localEnd});
  }
  // Reject overlapping entries, ignored prefixes, hidden local entries and gaps.
  let position=0;
  for(const entry of [...entries].sort((a,b)=>a.offset-b.offset)){if(entry.offset!==position)invalid();position=entry.localEnd;}
  if(position!==directoryStart)invalid();
  const result=new Map();
  for(const entry of entries){
    const compressed=bytes.subarray(entry.dataStart,entry.dataEnd);let content;
    if(entry.method===0)content=Buffer.from(compressed);
    else{
      const inflated=inflateRawSync(compressed,{maxOutputLength:Math.max(1,entry.size),info:true});
      if(inflated.engine.bytesWritten!==compressed.length)invalid();content=inflated.buffer;
    }
    if(content.length!==entry.size||crc32(content)!==entry.crc)invalid();
    if(!entry.directory)result.set(entry.name,content);
  }
  return result;
}

function outputPath(name){
  if(typeof name!=='string'||!validPath(name)||!/^[\x21-\x7e]+$/.test(name))return false;
  return /^(?:README\.md|document\.md|report\.json|source\/(?:original\.(?:hwp|hwpx)|structure\.hwpx)|assets\/[a-f0-9]{64}\.[a-z0-9]{1,12}|source\/structure\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)$/.test(name);
}
/** Deterministic STORE ZIP with only server-generated, portable output paths. */
export function writeArchive(input,options={}){
  try{
    const maxBytes=options.maxBytes??MAX_OUTPUT_BYTES;
    if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>key!=='maxBytes')||!Number.isSafeInteger(maxBytes)||maxBytes<22||maxBytes>MAX_OUTPUT_BYTES||!Array.isArray(input)||!input.length||input.length>LIMITS.maxEntries)outputInvalid();
    const seen=new Set();let bytes=22;
    const entries=input.map(entry=>{
      if(!entry||!outputPath(entry.name)||!(entry.bytes instanceof Uint8Array)||entry.bytes.byteLength>LIMITS.maxEntryBytes||seen.has(entry.name.toLowerCase()))outputInvalid();
      seen.add(entry.name.toLowerCase());
      const name=Buffer.from(entry.name,'ascii'),content=Buffer.from(entry.bytes);
      bytes+=76+2*name.length+content.length;if(bytes>maxBytes)outputInvalid();
      return {name,content,crc:crc32(content)};
    });
    for(const name of seen){const parts=name.split('/');for(let i=1;i<parts.length;i++)if(seen.has(parts.slice(0,i).join('/')))outputInvalid();}
    const chunks=[],directory=[];let offset=0,directoryBytes=0;
    for(const {name,content,crc} of entries){
      const local=Buffer.alloc(30),central=Buffer.alloc(46);
      local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(0x21,12);
      local.writeUInt32LE(crc,14);local.writeUInt32LE(content.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);
      central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(0x21,14);
      central.writeUInt32LE(crc,16);central.writeUInt32LE(content.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
      chunks.push(local,name,content);directory.push(central,name);offset+=local.length+name.length+content.length;directoryBytes+=central.length+name.length;
    }
    const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directoryBytes,12);end.writeUInt32LE(offset,16);
    return Buffer.concat([...chunks,...directory,end],bytes);
  }catch{outputInvalid();}
}
