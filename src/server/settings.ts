import {ID,type Config} from './config';
import {authorizeBotChannel,authorizeChannel,type Actor} from './access';
import type {SlackApi} from './slack-api';
import type {State} from './state';
import {UserError,denied} from './errors';
export type ChannelMode='auto'|'mention'|'off';
interface Policy {mode:ChannelMode;updatedBy?:string;updatedAt:number;}
const labels:Record<ChannelMode,string>={auto:'자동 변환',mention:'멘션할 때만 변환',off:'이 채널에서 사용 안 함'};
const option=(value:ChannelMode)=>({text:{type:'plain_text',text:labels[value]},value});
export class Settings {
  readonly enabled=new Set<string>();
  private policies=new Map<string,Policy>();
  constructor(private config:Config,private api:SlackApi,private state?:State,private remote?:import('./cloud/metadata').MetadataStore){
    if(state?.get('settings','initialized')){
      for(const [id,policy] of state.all<Policy>('channels'))this.policies.set(id,policy);
    }else{
      for(const id of config.channelIds){const value:Policy={mode:'auto',updatedAt:Date.now()};this.policies.set(id,value);state?.put('channels',id,value);}
      state?.put('settings','initialized',true);
    }
    for(const [id,p] of this.policies)if(p.mode!=='off')this.enabled.add(id);
  }
  async refresh():Promise<void>{
    if(!this.remote)return;
    if(!await this.remote.get('settings','initialized')){
      for(const id of this.config.channelIds)await this.remote.atomic<Policy,void>('channels',id,current=>({value:current??{mode:'auto',updatedAt:Date.now()},result:undefined}));
      await this.remote.atomic('settings','initialized',()=>({value:true,result:undefined}));
    }
    this.policies=new Map(await this.remote.list<Policy>('channels'));this.enabled.clear();
    for(const [id,p] of this.policies)if(p.mode!=='off')this.enabled.add(id);
  }
  mode(channel:string):ChannelMode{return this.policies.get(channel)?.mode??'off';}
  /** Only verified bot-join events may call this; an existing operator policy wins. */
  async joined(channelId:string,botUserId:string):Promise<void>{
    if(!ID.channel.test(channelId)||!ID.user.test(botUserId))denied();
    await this.refresh();if(this.policies.has(channelId))return;
    await authorizeBotChannel(this.api,this.config,{teamId:this.config.teamId,userId:botUserId,channelId},AbortSignal.timeout(2000));
    // An administrator may have set a policy while channel authorization was pending.
    if(this.policies.has(channelId))return;
    const value:Policy={mode:'auto',updatedAt:Date.now()};
    if(this.remote){
      const created=await this.remote.atomic<Policy,boolean>('channels',channelId,current=>({value:current??value,result:!current}));
      await this.refresh();if(!created)return;
    }else{
      this.state?.put('channels',channelId,value);this.policies.set(channelId,value);this.enabled.add(channelId);
    }
    await this.api.call('chat.postMessage',{channel:channelId,
      text:'D-HWP · 이 채널의 한글 문서를 PDF·PNG·TXT·Markdown·선택 쪽 ZIP으로 받아 보세요.',
      blocks:[{type:'section',text:{type:'mrkdwn',text:'*D-HWP · 동국 한글문서 도우미*\n이 채널에서 자동 변환이 켜졌습니다. HWP·HWPX 파일을 올리면 같은 스레드에 PDF와 첫 3쪽 PNG를 준비합니다. *PDF 열기*, *PNG 이미지 (앞 10쪽)*, *원문 Markdown 만들기*에서 필요한 형식을 선택하세요. *형식·쪽 선택*에서는 원문 TXT와 선택 쪽 PNG ZIP을 받을 수 있습니다.\n기존 파일은 메시지 메뉴의 *동국 한글문서 변환*으로 요청하세요.'}},
        {type:'context',elements:[{type:'plain_text',text:'동국대학교 CoP 시제품 · /dhwp help에서 사용법을 확인하세요. 자동 변환 설정은 앱 관리자가 변경할 수 있습니다.'}]}]});
  }
  isAdmin(team:string,user:string):boolean{return team===this.config.teamId&&ID.user.test(user)&&this.config.adminIds?.has(user)===true;}
  private admin(team:string,user:string):void{if(!this.isAdmin(team,user))throw new UserError('settings_admin','채널 설정은 D-HWP 앱 관리자가 변경할 수 있습니다.');}
  async set(actor:Actor,mode:string):Promise<void>{
    this.admin(actor.teamId,actor.userId);await this.refresh();if(!['auto','mention','off'].includes(mode))denied();
    await authorizeChannel(this.api,this.config,actor,AbortSignal.timeout(2000),false);
    const value:Policy={mode:mode as ChannelMode,updatedBy:actor.userId,updatedAt:Date.now()};
    if(this.remote)await this.remote.atomic('channels',actor.channelId,()=>({value,result:undefined}));
    this.state?.put('channels',actor.channelId,value);this.policies.set(actor.channelId,value);
    if(mode==='off')this.enabled.delete(actor.channelId);else this.enabled.add(actor.channelId);
  }
  async open(team:string,user:string,triggerId:string,channel?:string):Promise<void>{
    this.admin(team,user);await this.refresh();
    const current=channel&&ID.channel.test(channel)?channel:undefined;
    await this.api.call('views.open',{trigger_id:triggerId,view:{type:'modal',callback_id:'rhwp_channel_settings',title:{type:'plain_text',text:'D-HWP 채널 설정'},submit:{type:'plain_text',text:'저장'},close:{type:'plain_text',text:'취소'},blocks:[
      {type:'section',text:{type:'mrkdwn',text:'자동 변환은 새로 올린 한글 파일의 PDF와 첫 3쪽 PNG를 만듭니다. 원문 Markdown은 스레드의 버튼을 눌러 요청합니다. 형식·쪽 선택에서는 원문 TXT와 선택 쪽 PNG ZIP을 받습니다. 필요한 문서만 처리하려면 멘션할 때만 변환을 선택하세요. 설정은 채널의 모든 사용자에게 적용됩니다.'}},
      {type:'input',block_id:'channel',label:{type:'plain_text',text:'채널'},element:{type:'conversations_select',action_id:'value',placeholder:{type:'plain_text',text:'채널 선택'},filter:{include:['public','private'],exclude_external_shared_channels:true},...(current?{initial_conversation:current}:{})}},
      {type:'input',block_id:'mode',label:{type:'plain_text',text:'동작 방식'},element:{type:'static_select',action_id:'value',options:(['auto','mention','off'] as const).map(option),initial_option:option(current&&this.mode(current)!=='off'?this.mode(current):'mention')}},
      {type:'context',elements:[{type:'plain_text',text:'멘션 모드에서도 /dhwp 명령과 메시지 메뉴로 직접 요청할 수 있습니다. 자동 감지는 활성화된 채널의 한글 파일만 처리합니다.'}]},
    ]}});
  }
  async home(team:string,user:string):Promise<void>{
    if(team!==this.config.teamId||!ID.user.test(user))denied();
    await this.refresh();const admin=this.isAdmin(team,user);
    const blocks:Record<string,unknown>[]=[
      {type:'header',text:{type:'plain_text',text:'D-HWP · 동국 한글문서 도우미'}},
      {type:'section',text:{type:'mrkdwn',text:'*한글 문서를 Slack에서 PDF·PNG·TXT·Markdown·선택 쪽 ZIP으로 받으세요.*\n\n*1. 사용할 채널에 D-HWP를 초대하세요.*\n처음 초대한 채널은 자동 변환이 켜집니다. 이전에 설정한 채널은 기존 설정을 유지합니다.\n\n*2. HWP·HWPX 파일을 올리세요.*\n같은 스레드에 PDF와 첫 3쪽 PNG를 준비합니다.\n\n*3. 스레드에서 필요한 형식을 선택하세요.*\n*PDF 열기*로 전체 문서를 보고, *PNG 이미지 (앞 10쪽)* 또는 *원문 Markdown 만들기*로 필요한 파일을 받으세요. *형식·쪽 선택*에서는 원문 TXT와 원하는 쪽의 PNG ZIP을 받을 수 있습니다. ZIP은 1~200쪽 중 최대 10쪽을 선택합니다.'}},
      {type:'section',text:{type:'mrkdwn',text:'*기존 파일이나 필요한 문서만 변환하려면*\n파일 메시지 메뉴의 *동국 한글문서 변환*을 선택하거나 `/dhwp pdf`, `/dhwp png`, `/dhwp md` 뒤에 Slack 파일 링크를 붙이세요.\n*멘션할 때만 변환* 채널에서는 파일이 있는 스레드에서 D-HWP를 멘션하세요.\n\n수정이 필요하면 *문서 편집 (RHWP)*을 선택하고, 편집본을 같은 스레드에 새 파일로 저장할 수 있습니다.'}},
      {type:'context',elements:[{type:'plain_text',text:'동국대학교 CoP 시제품 · RHWP 기반. TXT·Markdown은 원문 텍스트 중심입니다. 이미지 속 글자(OCR)·수식·표 배치 복원은 지원하지 않습니다.'}]},
      {type:'context',elements:[{type:'plain_text',text:'⏳ 변환 중 · ✅ PDF와 이미지 준비 완료 · ⚠️ 일부 또는 전체 변환 실패'}]},
    ];
    if(admin){
      blocks.push({type:'divider'},{type:'actions',elements:[{type:'button',action_id:'rhwp_settings',text:{type:'plain_text',text:'채널 설정'},style:'primary'}]});
      const visible:string[]=[];
      for(const [id,p] of this.policies){
        if(visible.length>=30)break;
        try{await authorizeChannel(this.api,this.config,{teamId:team,userId:user,channelId:id},undefined,false);visible.push(`<#${id}> · ${labels[p.mode]}`);}catch{/* Private channel membership is checked before listing its name or ID. */}
      }
      if(visible.length)blocks.push({type:'section',text:{type:'mrkdwn',text:'*채널 설정 현황*\n'+visible.join('\n')}});
    }else blocks.push({type:'context',elements:[{type:'plain_text',text:'원하는 채널에 D-HWP를 초대해 사용하세요. 기존 채널의 동작 방식 변경은 앱 관리자에게 요청해 주세요. /dhwp help에서 사용법을 확인할 수 있습니다.'}]});
    await this.api.call('views.publish',{user_id:user,view:{type:'home',blocks}});
  }
}
