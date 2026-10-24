/** Only normalized diagnostics from our Slack client cross the logging boundary. */
const allowed = new Set([
  'channel_not_found','not_in_channel','is_archived','file_not_found','file_deleted','not_visible','access_denied','missing_scope','no_permission',
  'invalid_auth','not_authed','token_revoked','token_expired','account_inactive',
  'ratelimited','internal_error','fatal_error','service_unavailable','already_reacted','no_reaction',
  'unable_to_share_files','message_not_found','cant_update_message','invalid_blocks',
  'file_share_limit_reached','max_file_sharing_exceeded','posting_to_channel_denied','blocked_file_type',
  'invalid_arguments','too_many_attachments','update_failed','slack_connect_file_upload_sharing_blocked',
]);
interface ResponseSizeDiagnostics {readonly responseBytesRead?:number;readonly responseLimitBytes?:number;readonly responseContentLengthBytes?:number;}
export interface SlackDiagnostics extends ResponseSizeDiagnostics {readonly slackError?:string;readonly httpStatus?:number;}
const failures = new WeakMap<object,SlackDiagnostics>();
const responseSizes = new WeakMap<object,ResponseSizeDiagnostics>();
/** Counts from the bounded reader (or persisted diagnostics), never arbitrary error fields.
 * Content-Length is only a declaration; bytes read may be a lower bound when cancelled. */
export function attachResponseSizeDiagnostics<T extends object>(error:T,counts:ResponseSizeDiagnostics):T {
  const safe:Record<string,number>={};
  for(const key of ['responseBytesRead','responseLimitBytes','responseContentLengthBytes'] as const){
    const value=counts[key];
    if(Number.isSafeInteger(value)&&Number(value)>=0&&(key!=='responseLimitBytes'||Number(value)>0))safe[key]=Number(value);
  }
  responseSizes.set(error,Object.freeze(safe));return error;
}
/** Includes transport failures with no HTTP response; arbitrary error fields are not proof. */
export function isSlackFailure(error:unknown):boolean {return !!error&&typeof error==='object'&&failures.has(error);}
function normalized(status:unknown,code:unknown,logical:boolean):SlackDiagnostics {
  return {
    ...(Number.isInteger(status)&&Number(status)>=100&&Number(status)<=599?{httpStatus:Number(status)}:{}),
    ...(logical?{slackError:typeof code==='string'&&allowed.has(code)?code:'unknown'}:{}),
  };
}
export function attachSlackDiagnostics<T extends object>(error:T,status:unknown,code?:unknown):T {
  failures.set(error,Object.freeze(normalized(status,code,arguments.length>=3)));
  return error;
}
export function slackDiagnostics(error:unknown):SlackDiagnostics {
  if(!error||typeof error!=='object')return {};
  const value=failures.get(error);
  return value?{...normalized(value.httpStatus,value.slackError,value.slackError!==undefined),...responseSizes.get(error)}:{};
}
