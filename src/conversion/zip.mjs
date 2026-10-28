import {crc32} from 'node:zlib';
import {MAX_PNG_BYTES,MAX_PNG_TOTAL_BYTES,MAX_ZIP_BYTES} from './frames.mjs';
import {MAX_DOCUMENT_PAGES,normalizeSelectedPages} from './selection.mjs';
import {ConversionFailure} from './failures.mjs';

/** A bounded, deterministic STORE archive. Entry names never contain source/user text. */
export function pageZip(result){
  if(!result||!Number.isSafeInteger(result.pageCount)||result.pageCount<1||result.pageCount>MAX_DOCUMENT_PAGES||!Array.isArray(result.pages))throw new ConversionFailure('conversion_error');
  let selection;
  try{selection=normalizeSelectedPages(result.pages.map(image=>image?.page));}catch{throw new ConversionFailure('page_selection');}
  if(selection.length!==result.pages.length||selection.some((page,i)=>page!==result.pages[i].page||page>result.pageCount))throw new ConversionFailure('page_selection');
  let pngBytes=0,archiveBytes=22;
  const entries=result.pages.map(({page,png})=>{
    if(!Buffer.isBuffer(png)||png.length<8||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new ConversionFailure('conversion_error');
    pngBytes+=png.length;
    if(png.length>MAX_PNG_BYTES||pngBytes>MAX_PNG_TOTAL_BYTES)throw new ConversionFailure('preview_size');
    const name=Buffer.from(`page-${String(page).padStart(3,'0')}.png`,'ascii');
    archiveBytes+=30+name.length+png.length+46+name.length;
    if(archiveBytes>MAX_ZIP_BYTES)throw new ConversionFailure('zip_size');
    return {name,png,crc:crc32(png)};
  });
  const chunks=[],directory=[];let offset=0,directoryBytes=0;
  for(const {name,png,crc} of entries){
    const local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);
    local.writeUInt16LE(0x21,12); // 1980-01-01, 00:00:00; no per-request timestamps.
    local.writeUInt32LE(crc,14);local.writeUInt32LE(png.length,18);local.writeUInt32LE(png.length,22);local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);
    central.writeUInt16LE(0x21,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(png.length,20);central.writeUInt32LE(png.length,24);
    central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    chunks.push(local,name,png);directory.push(central,name);
    offset+=local.length+name.length+png.length;directoryBytes+=central.length+name.length;
  }
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directoryBytes,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...chunks,...directory,end],archiveBytes);
}
