import {ID,loadMarkdownOcrConfig,type Config} from '../config';
import type {OAuthConfig} from './oauth';
export function loadDistributedConfig(env:NodeJS.ProcessEnv=process.env){
  const required=(key:string,pattern:RegExp)=>{const value=env[key]?.trim();if(!value||!pattern.test(value))throw new Error('Invalid distributed configuration: '+key);return value;};
  const origin=(key:string)=>{const value=required(key,/^https:\/\//),u=new URL(value);if(u.origin!==value||u.username||u.password)throw new Error('Expected HTTPS origin: '+key);return value;};
  const role=required('CLOUD_ROLE',/^(ingress|worker)$/),appId=required('SLACK_APP_ID',ID.app),publicOrigin=origin('APP_ORIGIN'),editorOrigin=origin('EDITOR_ORIGIN');
  const port=Number(env.PORT??3000);if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('Invalid port');
  const signingSecret=required('SLACK_SIGNING_SECRET',/^[a-f0-9]{32}$/i),keyId=required('INSTALLATION_KEY_ID',/^[a-z0-9-]{1,40}$/);
  let keyData:Record<string,unknown>;try{keyData=JSON.parse(required('INSTALLATION_KEYS_JSON',/^\{/));}catch{throw new Error('Invalid installation key ring');}
  const keys=new Map<string,Buffer>();for(const [id,value] of Object.entries(keyData)){if(typeof value!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(value))throw new Error('Invalid installation key');keys.set(id,Buffer.from(value,'base64'));}
  if(!keys.has(keyId)||[...keys].some(([id,key])=>!/^[a-z0-9-]{1,40}$/.test(id)||key.length!==32))throw new Error('Invalid installation key ring');
  const config:Pick<Config,'appId'|'signingSecret'|'publicOrigin'|'editorOrigin'|'port'|'host'|'reactions'|'imageUploadConcurrency'|'markdownOcr'>={appId,signingSecret,publicOrigin,editorOrigin,port,host:'0.0.0.0',reactions:true,imageUploadConcurrency:1,markdownOcr:loadMarkdownOcrConfig(env)};
  const oauth:OAuthConfig|undefined=role==='ingress'?{appId,origin:publicOrigin,clientId:required('SLACK_CLIENT_ID',/^\d+\.\d+$/),clientSecret:required('SLACK_CLIENT_SECRET',/^[a-zA-Z0-9_-]+$/)}:undefined;
  return {config,oauth,role,keyId,keys,environment:required('CLOUD_ENVIRONMENT',/^[a-z][a-z0-9-]{0,39}$/)};
}
