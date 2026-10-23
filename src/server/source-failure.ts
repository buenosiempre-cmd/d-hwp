import {isSlackFailure,slackDiagnostics} from './slack-diagnostics';
const missing=new WeakSet<object>();
/** Called only around the source files.info call, never an output or channel query. */
export function markSourceUnavailable(error:unknown):void {
 if(error&&typeof error==='object'&&isSlackFailure(error)){
  const d=slackDiagnostics(error);if(d.httpStatus===200&&d.slackError==='file_not_found')missing.add(error);
 }
}
export function isSourceUnavailable(error:unknown):boolean{return !!error&&typeof error==='object'&&missing.has(error);}
