import {FakeApi,config,bytes,actor,file} from './support';
import type {Method} from '../../src/server/slack-api';
import {createSlackReceiver} from '../../src/server/receiver';
export class EditorApi extends FakeApi {
  sequence=0;messageSequence=0;messages=new Map<string,Record<string,unknown>>();files=new Map<string,Record<string,unknown>>();
  override response(method:Method,args:Record<string,unknown>):Record<string,unknown>{
    if(method==='chat.postMessage'||method==='chat.update'){
      const ts=method==='chat.postMessage'?`123.${456+this.messageSequence++}`:String(args.ts);
      const message:Record<string,unknown>={...this.messages.get(ts),...args};this.messages.set(ts,message);
      const visit=(v:unknown)=>{
        if(!v||typeof v!=='object')return;
        const object=v as Record<string,unknown>;
        const reference=object.slack_file as {id?:string}|undefined;
        const f=reference?.id?this.files.get(reference.id):undefined;
        if(f){const shares=(f.shares??{}) as Record<string,any>;shares.public??={};const records=shares.public[String(args.channel)]??=[];
          if(!records.some((r:any)=>r.ts===ts))records.push({team_id:'TTEST',ts,thread_ts:message.thread_ts});
          f.shares=shares;
        }
        for(const value of Object.values(object))visit(value);
      };
      visit(args.metadata);
      // Actual Slack only attaches these IDs on chat.update, not chat.postMessage.
      if(method==='chat.update'&&Array.isArray(args.file_ids)){
        for(const id of args.file_ids)visit({slack_file:{id}});
        message.files=[...new Set([...(message.files as {id:string}[]??[]).map(f=>f.id),...args.file_ids])].map(id=>({id}));
      }
      return {ok:true,ts,message};
    }
    if(method==='files.getUploadURLExternal'){const id=`FUPLOAD${++this.sequence}`;this.files.set(id,{id,name:args.filename,size:args.length});return {ok:true,file_id:id,upload_url:`https://files.slack.com/upload/v1/${id}`};}
    if(method==='files.completeUploadExternal'){
      const id=(args.files as {id:string}[])[0].id;
      const upload=this.files.get(id)!;
      Object.assign(upload,{...structuredClone(file),...upload,shares:args.channel_id?{public:{[String(args.channel_id)]:[{team_id:'TTEST',ts:'456.789',thread_ts:args.thread_ts}]}}:{},permalink:`https://rhwp-test.slack.com/files/UBOT/${id}/document`});
      return {ok:true,files:[{id}]};
    }
    if(method==='files.info'&&this.files.has(String(args.file)))return {ok:true,file:this.files.get(String(args.file))};
    return super.response(method,args);
  }
}
export async function editorServer(options:{markdownOcr?:import('../../src/server/config').Config['markdownOcr'];sessionStore?:import('../../src/server/cloud/metadata').MetadataStore;api?:EditorApi;convert?:NonNullable<Parameters<typeof createSlackReceiver>[3]>['convert'];convertImages?:NonNullable<Parameters<typeof createSlackReceiver>[3]>['convertImages'];markdown?:NonNullable<Parameters<typeof createSlackReceiver>[3]>['markdown'];text?:NonNullable<Parameters<typeof createSlackReceiver>[3]>['text'];zip?:NonNullable<Parameters<typeof createSlackReceiver>[3]>['zip'];fetcher?:typeof fetch;now?:()=>number;origin?:string;statePath?:string;adminIds?:ReadonlySet<string>;reactions?:boolean}={}){
  const api=options.api??new EditorApi();const publicOrigin=options.origin??'https://editor.example.com';
  const runtime=createSlackReceiver({...config,publicOrigin,statePath:options.statePath,markdownOcr:options.markdownOcr,adminIds:options.adminIds,reactions:options.reactions},api,{botId:'BBOT',botUserId:'UBOT'},
    {sessionStore:options.sessionStore,download:async()=>bytes,markdown:options.markdown,text:options.text,zip:options.zip,convertImages:options.convertImages,convert:options.convert??(async()=>Buffer.from('%PDF-synthetic')),fetcher:options.fetcher??(async()=>new Response('ok')),now:options.now});
  const server=await runtime.receiver.start({host:'127.0.0.1',port:0});const address=server.address();if(!address||typeof address==='string')throw new Error('listen');
  const origin=`http://127.0.0.1:${address.port}`;
  return {...runtime,api,origin,publicOrigin,async prepare(){const job=runtime.preparations.submit(actor,'FTEST','open','test');await runtime.preparations.idle();return job.id;},
    async session(id:string){const ticket=runtime.documents!.sessions.issue(id,actor);const bearer=await runtime.documents!.sessions.exchange(ticket);return {bearer,session:await runtime.documents!.sessions.require(bearer)};},
    async stop(){await runtime.receiver.stop();await runtime.close();}};
}
