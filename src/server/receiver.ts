import {setTimeout as delay} from 'node:timers/promises';
import {App, ExpressReceiver, LogLevel, type Logger} from '@slack/bolt';
import type {Config} from './config';
import {ID} from './config';
import {assertActor, authorizeFile, type Actor} from './access';
import type {SlackApi} from './slack-api';
import {Preparations, type Job} from './jobs';
import {sharedChannels} from './file-sharing';
import {HELP, parseCommand} from './commands';
import {Replays} from './replays';
import {Selections, candidatesFrom, selectionView} from './shortcuts';
import {ExportSelections,exportView,parseExportView,type ExportSelection} from './export-options';
import type {ExportRequest} from './document-exports';
import {Documents} from './documents';
import {Saves} from './saves';
import {State} from './state';
import {Settings} from './settings';
import {Reactions} from './reactions';
import {editorRoutes} from './editor-routes';
import {denied, userMessage, object, UserError} from './errors';
// Bolt logs may contain request bodies or SDK response metadata. Do not forward their arguments.
const quietLogger:Logger={debug(){},info(){},warn(){},error(){},setLevel(){},getLevel(){return LogLevel.ERROR;},setName(){}};
export interface BotIdentity {botId:string; botUserId:string;}
export async function verifyInstallation(api:SlackApi,config:Config):Promise<BotIdentity> {
  const auth=await api.call('auth.test',{});
  if (auth.team_id!==config.teamId || auth.is_enterprise_install===true || typeof auth.bot_id!=='string' || !/^B[A-Z0-9]+$/.test(auth.bot_id) || typeof auth.user_id!=='string' || !ID.user.test(auth.user_id)) denied();
  return {botId:auth.bot_id,botUserId:auth.user_id};
}
function trigger(value:unknown):string {
  if (typeof value!=='string' || value.length<1 || value.length>256) throw new UserError('bad_trigger','요청 식별자가 올바르지 않습니다. 다시 요청하세요.');
  return value;
}
export function createSlackReceiver(config:Config,api:SlackApi,botIdentity:BotIdentity,options:{sessionStore?:import('./cloud/metadata').MetadataStore;download?:typeof import('./download').downloadFile;now?:()=>number;fetcher?:typeof fetch;convert?:ConstructorParameters<typeof import('./pdf-jobs').PdfJobs>[0];convertImages?:ConstructorParameters<typeof import('./pdf-jobs').PdfJobs>[1];markdown?:typeof import('../conversion/convert.mjs').convertMarkdownPackage;text?:typeof import('../conversion/convert.mjs').convertText;zip?:typeof import('../conversion/convert.mjs').convertPageZip}={}) {
  const state=config.statePath?new State(config.statePath,config.teamId):undefined;
  const settings=new Settings(config,api,state);config={...config,channelIds:settings.enabled};
  const reactions=new Reactions(api,config.reactions===true,state);
  const receiver=new ExpressReceiver({signingSecret:config.signingSecret,endpoints:'/slack/events',signatureVerification:true,
    processBeforeResponse:false,logger:quietLogger,bodyLimit:'256kb'});
  const app=new App({receiver,logger:quietLogger,ignoreSelf:false,authorize:async({teamId})=>{
    if(teamId!==config.teamId)denied();
    return {teamId:config.teamId,botToken:config.botToken,...botIdentity};
  }});
  const selections=new Selections(options.now);
  const exportSelections=new ExportSelections(options.now);
  const replays=new Replays(options.now,state);
  const notice=async(actor:Actor,text:string)=>{await api.call('chat.postEphemeral',{channel:actor.channelId,user:actor.userId,text});};
  const notify=async(job:Readonly<Job>)=>{
    if(job.state==='ready'&&documents){if(documents.has(job.id))return;try{await documents.publish(job);}catch(error){await reactions.finish(job.id,false);await notice(job.actor,userMessage(error));}return;}
    const text=job.state==='ready'
      ? `문서 접근 확인을 마쳤습니다. ${job.mode==='pdf'?'PDF 미리보기':'Slack 편집기'} 연결은 아직 사용할 수 없습니다.`
      : job.error??'문서 준비에 실패했습니다.';
    await reactions.finish(job.id,false);await notice(job.actor,text);
  };
  const preparations=new Preparations(config,api,{download:options.download,now:options.now,notify,state,registered:job=>reactions.register(job.id,job.actor),started:async job=>{void reactions.start(job.id);}});
  const documents=config.publicOrigin?new Documents(config,api,preparations,{...options,state,complete:card=>reactions.finish(card.id,card.pdf==='ready'&&card.imageState==='ready')}):undefined;
  const saves=documents?new Saves(documents,options.now,state):undefined;
  if(documents&&saves)receiver.router.use(editorRoutes(config.publicOrigin!,documents,saves,config.editorOrigin));
  const actor=(team:unknown,user:unknown,channel:unknown):Actor=>{
    if(typeof team!=='string'||typeof user!=='string'||typeof channel!=='string')denied();
    const result={teamId:team,userId:user,channelId:channel};assertActor(config,result);return result;
  };
  app.use(async args=>{
    const data=args.body as unknown as Record<string,unknown>;
    if(data.is_enterprise_install===true || (data.api_app_id!==undefined && data.api_app_id!==config.appId) ||
        (data.type==='event_callback' && data.api_app_id!==config.appId)) {
      if ('ack' in args && typeof args.ack==='function') await args.ack();
      return;
    }
    await args.next();
  });
  app.command(/^\/(?:d|r)hwp$/,async({command,ack})=>{
    try {
      if(command.api_app_id!==config.appId)denied();
      if(command.text.trim()==='settings'){
        if(!settings.isAdmin(command.team_id,command.user_id)){await ack({response_type:'ephemeral',text:'채널 설정은 rhwp 앱 관리자가 변경할 수 있습니다.'});return;}
        await ack();await settings.open(command.team_id,command.user_id,trigger(command.trigger_id),command.channel_id);return;
      }
      if(command.team_id===config.teamId)await settings.joined(command.channel_id,botIdentity.botUserId);
      const who=actor(command.team_id,command.user_id,command.channel_id);
      const parsed=parseCommand(command.text,config.workspaceHost);
      if(parsed.kind==='help'){await ack({response_type:'ephemeral',text:HELP});return;}
      const result=preparations.submit(who,parsed.fileId,parsed.mode,`command:${trigger(command.trigger_id)}`);
      await ack({response_type:'ephemeral',text:result.duplicate?'이미 접수한 요청입니다.':'문서 접근 권한을 확인하고 있습니다.'});
    } catch(error){await ack({response_type:'ephemeral',text:userMessage(error)});}
  });
  app.shortcut('rhwp_open_document',async({shortcut,ack})=>{
    await ack(); let who:Actor|undefined;
    try {
      if(shortcut.type!=='message_action')return;
      if(shortcut.team?.id===config.teamId)await settings.joined(shortcut.channel.id,botIdentity.botUserId);
      who=actor(shortcut.team?.id,shortcut.user.id,shortcut.channel.id);
      const threadTs=shortcut.message.thread_ts??shortcut.message_ts;
      if(typeof threadTs!=='string'||!/^\d+\.\d+$/.test(threadTs))denied();
      who.threadTs=threadTs;who.reactionTs=shortcut.message_ts;
      const files=candidatesFrom(shortcut.message.files);
      const requestId=trigger(shortcut.trigger_id);
      const replayKey=JSON.stringify([who.teamId,who.userId,who.channelId,requestId]);
      if(!replays.claim(replayKey))return;
      if(files.length===1){preparations.submit(who,files[0].id,'open',`shortcut:${requestId}`);return;}
      const id=selections.create(who,files);
      try {await api.call('views.open',{trigger_id:requestId,view:selectionView(id,files)});}
      catch(error){selections.delete(id);throw error;}
    } catch(error){if(who)await notice(who,userMessage(error)).catch(()=>{});}
  });
  app.view('rhwp_select_document',async({body,view,ack})=>{
    try {
      const chosen=view.state.values.document?.file?.selected_option?.value;
      const who=selections.get(view.private_metadata,body.team?.id??'',body.user.id,chosen??'');
      preparations.submit(who,chosen!,'open',`selection:${view.private_metadata}`);
      selections.delete(view.private_metadata);
      await ack();
    } catch(error){await ack({response_action:'errors',errors:{document:userMessage(error)}});}
  });
  // Keep file/share identifiers only; app_mention never fetches channel message history.
  const observed=new Map<string,{team:string;channel:string;parent:string;file:string;expires:number}>(state?.all('observed'));
  const threadRequests=new Map<string,string>(state?.all('threads'));
  const clock=options.now??Date.now;
  const remember=(who:Actor,fileId:string)=>{
    for(const [key,item] of observed)if(item.expires<=clock()){observed.delete(key);state?.delete('observed',key);}
    const key=JSON.stringify([who.teamId,who.channelId,who.threadTs,fileId]);
    if(observed.size>=1000&&!observed.has(key)){const oldest=observed.keys().next().value!;observed.delete(oldest);state?.delete('observed',oldest);}
    observed.set(key,{team:who.teamId,channel:who.channelId,parent:who.threadTs!,file:fileId,expires:clock()+24*60*60_000});state?.put('observed',key,observed.get(key));
  };
  const requestThread=(who:Actor,fileId:string)=>{
    const key=JSON.stringify([who.teamId,who.channelId,who.threadTs,fileId]);
    const previous=threadRequests.get(key),job=previous?preparations.get(previous):undefined;
    if(previous&&documents?.has(previous)||job&&['queued','downloading','ready'].includes(job.state))return;
    if(threadRequests.size>=1000){const oldest=threadRequests.keys().next().value!;threadRequests.delete(oldest);state?.delete('threads',oldest);}
    // Automatic file events and mentions from different members share one request.
    const result=preparations.submit(who,fileId,'open','thread:'+key+':'+clock());
    threadRequests.set(key,result.id);state?.put('threads',key,result.id);remember(who,fileId);
  };
  app.event('member_joined_channel',async({body,event})=>{
    if(body.team_id!==config.teamId||event.user!==botIdentity.botUserId||!ID.channel.test(event.channel)||typeof body.event_id!=='string')return;
    const key='joined:'+config.teamId+':'+body.event_id;if(!replays.claim(key))return;
    try{await settings.joined(event.channel,botIdentity.botUserId);}catch{replays.release(key);}
  });
  app.event('file_shared',async({body,event})=>{
    if(!documents)return;const e=object(event);
    if(e.user_id===botIdentity.botUserId||typeof e.file_id!=='string'||!ID.file.test(e.file_id)||typeof body.event_id!=='string'||!body.event_id)return;
    let who:Actor;try{if(body.team_id===config.teamId&&typeof e.channel_id==='string'&&typeof e.user_id==='string'&&ID.user.test(e.user_id))await settings.joined(e.channel_id,botIdentity.botUserId);who=actor(body.team_id,e.user_id,e.channel_id);}catch{return;}
    if(!replays.claim('file-shared:'+who.teamId+':'+body.event_id))return;
    try{
      const file=object((await api.call('files.info',{file:e.file_id})).file);
      if(file.user===botIdentity.botUserId||file.id!==e.file_id||typeof file.name!=='string'||!/\.(hwp|hwpx)$/i.test(file.name))return;
      const shares=object(file.shares);
      const candidates=[object(shares.public??{})[who.channelId],object(shares.private??{})[who.channelId]].filter(Array.isArray).flat().map(object);
      const valid=candidates.filter(s=>s.share_user_id!==botIdentity.botUserId&&s.team_id===who.teamId&&typeof s.ts==='string'&&/^\d+\.\d+$/.test(s.ts));
      // File events omit a message ts. Never guess which of several shares owns the new reply.
      if(valid.length!==1){if(settings.mode(who.channelId)==='auto')await notice(who,'미리보기를 달 메시지를 특정하지 못했습니다. 해당 메시지 메뉴에서 한글 문서 열기를 선택해 주세요.');return;}
      const share=valid[0],parent=share.thread_ts??share.ts;
      if(typeof parent!=='string'||!/^\d+\.\d+$/.test(parent))return;
      who.threadTs=parent;who.reactionTs=String(share.ts);remember(who,e.file_id);
      if(settings.mode(who.channelId)!=='auto')return;
      requestThread(who,e.file_id);
    }catch{/* No automatic public fallback or raw Slack error output. */}
  });
  app.event('app_mention',async({body,event})=>{
    if(!documents)return;const e=object(event);let who:Actor|undefined;
    try{
      if(e.user===botIdentity.botUserId||e.bot_id||typeof body.event_id!=='string'||!body.event_id)return;
      if(body.team_id===config.teamId&&typeof e.channel==='string'&&typeof e.user==='string'&&ID.user.test(e.user))await settings.joined(e.channel,botIdentity.botUserId);
      who=actor(body.team_id,e.user,e.channel);
      const parent=e.thread_ts??e.ts;if(typeof parent!=='string'||!/^\d+\.\d+$/.test(parent))denied();
      who.threadTs=parent;who.reactionTs=String(e.ts);
      if(!replays.claim('mention:'+who.teamId+':'+body.event_id))return;
      let files:string[]=[];
      if(Array.isArray(e.files))files=candidatesFrom(e.files).map(f=>f.id);
      else {
        // file_shared and app_mention may arrive in either order.
        for(let attempt=0;attempt<5;attempt++){
          files=[...observed.values()].filter(item=>item.expires>clock()&&item.team===who!.teamId&&item.channel===who!.channelId&&item.parent===parent).map(item=>item.file);
          if(files.length)break;
          if(attempt<4)await delay(250);
        }
      }
      if(!files.length){await notice(who,'HWP/HWPX 파일과 함께 D-HWP를 멘션해 주세요. 이전 파일은 해당 메시지 메뉴의 동국 한글문서 변환으로 요청할 수 있습니다.');return;}
      if(files.length>10)throw new UserError('too_many_files','한 번에 문서 10개까지 요청할 수 있습니다. 메시지 메뉴에서 문서를 선택해 주세요.');
      for(const fileId of new Set(files)){
        await authorizeFile(api,config,who,fileId);
        requestThread(who,fileId);
      }
    }catch(error){if(who)await notice(who,userMessage(error)).catch(()=>{});}
  });
  app.event('app_home_opened',async({body,event})=>{
    if(event.tab!=='home')return;await settings.home(body.team_id??'',event.user).catch(()=>{});
  });
  app.action('rhwp_settings',async({body,ack})=>{
    await ack();const b=object(body);try{await settings.open(String(object(b.team).id),String(object(b.user).id),trigger(b.trigger_id));}catch{/* A forged non-admin action cannot change settings. */}
  });
  app.view('rhwp_channel_settings',async({body,view,ack})=>{
    try{
      const channel=view.state.values.channel?.value?.selected_conversation;
      const mode=view.state.values.mode?.value?.selected_option?.value;
      if(typeof channel!=='string'||typeof mode!=='string')denied();
      await settings.set({teamId:body.team?.id??'',userId:body.user.id,channelId:channel},mode);
      await ack();void settings.home(body.team?.id??'',body.user.id).catch(()=>{});
    }catch(error){await ack({response_action:'errors',errors:{channel:userMessage(error)}});}
  });
  app.action('rhwp_export_options',async({body,action,ack})=>{
    await ack();if(!documents)return;let who:Actor|undefined;
    try{
      const b=object(body),a=object(action),container=object(b.container);
      who=actor(object(b.team).id,object(b.user).id,container.channel_id);
      if(container.type!=='message'||typeof container.message_ts!=='string'||typeof a.value!=='string')denied();
      if(b.channel&&object(b.channel).id!==who.channelId)denied();
      const requestId=trigger(b.trigger_id),card=await documents.authorize(a.value,who);
      if(card.messageTs!==container.message_ts)denied();
      if(!replays.claim(`export-options:${who.teamId}:${who.userId}:${requestId}`))return;
      const id=exportSelections.create(who,card.id,container.message_ts);
      try{await api.call('views.open',{trigger_id:requestId,view:exportView(id,card.pageCount)});}
      catch(error){exportSelections.delete(id);throw error;}
    }catch(error){if(who)await notice(who,userMessage(error)).catch(()=>{});}
  });
  app.view('rhwp_export_document',async({body,view,ack})=>{
    let selection:ExportSelection,request:ExportRequest;
    try{
      if(!documents)throw new UserError('export_unavailable','문서 변환 연결을 사용할 수 없습니다.');
      selection=exportSelections.get(view.private_metadata,body.team?.id??'',body.user.id);
      request=parseExportView(view.state.values);
    }catch(error){
      const field=error instanceof UserError&&error.code==='invalid_export_selection'?'format':view.state?.values?.format?.value?.selected_option?.value==='zip'?'pages':'format';
      await ack({response_action:'errors',errors:{[field]:userMessage(error)}});return;
    }
    exportSelections.delete(view.private_metadata);await ack();
    try{
      const result=await documents!.exportFile(selection.cardId,selection.actor,selection.messageTs,request);
      await documents!.authorize(selection.cardId,selection.actor);
      const label=request.format==='txt'?'원문 TXT':request.format==='markdown'?'문서 Markdown ZIP':'선택 쪽 PNG ZIP';
      await notice(selection.actor,result.url?`${label}을 같은 스레드에 첨부했습니다. <${result.url}|${label} 열기>`:`${label}을 같은 스레드에 첨부했습니다.`);
    }catch(error){await notice(selection.actor,userMessage(error)).catch(()=>{});}
  });
  for(const actionId of ['rhwp_more_pages','rhwp_export_markdown'])app.action(actionId,async({body,action,ack})=>{
    await ack();if(!documents)return;let who:Actor|undefined;
    try{
      const b=object(body),a=object(action),container=object(b.container);
      who=actor(object(b.team).id,object(b.user).id,container.channel_id);
      if(container.type!=='message'||typeof container.message_ts!=='string'||typeof a.value!=='string')denied();
      if(b.channel&&object(b.channel).id!==who.channelId)denied();
      if(actionId==='rhwp_export_markdown'){
        const result=await documents.exportMarkdown(a.value,who,container.message_ts);
        await notice(who,result.url?`문서 Markdown ZIP을 같은 스레드에 첨부했습니다. ZIP의 document.md와 report.json을 함께 확인하세요. <${result.url}|Markdown ZIP 받기>`:'문서 Markdown ZIP을 같은 스레드에 첨부했습니다. ZIP의 document.md와 report.json을 함께 확인하세요.');
      }else await documents.morePages(a.value,who,container.message_ts);
    }catch(error){if(who)await notice(who,userMessage(error)).catch(()=>{});}
  });
  for(const actionId of ['rhwp_view_pdf','rhwp_browser_edit'])app.action(actionId,async({ack})=>{await ack();});
  app.event('entity_details_requested',async({body,event})=>{
    if(!documents)return;let who:Actor|undefined;
    try {
      const e=object(event);who=actor(body.team_id,e.user,e.channel);
      const ref=object(e.external_ref);if(ref.type!=='document'||typeof ref.id!=='string')denied();
      // Obsolete Work Objects may refresh alongside the active document. Never report these as permission failures.
      if(!documents.matchesUrl(ref.id,e.entity_url))return;
      if(typeof body.event_id!=='string'||!replays.claim(`entity:${body.team_id}:${body.event_id}`))return;
      await documents.present(ref.id,who,trigger(e.trigger_id));
    }catch(error){if(who)await notice(who,userMessage(error)).catch(()=>{});}
  });
  for(const actionId of ['rhwp_open','rhwp_pdf'])app.action(actionId,async({body,action,ack})=>{
    await ack();if(!documents)return;let who:Actor|undefined;
    try {
      const b=object(body),a=object(action),container=object(b.container);
      who=actor(object(b.team).id,object(b.user).id,container.channel_id);
      if(typeof a.value!=='string'||object(container.external_ref).id!==a.value||container.entity_url!==documents.url(a.value))denied();
      if(b.channel&&object(b.channel).id!==who.channelId)denied();
      if(actionId==='rhwp_open'){
        const t=trigger(b.trigger_id);if(!replays.claim(`open:${who.teamId}:${t}`))return;
        await documents.authorize(a.value,who);
        await notice(who,'문서 제목을 누르면 Slack 안에서 편집기가 열립니다.');
      }else await documents.authorize(a.value,who);
    }catch(error){if(who)await notice(who,userMessage(error)).catch(()=>{});}
  });
  for(const type of ['file_deleted','file_unshared'] as const) app.event(type,async({body,event})=>{
    if(body.team_id!==config.teamId || typeof body.event_id!=='string' || !body.event_id || !replays.claim(`event:${body.team_id}:${body.event_id}`))return;
    const e=object(event);const fileId=e.file_id;
    if(typeof fileId!=='string'||!ID.file.test(fileId))return;
    try {
      const keep=type==='file_unshared'?await sharedChannels(api,config.teamId,fileId):undefined;
      for(const [key,item] of observed)if(item.team===body.team_id&&item.file===fileId&&!keep?.has(item.channel))observed.delete(key);
      for(const [key,value] of state?.all<{file:string;channel:string}>('observed')??[])if(value.file===fileId&&!keep?.has(value.channel))state?.delete('observed',key);
      preparations.invalidate(body.team_id,fileId,keep);await documents?.invalidate(body.team_id,fileId,keep);
    }catch(error){replays.release(`event:${body.team_id}:${body.event_id}`);throw error;}
  });
  app.error(async()=>{}); // No raw payload/token logging; callers receive safe errors above.
  receiver.router.get('/healthz',(_req,res)=>{res.json({ok:true});});
  const sweep=setInterval(()=>{preparations.sweep();selections.sweep();exportSelections.sweep();replays.sweep();documents?.sweep();saves?.sweep();reactions.sweep();},60_000);sweep.unref();
  const reactionRecovery=reactions.recover(new Set([...preparations.activeIds(),...(documents?.pendingIds()??[])]));
  const ready=documents?.recover().catch(()=>{}).then(()=>preparations.start())??Promise.resolve().then(()=>preparations.start());
  return {ready,state,settings,reactions,receiver,app,preparations,selections,exportSelections,documents,saves,async close(){clearInterval(sweep);await ready;await preparations.close();await saves?.close();await documents?.close();await reactionRecovery;await reactions.idle();state?.close();}};
}
