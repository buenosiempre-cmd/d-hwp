import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {diagnosticSources} from './diagnostic-sources';

export type DiagnosticCode='exception'|'worker_delivery'|'stage_failure'|'task_failure'|'editor_failure'|'terminal_failure'|'attachment_pending';
export type ExceptionType='Error'|'TypeError'|'RangeError'|'SyntaxError'|'ReferenceError'|'URIError'|'EvalError'|'AggregateError'|'AbortError'|'TimeoutError'|'Other';
export interface StackFrame {file:string;line:number;column:number;}
export interface ErrorDiagnostics {diagnosticCode:DiagnosticCode;exceptionType:ExceptionType;stackFrames:StackFrame[];fingerprint:string;errorId:string;}
const codes=new Set<DiagnosticCode>(['exception','worker_delivery','stage_failure','task_failure','editor_failure','terminal_failure','attachment_pending']);
const exceptionTypes=new Set<ExceptionType>(['Error','TypeError','RangeError','SyntaxError','ReferenceError','URIError','EvalError','AggregateError','AbortError','TimeoutError','Other']);
const sources=new Set<string>(diagnosticSources);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cache=new WeakMap<object,ErrorDiagnostics>();
/** Same message and retry behavior as the existing wait path; classification does not change errorCode. */
export class AttachmentPendingError extends Error {constructor(){super('Awaiting file share event');}}
const nativeStackGetter=Object.getOwnPropertyDescriptor(new Error(),'stack')?.get;
const own=(value:object,key:string):unknown=>Object.getOwnPropertyDescriptor(value,key)?.value;
function dataString(value:object,key:string):string|undefined {
  for(let depth=0,current:object|null=value;current&&depth<8;depth++,current=Object.getPrototypeOf(current)){
    const descriptor=Object.getOwnPropertyDescriptor(current,key);
    if(descriptor)return 'value' in descriptor&&typeof descriptor.value==='string'?descriptor.value:undefined;
  }
  return undefined;
}
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=1_000_000;
const fingerprint=(type:ExceptionType,frames:StackFrame[])=>createHash('sha256').update(JSON.stringify([type,frames])).digest('hex');
function exceptionType(error:unknown):ExceptionType {
  if(error instanceof DOMException)return error.name==='AbortError'?'AbortError':error.name==='TimeoutError'?'TimeoutError':'Other';
  if(!types.isNativeError(error))return 'Other';
  for(const [constructor,name] of [[TypeError,'TypeError'],[RangeError,'RangeError'],[SyntaxError,'SyntaxError'],[ReferenceError,'ReferenceError'],[URIError,'URIError'],[EvalError,'EvalError'],[AggregateError,'AggregateError']] as const)if(error instanceof constructor)return name;
  return 'Error';
}
function stackFrames(error:unknown):StackFrame[] {
  if(!types.isNativeError(error))return [];
  const descriptor=Object.getOwnPropertyDescriptor(error,'stack');
  const message=dataString(error,'message'),name=dataString(error,'name');
  if(message===undefined||name===undefined||message.length>32_768||name.length>1_024)return [];
  // Never call an arbitrary getter. Node's native lazy stack getter is the sole exception.
  const stack=descriptor&&('value' in descriptor?descriptor.value:descriptor.get===nativeStackGetter?nativeStackGetter?.call(error):undefined);
  if(typeof stack!=='string'||stack.length>32_768)return [];
  // Match the complete current header, including inherited names/newlines. Stale or custom headers are not frame evidence.
  const header=name?(message?name+': '+message:name):message;
  if(!stack.startsWith(header+'\n'))return [];
  const frames:StackFrame[]=[];
  for(const row of stack.slice(header.length+1).split('\n').slice(0,64)){
    const match=/^\s*at (?:[^\r\n]* \()?((?:file:\/\/)?\/?[A-Za-z0-9_./-]+):([1-9][0-9]{0,6}):([1-9][0-9]{0,6})\)?$/.exec(row);
    if(!match)continue;
    const path=match[1].replace(/^file:\/\//,'');
    if(path.split('/').includes('..'))continue;
    const file=diagnosticSources.find(source=>path===source||path.endsWith('/'+source));
    const line=Number(match[2]),column=Number(match[3]);
    if(file&&integer(line)&&integer(column)){frames.push({file,line,column});if(frames.length===5)break;}
  }
  return frames;
}
/** Extract only code-owned schema values. Exception messages, names, causes and function labels never cross this boundary. */
export function errorDiagnostics(error:unknown,code:DiagnosticCode='exception'):ErrorDiagnostics {
  let diagnosticCode:DiagnosticCode=codes.has(code)?code:'exception';
  try{
    if(error instanceof AttachmentPendingError)diagnosticCode='attachment_pending';
    if(error&&typeof error==='object'){
      const prior=cache.get(error);if(prior)return {...prior,diagnosticCode:prior.diagnosticCode==='attachment_pending'?'attachment_pending':diagnosticCode,stackFrames:prior.stackFrames.map(frame=>({...frame}))};
    }
    const type=exceptionType(error),frames=stackFrames(error);
    const value:ErrorDiagnostics={diagnosticCode,exceptionType:type,stackFrames:frames,fingerprint:fingerprint(type,frames),errorId:randomUUID()};
    if(error&&typeof error==='object')cache.set(error,value);
    return {...value,stackFrames:frames.map(frame=>({...frame}))};
  }catch{
    return {diagnosticCode,exceptionType:'Other',stackFrames:[],fingerprint:fingerprint('Other',[]),errorId:randomUUID()};
  }
}
/** Stored diagnostics are untrusted: rebuild a bounded value and verify its fingerprint. */
export function validatedDiagnostics(value:unknown):ErrorDiagnostics|undefined {
  try{
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const code=own(value,'diagnosticCode'),type=own(value,'exceptionType'),id=own(value,'errorId'),hash=own(value,'fingerprint'),raw=own(value,'stackFrames');
    if(!codes.has(code as DiagnosticCode)||!exceptionTypes.has(type as ExceptionType)||typeof id!=='string'||!uuid.test(id)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||!Array.isArray(raw)||raw.length>5)return;
    const frames:StackFrame[]=[];
    for(let index=0;index<raw.length;index++){
      const frame=own(raw,String(index));if(!frame||typeof frame!=='object'||Array.isArray(frame))return;
      const file=own(frame,'file'),line=own(frame,'line'),column=own(frame,'column');
      if(typeof file!=='string'||!sources.has(file)||!integer(line)||!integer(column))return;
      frames.push({file,line,column});
    }
    if(fingerprint(type as ExceptionType,frames)!==hash)return;
    return {diagnosticCode:code as DiagnosticCode,exceptionType:type as ExceptionType,stackFrames:frames,fingerprint:hash,errorId:id};
  }catch{return;}
}
export function restoreDiagnostics(error:object,value:unknown):boolean {
  try{const safe=validatedDiagnostics(value);if(safe){cache.set(error,safe);return true;}}catch{/* Diagnostic restoration cannot fail work. */}
  return false;
}
