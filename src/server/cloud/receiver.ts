import {randomUUID,createHash} from 'node:crypto';
import {App,ExpressReceiver,LogLevel,type Logger} from '@slack/bolt';
import {ID,type Config} from '../config';
import type {Actor} from '../access';
import type {BotIdentity} from '../receiver';
import {HELP,parseCommand} from '../commands';
import {candidatesFrom,selectionView,type Candidate} from '../shortcuts';
import {Settings} from '../settings';
import {editorRoutes} from '../editor-routes';
import {denied,object,userMessage,UserError} from '../errors';
import type {CloudApplication} from './application';
import {CloudEvents} from './events';
import {onboardChannel} from './channel-onboarding';
const quietLogger:Logger={debug(){},info(){},warn(){},error(){},setLevel(){},getLevel(){return LogLevel.ERROR;},setName(){}};
const trigger=(v:unknown)=>{if(typeof v!=='string'||!v||v.length>256)denied();return v;};
const ts=(v:unknown)=>{if(typeof v!=='string'||!/^\d+\.\d+$/.test(v))denied();return v;};
export function createCloudReceiver(config:Config,documents:CloudApplication,identity:BotIdentity){
 const {api,store}=documents,settings=new Settings(config,api,undefined,store),events=new CloudEvents(documents,identity.botUserId);
 // Do not return 200 until the durable handoff (or synchronous operation) finishes.
 const receiver=new ExpressReceiver({signingSecret:config.signingSecret,endpoints:'/slack/events',signatureVerification:true,processBeforeResponse:true,bodyLimit:'256kb',logger:quietLogger,
  processEventErrorHandler:async({response})=>{if(!response.headersSent)response.writeHead(503).end('Please retry');return true;}});
 const app=new App({receiver,logger:quietLogger,ignoreSelf:false,authorize:async({teamId})=>{if(teamId!==config.teamId)denied();return {teamId:config.teamId,botToken:config.botToken,...identity};}});
 app.error(async error=>{throw error;});
 const who=async(team:unknown,user:unknown,channel:unknown):Promise<Actor>=>{
  if(team!==config.teamId||typeof user!=='string'||!ID.user.test(user)||typeof channel!=='string'||!ID.channel.test(channel))denied();
  await onboardChannel(config,api,store,channel,identity.botUserId);
  const actor={teamId:team,userId:user,channelId:channel};await documents.accessConfig(actor);return actor;
 };
 const notice=async(actor:Actor,error:unknown)=>{await api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text:userMessage(error)});};
 app.use(async args=>{const b=object(args.body);if(b.is_enterprise_install===true||(b.api_app_id!==undefined&&b.api_app_id!==config.appId)||(b.type==='event_callback'&&b.api_app_id!==config.appId)){if('ack' in args&&typeof args.ack==='function')await args.ack();return;}await args.next();});
 app.command(/^\/(?:d|r)hwp$/,async({command,ack})=>{
  try{
   if(command.api_app_id!==config.appId)denied();
   if(command.text.trim()==='settings'){await settings.open(command.team_id,command.user_id,trigger(command.trigger_id),command.channel_id);await ack();return;}
   const actor=await who(command.team_id,command.user_id,command.channel_id),parsed=parseCommand(command.text,config.workspaceHost);
   if(parsed.kind==='help'){await ack({response_type:'ephemeral',text:HELP});return;}
   await documents.submit(actor,parsed.fileId,'command:'+trigger(command.trigger_id),parsed.mode);await ack({response_type:'ephemeral',text:'문서 접근 권한을 확인하고 있습니다.'});
  }catch(error){await ack({response_type:'ephemeral',text:userMessage(error)});}
 });
 app.shortcut('rhwp_open_document',async({shortcut,ack})=>{
  let actor:Actor|undefined;try{
   if(shortcut.type!=='message_action'){await ack();return;}
   actor=await who(shortcut.team?.id,shortcut.user.id,shortcut.channel.id);actor.threadTs=ts(shortcut.message.thread_ts??shortcut.message_ts);actor.reactionTs=ts(shortcut.message_ts);
   const files=candidatesFrom(shortcut.message.files),request=trigger(shortcut.trigger_id);
   if(files.length===1)await documents.submit(actor,files[0].id,'shortcut:'+request);
   else {const id=randomUUID();await store.atomic('selections',id,()=>({value:{actor,candidates:files},expiresAt:Date.now()+300_000,result:undefined}));await api.call('views.open',{trigger_id:request,view:selectionView(id,files)});}
  }catch(error){if(actor)await notice(actor,error);}await ack();
 });
 app.view('rhwp_select_document',async({body,view,ack})=>{
  try{const id=view.private_metadata,selected=view.state.values.document?.file?.selected_option?.value;
   const item=await store.get<{actor:Actor;candidates:Candidate[]}>('selections',id);
   if(!item||item.actor.teamId!==body.team?.id||item.actor.userId!==body.user.id||!item.candidates.some(c=>c.id===selected))denied();
   await documents.submit(item.actor,selected!,'selection:'+id);await ack();
  }catch(error){await ack({response_action:'errors',errors:{document:userMessage(error)}});}
 });
 app.event('member_joined_channel',async({body,event})=>{
  if(event.user!==identity.botUserId||body.team_id!==config.teamId||typeof body.event_id!=='string'||!ID.channel.test(event.channel))return;
  await events.enqueue(body.event_id,{kind:'channel_joined',actor:{teamId:config.teamId,userId:identity.botUserId,channelId:event.channel}});
 });
 app.event('file_shared',async({body,event})=>{
  const e=object(event);if(e.user_id===identity.botUserId||typeof e.file_id!=='string'||!ID.file.test(e.file_id)||typeof body.event_id!=='string')return;
  let actor:Actor;try{if(body.team_id!==config.teamId||typeof e.user_id!=='string'||!ID.user.test(e.user_id)||typeof e.channel_id!=='string'||!ID.channel.test(e.channel_id))return;actor={teamId:config.teamId,userId:e.user_id,channelId:e.channel_id};}catch(error){if(error instanceof UserError&&error.code==='access_denied')return;throw error;}
  await events.enqueue(body.event_id,{kind:'file_shared',actor,fileId:e.file_id});
 });
 app.event('app_mention',async({body,event})=>{
  const e=object(event);if(e.user===identity.botUserId||e.bot_id||typeof body.event_id!=='string')return;
  let actor:Actor;try{if(body.team_id!==config.teamId||typeof e.user!=='string'||!ID.user.test(e.user)||typeof e.channel!=='string'||!ID.channel.test(e.channel))return;actor={teamId:config.teamId,userId:e.user,channelId:e.channel};actor.threadTs=ts(e.thread_ts??e.ts);actor.reactionTs=ts(e.ts);}catch(error){if(error instanceof UserError&&error.code==='access_denied')return;throw error;}
  const files=Array.isArray(e.files)?candidatesFrom(e.files).map(f=>f.id):undefined;
  await events.enqueue(body.event_id,{kind:'app_mention',actor,files});
 });
 app.event('app_home_opened',async({body,event})=>{if(event.tab==='home'&&typeof body.event_id==='string')await events.enqueue(body.event_id,{kind:'home',user:event.user});});
 app.action('rhwp_settings',async({body,ack})=>{const b=object(body);try{await settings.open(String(object(b.team).id),String(object(b.user).id),trigger(b.trigger_id),typeof object(b.channel).id==='string'?String(object(b.channel).id):undefined);}catch{/* No mutation on forged actions. */}await ack();});
 app.view('rhwp_channel_settings',async({body,view,ack})=>{
  try{const channel=view.state.values.channel?.value?.selected_conversation,mode=view.state.values.mode?.value?.selected_option?.value;
   if(typeof channel!=='string'||typeof mode!=='string')denied();await settings.set({teamId:body.team?.id??'',userId:body.user.id,channelId:channel},mode);
   await events.enqueue('settings-home:'+view.id+':'+view.hash,{kind:'home',user:body.user.id});await ack();
  }catch(error){await ack({response_action:'errors',errors:{channel:userMessage(error)}});}
 });
 for(const actionId of ['rhwp_more_pages','rhwp_retry_preview','rhwp_export_markdown'])app.action(actionId,async({body,action,ack})=>{
  const b=object(body),a=object(action),c=object(b.container);
  const actor=await who(object(b.team).id,object(b.user).id,c.channel_id);
  if(c.type!=='message'||typeof a.value!=='string'||!a.value||a.value.length>128||(b.channel&&object(b.channel).id!==actor.channelId))denied();
  const messageTs=ts(c.message_ts),actionTs=ts(a.action_ts);
  const key=createHash('sha256').update(JSON.stringify([actionId,actor.teamId,actor.userId,actor.channelId,a.value,messageTs,actionTs])).digest('hex');
  // Return only after durable handoff. Slack lookups, card locks and notifications run on the worker.
  await events.enqueue('action:'+key,{kind:actionId==='rhwp_export_markdown'?'export_markdown':actionId==='rhwp_retry_preview'?'retry_preview':'more_pages',actor,cardId:a.value,messageTs});
  await ack();
 });
 for(const actionId of ['rhwp_browser_edit','rhwp_view_pdf'])app.action(actionId,async({ack})=>{await ack();});
 app.event('entity_details_requested',async({body,event})=>{
  let actor:Actor|undefined;try{const e=object(event);actor=await who(body.team_id,e.user,e.channel);const ref=object(e.external_ref);
   if(ref.type!=='document'||typeof ref.id!=='string')denied();if(!await documents.matchesUrl(ref.id,e.entity_url))return;
   if(typeof body.event_id!=='string')return;
   const first=await store.atomic<boolean,boolean>('replays','entity:'+body.event_id,current=>({value:true,expiresAt:Date.now()+300_000,result:!current}));
   if(first)await documents.present(ref.id,actor,trigger(e.trigger_id));
  }catch(error){if(actor)await notice(actor,error);}
 });
 for(const type of ['file_deleted','file_unshared'] as const)app.event(type,async({body,event})=>{
  const e=object(event);if(body.team_id!==config.teamId||typeof body.event_id!=='string'||typeof e.file_id!=='string'||!ID.file.test(e.file_id))return;
  await events.enqueue(body.event_id,{kind:type,fileId:e.file_id});
 });
 receiver.router.use(editorRoutes(config.publicOrigin!,documents,documents,config.editorOrigin));
 receiver.router.get('/healthz',(_req,res)=>res.json({ok:true}));
 return {receiver,app,events,settings};
}
