import {MAX_TEXT_BYTES} from './frames.mjs';
import {ConversionFailure} from './failures.mjs';

/** RHWP supplies a JSON-encoded Unicode string. TXT adds no markup or generated text. */
export function textFromUnicode(serialized){
  if(typeof serialized!=='string')throw new ConversionFailure('conversion_error');
  if(serialized.length>MAX_TEXT_BYTES*6+2)throw new ConversionFailure('text_size');
  let text;
  try{text=JSON.parse(serialized);}catch{throw new ConversionFailure('conversion_error');}
  if(typeof text!=='string'||!text.isWellFormed())throw new ConversionFailure('conversion_error');
  if(Buffer.byteLength(text)>MAX_TEXT_BYTES)throw new ConversionFailure('text_size');
  if(!text.trim())throw new ConversionFailure('text_empty');
  return Buffer.from(text,'utf8');
}
