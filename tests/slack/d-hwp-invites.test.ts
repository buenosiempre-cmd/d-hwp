import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createSlackReceiver} from '../../src/server/receiver';
import {EditorApi} from './editor-support';
import {actor,bytes,config,signed} from './support';

const invitation=(id:string,channel='CNEW',user='UBOT')=>({type:'event_callback',api_app_id:'ATEST',team_id:'TTEST',event_id:id,event:{type:'member_joined_channel',user,channel,channel_type:'C',team:'TTEST'}});
async function until(check:()=>boolean){for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail('Expected invitation result');}
async function fixture(){
  const api=new EditorApi();
  api.handler=async(method,args)=>{
    const result=api.response(method,args);
    if(method==='conversations.info')return {ok:true,channel:{...(result.channel as object),id:args.channel,
      ...(args.channel==='CNOTMEMBER'?{is_member:false}:{}),...(args.channel==='CEXTERNAL'?{is_ext_shared:true}:{})}};
    if(method==='files.info'&&args.file==='FTEST')return {ok:true,file:{...(result.file as object),shares:{public:{CNEW:[{team_id:'TTEST',ts:'123.456'}]}}}};
    return result;
  };
  const runtime=createSlackReceiver({...config,channelIds:new Set<string>(),adminIds:new Set(['UTEST']),publicOrigin:'https://editor.example.com'},api,{botId:'BBOT',botUserId:'UBOT'},
    {download:async()=>bytes,convert:async()=>Buffer.from('%PDF-synthetic'),fetcher:async()=>new Response('ok')});
  const server=await runtime.receiver.start({host:'127.0.0.1',port:0}),address=server.address();if(!address||typeof address==='string')throw new Error('listen');
  return {...runtime,api,origin:`http://127.0.0.1:${address.port}`,async stop(){await runtime.receiver.stop();await runtime.close();}};
}

test('signed bot invitation activates an unlisted channel and a later HWP upload converts in its original thread',async()=>{
  const f=await fixture();try{
    assert.equal(f.settings.mode('CNEW'),'off');
    assert.equal((await signed(f.origin,invitation('EvJOINNEW'),{json:true})).status,200);
    await until(()=>f.settings.mode('CNEW')==='auto');
    await signed(f.origin,invitation('EvJOINNEW'),{json:true});await signed(f.origin,invitation('EvJOINAGAIN'),{json:true});
    await until(()=>f.api.calls.some(c=>c.method==='chat.postMessage'));
    const welcome=()=>f.api.calls.filter(c=>c.method==='chat.postMessage'&&String(c.args.text).startsWith('D-HWP ·'));
    assert.equal(welcome().length,1);assert.equal(welcome()[0].args.channel,'CNEW');
    await signed(f.origin,{type:'event_callback',api_app_id:'ATEST',team_id:'TTEST',event_id:'EvNEWFILE',event:{type:'file_shared',user_id:'UTEST',channel_id:'CNEW',file_id:'FTEST'}},{json:true});
    await until(()=>f.api.calls.some(c=>c.method==='chat.postMessage'&&c.args.metadata!==undefined));await f.preparations.idle();
    const card=f.api.calls.find(c=>c.method==='chat.postMessage'&&c.args.metadata!==undefined)!;assert.equal(card.args.channel,'CNEW');assert.equal(card.args.thread_ts,'123.456');
    assert.equal(welcome().length,1);
  }finally{await f.stop();}
});

test('other-user, foreign-workspace, wrong-app and unsigned invitations never enable a channel',async()=>{
  const f=await fixture();try{
    await signed(f.origin,invitation('EvOTHERUSER','COTHERUSER','UOTHER'),{json:true});
    await signed(f.origin,{...invitation('EvOTHERTEAM','COTHERTEAM'),team_id:'TOTHER'},{json:true});
    await signed(f.origin,{...invitation('EvOTHERAPP','COTHERAPP'),api_app_id:'AOTHER'},{json:true});
    await signed(f.origin,invitation('EvBADCHANNEL','not-channel'),{json:true});
    const forged=await signed(f.origin,invitation('EvBADSIGNATURE','CBADSIGNATURE'),{json:true,signature:'v0='+'0'.repeat(64)});assert.equal(forged.status,401);
    await delay(30);assert.equal(f.settings.enabled.size,0);assert.equal(f.api.calls.some(c=>c.method==='chat.postMessage'),false);assert.equal(f.api.calls.some(c=>c.method==='conversations.info'),false);
  }finally{await f.stop();}
});

test('signed invitations require current bot membership and preserve an explicit disabled policy',async()=>{
  const f=await fixture();try{
    await signed(f.origin,invitation('EvNOTMEMBER','CNOTMEMBER'),{json:true});await signed(f.origin,invitation('EvEXTERNAL','CEXTERNAL'),{json:true});
    await until(()=>f.api.calls.filter(c=>c.method==='conversations.info').length===2);await delay(10);
    assert.equal(f.settings.mode('CNOTMEMBER'),'off');assert.equal(f.settings.mode('CEXTERNAL'),'off');assert.equal(f.api.calls.some(c=>c.method==='chat.postMessage'),false);
    await f.settings.set({...actor,channelId:'CNEW'},'off');await signed(f.origin,invitation('EvDISABLED'),{json:true});await delay(30);
    assert.equal(f.settings.mode('CNEW'),'off');assert.equal(f.settings.enabled.has('CNEW'),false);assert.equal(f.api.calls.some(c=>c.method==='chat.postMessage'),false);
  }finally{await f.stop();}
});
