import {createHash} from 'node:crypto';
import type {Config} from '../config';
import type {SlackApi} from '../slack-api';
import {HttpSlackApi} from '../slack-api';
import type {MetadataStore,Change} from '../cloud/metadata';
import {DurableTasks,type TaskPublisher,type TaskSpec,type TaskContext} from '../cloud/tasks';
import {CloudApplication} from '../cloud/application';
import {traceTask,bindLogicalTask} from '../cloud/telemetry';
import {CloudEvents} from '../cloud/events';
import {Installations,type Installation} from './store';

interface Delivery {appId:string;teamId:string;generation:string;logicalId:string;}
const physicalId=(route:Delivery)=>createHash('sha256').update(JSON.stringify([route.appId,route.teamId,route.generation,route.logicalId])).digest('hex');
export interface Tenant {installation:Installation;config:Config;documents:CloudApplication;events:CloudEvents;tasks:DurableTasks;identity:{botId:string;botUserId:string};}
export interface TenantOptions {
  config:Pick<Config,'signingSecret'|'appId'|'publicOrigin'|'editorOrigin'|'port'|'host'|'reactions'|'imageUploadConcurrency'|'markdownOcr'>;
  installations:Installations;registry:MetadataStore;publisher:TaskPublisher;
  store:(installation:Installation)=>MetadataStore;
  api?:(credential:string)=>SlackApi;
  application?:ConstructorParameters<typeof CloudApplication>[4];

}
/** No tenant or permission cache. Every resolution and side effect checks the current installation generation. */
export class Tenants {
  constructor(private options:TenantOptions){}
  async resolve(teamId:string,generation?:string):Promise<Tenant>{
    const o=this.options,credential=await o.installations.require(teamId,generation);
    const {botToken,...installation}=credential;
    const check=async()=>{await o.installations.require(teamId,installation.generation);};
    const raw=o.store(installation);
    const store:MetadataStore={
      async get<T>(kind:string,key:string){await check();const value=await raw.get<T>(kind,key);await check();return value;},
      async list<T>(kind:string,limit?:number){await check();const value=await raw.list<T>(kind,limit);await check();return value;},
      async atomic<T,R>(kind:string,key:string,change:(current:T|undefined)=>Change<T,R>){await check();const result=await raw.atomic<T,R>(kind,key,change);await check();return result;},
    };
    const rawApi=o.api?.(botToken)??new HttpSlackApi(botToken),api:SlackApi={async call(method,args,signal){await check();const result=await rawApi.call(method,args,signal);await check();return result;}};
    const publisher:TaskPublisher={publish:async(logicalId,notBefore)=>{
      await check();const route:Delivery={appId:installation.appId,teamId,generation:installation.generation,logicalId},id=physicalId(route);
      await o.registry.atomic<Delivery,void>('deliveries',id,current=>{
        if(current&&JSON.stringify(current)!==JSON.stringify(route))throw new Error('Delivery conflict');
        return {value:route,expiresAt:Date.now()+7*86400_000,result:undefined};
      });await o.publisher.publish(id,notBefore);
    }};
    const config:Config={...o.config,editorMode:'browser',teamId,botToken,workspaceHost:installation.workspaceHost,channelIds:new Set(),adminIds:new Set([installation.installerUserId])};
    const tasks=new DurableTasks(store,publisher),documents=new CloudApplication(config,api,store,tasks,{...o.application,noticeIdentity:{generation:installation.generation,botUserId:installation.botUserId,check}}),identity={botId:installation.botId,botUserId:installation.botUserId};
    return {installation,config,documents,tasks,identity,events:new CloudEvents(documents,identity.botUserId)};
  }
  /** Called only after worker OIDC verification. Revoked deliveries are acknowledged without side effects. */
  async execute(id:string,_unused?:(spec:TaskSpec,context:TaskContext)=>Promise<void>):Promise<void>{
    if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid task ID');
    const route=await this.options.registry.get<Delivery>('deliveries',id);
    if(!route||! /^[a-f0-9]{64}$/.test(route.logicalId)||route.appId!==this.options.config.appId||physicalId(route)!==id)throw new Error('Unknown delivery');
    bindLogicalTask(route.logicalId);
    if(!await this.options.installations.active(route.teamId,route.generation)){
      try{console.log(JSON.stringify({event:'tenant_delivery_skipped',taskId:route.logicalId,at:Date.now(),reason:'installation_mismatch'}));}catch{}
      return;
    }
    const tenant=await this.resolve(route.teamId,route.generation);
    await tenant.tasks.execute(route.logicalId,(spec,context)=>{
      if(spec.teamId!==route.teamId)throw new Error('Task tenant mismatch');
      return traceTask(spec,context,()=>spec.kind==='event'?tenant.events.execute(spec,context):tenant.documents.execute(spec,context));
    },(spec,context)=>tenant.events.terminal(spec,context));
  }
}
