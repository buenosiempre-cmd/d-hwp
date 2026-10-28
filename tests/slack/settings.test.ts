import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Settings} from '../../src/server/settings';
import {State} from '../../src/server/state';
import {editorServer} from './editor-support';
import {FakeApi,config,actor,signed,command} from './support';
const envelope=(id:string,event:Record<string,unknown>)=>({type:'event_callback',api_app_id:'ATEST',team_id:'TTEST',event_id:id,event});
const shared={type:'file_shared',user_id:'UTEST',channel_id:'CTEST',file_id:'FTEST'};
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('operation missing');}
test('only configured admins can change channel policy; bot membership and requesting admin membership are required',async()=>{
  const api=new FakeApi(),settings=new Settings({...config,adminIds:new Set(['UTEST'])},api);
  api.handler=async(method,args)=>method==='conversations.info'?{ok:true,channel:{...(api.response(method,args).channel as object),id:args.channel}}:api.response(method,args);
  assert.equal(settings.mode('CNEW'),'off');
  await assert.rejects(settings.set({...actor,userId:'UOTHER',channelId:'CNEW'},'auto'));assert.equal(settings.enabled.has('CNEW'),false);
  await assert.rejects(settings.set({...actor,teamId:'TOTHER',channelId:'CNEW'},'auto'));
  await settings.set({...actor,channelId:'CNEW'},'mention');assert.equal(settings.mode('CNEW'),'mention');assert.ok(settings.enabled.has('CNEW'));
  await settings.set({...actor,channelId:'CNEW'},'off');assert.equal(settings.enabled.has('CNEW'),false);
  api.handler=async(method,args)=>method==='conversations.info'?{ok:true,channel:{...(api.response(method,args).channel as object),id:args.channel,is_member:false}}:api.response(method,args);
  await assert.rejects(settings.set({...actor,channelId:'CNEW'},'auto'));assert.equal(settings.enabled.has('CNEW'),false);
});
test('a verified invitation enables a new channel, welcomes once, and survives restart without a bootstrap allowlist',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dhwp-invitation-')),path=join(dir,'state.sqlite'),api=new FakeApi();let state=new State(path,'TTEST');
  const empty={...config,channelIds:new Set<string>()};
  api.handler=async(method,args)=>method==='conversations.info'?{ok:true,channel:{...(api.response(method,args).channel as object),id:args.channel}}:api.response(method,args);
  try{
    const settings=new Settings(empty,api,state);assert.equal(settings.mode('CNEW'),'off');
    await settings.joined('CNEW','UBOT');assert.equal(settings.mode('CNEW'),'auto');assert.ok(settings.enabled.has('CNEW'));
    const welcome=api.calls.filter(c=>c.method==='chat.postMessage');assert.equal(welcome.length,1);assert.equal(welcome[0].args.channel,'CNEW');assert.match(JSON.stringify(welcome[0].args),/문서 Markdown/);
    for(const text of ['형식·쪽 선택','TXT','PNG ZIP'])assert.ok(JSON.stringify(welcome[0].args).includes(text));
    assert.equal(api.calls.some(c=>c.method==='conversations.members'),false);
    await settings.joined('CNEW','UBOT');assert.equal(api.calls.filter(c=>c.method==='chat.postMessage').length,1);
    state.close();state=new State(path,'TTEST');const restored=new Settings(empty,api,state);assert.equal(restored.mode('CNEW'),'auto');assert.ok(restored.enabled.has('CNEW'));
    await restored.joined('CNEW','UBOT');assert.equal(api.calls.filter(c=>c.method==='chat.postMessage').length,1);
  }finally{state.close();rmSync(dir,{recursive:true,force:true});}
});
test('reinvitation preserves explicit off and mention policies without welcoming or enabling again',async()=>{
  const api=new FakeApi(),settings=new Settings({...config,adminIds:new Set(['UTEST'])},api);
  for(const mode of ['off','mention'] as const){
    await settings.set(actor,mode);await settings.joined('CTEST','UBOT');assert.equal(settings.mode('CTEST'),mode);assert.equal(settings.enabled.has('CTEST'),mode==='mention');
  }
  assert.equal(api.calls.some(c=>c.method==='chat.postMessage'),false);
});
test('invitation rejects unverified bot membership, shared or wrong-workspace channels and invalid identifiers',async()=>{
  const overrides=[{is_member:false},{is_ext_shared:true},{context_team_id:'TOTHER'},{shared_team_ids:['TTEST','TOTHER']},{is_archived:true}];
  for(const override of overrides){
    const api=new FakeApi(),settings=new Settings({...config,channelIds:new Set<string>()},api);
    api.handler=async(method,args)=>method==='conversations.info'?{ok:true,channel:{...(api.response(method,args).channel as object),id:args.channel,...override}}:api.response(method,args);
    await assert.rejects(settings.joined('CNEW','UBOT'));assert.equal(settings.mode('CNEW'),'off');assert.equal(settings.enabled.has('CNEW'),false);assert.equal(api.calls.some(c=>c.method==='chat.postMessage'),false);
  }
  const api=new FakeApi(),settings=new Settings({...config,channelIds:new Set<string>()},api);
  await assert.rejects(settings.joined('not-a-channel','UBOT'));await assert.rejects(settings.joined('CNEW','not-a-user'));assert.equal(api.calls.length,0);
});
test('an administrator policy saved while invitation authorization is pending wins',async()=>{
  const api=new FakeApi(),settings=new Settings({...config,channelIds:new Set<string>(),adminIds:new Set(['UTEST'])},api);
  let release!:()=>void;let reached!:()=>void;const waiting=new Promise<void>(resolve=>{reached=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});let first=true;
  api.handler=async(method,args)=>{
    if(method==='conversations.info'){if(first){first=false;reached();await pending;}return {ok:true,channel:{...(api.response(method,args).channel as object),id:args.channel}};}
    return api.response(method,args);
  };
  const invitation=settings.joined('CNEW','UBOT');await waiting;await settings.set({...actor,channelId:'CNEW'},'off');release();await invitation;
  assert.equal(settings.mode('CNEW'),'off');assert.equal(settings.enabled.has('CNEW'),false);assert.equal(api.calls.some(c=>c.method==='chat.postMessage'),false);
});
test('stored channel policy wins over bootstrap env after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rhwp-settings-')),path=join(dir,'state.sqlite'),api=new FakeApi();let state=new State(path,'TTEST');
  try{const settings=new Settings({...config,adminIds:new Set(['UTEST'])},api,state);assert.equal(settings.mode('CTEST'),'auto');await settings.set(actor,'off');state.close();state=new State(path,'TTEST');const restored=new Settings(config,api,state);assert.equal(restored.mode('CTEST'),'off');assert.equal(restored.enabled.has('CTEST'),false);}finally{state.close();rmSync(dir,{recursive:true,force:true});}
});
test('mention mode observes file IDs without downloading; a later thread mention works without history scopes',async()=>{
  const server=await editorServer({adminIds:new Set(['UTEST'])});try{
    await server.settings.set(actor,'mention');
    await signed(server.origin,envelope('EvONLYFILE',shared),{json:true});await new Promise(r=>setTimeout(r,40));
    assert.equal(server.api.calls.some(c=>c.method==='chat.postMessage'),false);
    await signed(server.origin,envelope('EvMENTION',{type:'app_mention',user:'UTEST',channel:'CTEST',ts:'222.333',thread_ts:'123.456',text:'<@UBOT>'}),{json:true});
    await until(()=>server.api.calls.some(c=>c.method==='chat.postMessage'));assert.equal(server.api.calls.find(c=>c.method==='chat.postMessage')!.args.thread_ts,'123.456');
    assert.equal(server.api.calls.some(c=>String(c.method).includes('history')||String(c.method).includes('replies')),false);
    await server.settings.set(actor,'off');await assert.rejects(server.documents!.authorize(String((server.api.calls.find(c=>c.method==='chat.postMessage')!.args.metadata as any).entities[0].external_ref.id),actor));
  }finally{await server.stop();}
});
test('settings slash command opens a modal outside enabled channels; non-admins cannot open it',async()=>{
  const server=await editorServer({adminIds:new Set(['UTEST'])});try{
    const request=await signed(server.origin,new URLSearchParams(command({text:'settings',channel_id:'CNEW'})));assert.equal(request.status,200);
    await until(()=>server.api.calls.some(c=>c.method==='views.open'));
    const view=server.api.calls.find(c=>c.method==='views.open')!.args.view as any;assert.equal(view.callback_id,'rhwp_channel_settings');assert.equal(view.blocks[1].element.initial_conversation,'CNEW');
    assert.match(view.blocks[0].text.text,/형식·쪽 선택/);assert.match(view.blocks[0].text.text,/TXT/);assert.match(view.blocks[0].text.text,/PNG ZIP/);
    await signed(server.origin,new URLSearchParams(command({text:'settings',user_id:'UOTHER'})));assert.equal(server.api.calls.filter(c=>c.method==='views.open').length,1);
  }finally{await server.stop();}
});
test('settings modal saves only after actor and channel validation; ordinary Home hides private channel policies',async()=>{
  const server=await editorServer({adminIds:new Set(['UTEST'])});try{
    const modal={type:'view_submission',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},view:{id:'VSETTINGS',callback_id:'rhwp_channel_settings',state:{values:{channel:{value:{type:'conversations_select',selected_conversation:'CTEST'}},mode:{value:{type:'static_select',selected_option:{value:'mention'}}}}}}};
    const r=await signed(server.origin,modal);assert.equal(r.status,200);assert.equal(server.settings.mode('CTEST'),'mention');
    await signed(server.origin,{...modal,user:{id:'UOTHER'},view:{...modal.view,state:{values:{...modal.view.state.values,mode:{value:{type:'static_select',selected_option:{value:'auto'}}}}}}});assert.equal(server.settings.mode('CTEST'),'mention');
    await server.settings.home('TTEST','UOTHER');const home=server.api.calls.filter(c=>c.method==='views.publish').at(-1)!;assert.equal(JSON.stringify(home.args).includes('CPRIVATE'),false);assert.equal(JSON.stringify(home.args).includes('rhwp_settings'),false);
  }finally{await server.stop();}
});
