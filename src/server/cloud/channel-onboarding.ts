import {createHash} from 'node:crypto';
import {authorizeBotChannel} from '../access';
import type {Config} from '../config';
import type {SlackApi} from '../slack-api';
import type {MetadataStore} from './metadata';
import {withLease} from './lease';
interface Policy {mode:'auto'|'mention'|'off';updatedAt:number;onboarding?:boolean;welcomed?:boolean;}
/** Only signed channel/file events may call this. Existing operator policy always wins. */
export async function onboardChannel(config:Config,api:SlackApi,store:MetadataStore,channelId:string,botUserId:string):Promise<void>{
 const existing=await store.get<Policy>('channels',channelId);
 if(!existing&&config.channelIds.has(channelId)&&!await store.get('settings','initialized'))return;
 if(existing&&(!existing.onboarding||existing.welcomed||existing.mode!=='auto'))return;
 await authorizeBotChannel(api,config,{teamId:config.teamId,userId:botUserId,channelId});
 await withLease(store,'onboarding:'+channelId,async context=>{
  const policy=await store.atomic<Policy,Policy>('channels',channelId,current=>{
   const value=current??{mode:'auto',updatedAt:Date.now(),onboarding:true};return {value,result:value};
  });
  if(!policy.onboarding||policy.welcomed||policy.mode!=='auto')return;
  await context.checkpoint();
  const id=createHash('sha256').update(config.appId+':'+config.teamId+':'+channelId).digest('hex');
  await api.call('chat.postMessage',{channel:channelId,client_msg_id:`${id.slice(0,8)}-${id.slice(8,12)}-4${id.slice(13,16)}-a${id.slice(17,20)}-${id.slice(20,32)}`,
   text:'D-HWP · 이 채널의 한글 문서를 PDF·PNG·문서 Markdown으로 받아 보세요.',
   blocks:[{type:'section',text:{type:'mrkdwn',text:'*D-HWP · 동국 한글문서 도우미*\nHWP·HWPX 파일을 올리면 같은 스레드에 PDF와 첫 3쪽 PNG를 준비합니다. *PDF 열기*, *PNG 이미지 (앞 10쪽)*, *문서 Markdown (ZIP)*에서 필요한 형식을 선택하세요.\n기존 파일은 메시지 메뉴의 *동국 한글문서 변환*으로 요청하세요. 수정이 필요하면 *문서 편집 (RHWP)*에서 편집하고 같은 스레드에 새 파일로 저장할 수 있습니다.'}},
    {type:'context',elements:[{type:'plain_text',text:'동국대학교 CoP 시제품 · /dhwp help에서 사용법을 확인하세요. 채널의 자동 변환 설정은 관리자가 변경할 수 있습니다.'}]},
    {type:'actions',elements:[{type:'button',action_id:'rhwp_settings',text:{type:'plain_text',text:'채널 설정'}}]}]},context.signal);
  await store.atomic<Policy,void>('channels',channelId,current=>({value:current?.onboarding?{...current,welcomed:true}:current,result:undefined}));
 });
}
