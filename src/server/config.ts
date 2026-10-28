export interface Config {
  signingSecret: string; botToken: string; appId: string; teamId: string;
  imageUploadConcurrency?:1|2; statePath?:string; adminIds?:ReadonlySet<string>; reactions?:boolean;
  editorOrigin?:string; editorMode?:'embed'|'browser';
  host?: '127.0.0.1'|'0.0.0.0'; publicOrigin?: string; workspaceHost: string; channelIds: ReadonlySet<string>; port: number;
}
export const ID = {team:/^T[A-Z0-9]{2,}$/, app:/^A[A-Z0-9]{2,}$/, user:/^[UW][A-Z0-9]{2,}$/, channel:/^[CG][A-Z0-9]{2,}$/, file:/^F[A-Z0-9]{2,}$/};
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string, pattern: RegExp): string => {
    const value = env[key]?.trim();
    if (!value || !pattern.test(value)) throw new Error(`${key} 설정을 확인하세요.`);
    return value;
  };
  // A new app starts with no active channels; signed invite events enable them.
  const channels = (env.SLACK_CHANNEL_IDS??'').split(',').map(s=>s.trim()).filter(Boolean);
  if (channels.some(id=>!ID.channel.test(id))) throw new Error('SLACK_CHANNEL_IDS 설정을 확인하세요.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('PORT 설정을 확인하세요.');
  const host=env.HOST??'127.0.0.1';
  if(host!=='127.0.0.1'&&host!=='0.0.0.0')throw new Error('HOST 설정을 확인하세요.');
  const origin=new URL(required('APP_ORIGIN', /^https:\/\//));
  if(origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash || /(^|\.)slack\.com$/.test(origin.hostname)) throw new Error('APP_ORIGIN 설정을 확인하세요.');
  if((env.SLACK_ADMIN_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean).some(id=>!ID.user.test(id)))throw new Error('SLACK_ADMIN_USER_IDS 설정을 확인하세요.');
  const imageUploadConcurrency=Number(env.RHWP_IMAGE_UPLOAD_CONCURRENCY??'1');
  if(imageUploadConcurrency!==1&&imageUploadConcurrency!==2)throw new Error('RHWP_IMAGE_UPLOAD_CONCURRENCY 설정을 확인하세요.');
  let editorOrigin:string|undefined;
  if(env.EDITOR_ORIGIN){const editor=new URL(env.EDITOR_ORIGIN);if(editor.protocol!=='https:'||editor.username||editor.password||editor.pathname!=='/'||editor.search||editor.hash||editor.hostname.includes('*'))throw new Error('EDITOR_ORIGIN 설정을 확인하세요.');editorOrigin=editor.origin;}
  return {
    editorOrigin,imageUploadConcurrency,
    host,publicOrigin:origin.origin, statePath:env.STATE_DB_PATH?.trim()||'.data/state.sqlite',
    adminIds:new Set((env.SLACK_ADMIN_USER_IDS??'').split(',').map(s=>s.trim()).filter(Boolean)),
    reactions:env.SLACK_REACTIONS_ENABLED==='true',
    signingSecret:required('SLACK_SIGNING_SECRET', /^[a-f0-9]{32}$/i),
    botToken:required('SLACK_BOT_TOKEN', /^xoxb-[A-Za-z0-9-]+$/),
    appId:required('SLACK_APP_ID', ID.app), teamId:required('SLACK_TEAM_ID', ID.team),
    workspaceHost:required('SLACK_WORKSPACE_HOST', /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.slack\.com$/),
    channelIds:new Set(channels), port,
  };
}
