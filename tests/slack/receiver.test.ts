import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyInstallation} from '../../src/server/receiver';
import {start,signed,command,FakeApi,config,bytes} from './support';
async function until(check:()=>boolean):Promise<void> {for(let i=0;i<100;i++){if(check())return;await delay(5);}assert.fail('Expected asynchronous operation');}
test('real Bolt acknowledges before a slow download and deduplicates repeated slash commands',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let downloads=0;
  const api=new FakeApi();const server=await start(api,{download:async()=>{downloads++;await gate;return bytes;}});
  try {
    const payload=new URLSearchParams(command());
    const before=performance.now();const response=await signed(server.origin,payload);
    assert.equal(response.status,200);assert.ok(performance.now()-before<2500);assert.match(await response.text(),/확인하고 있습니다/);
    assert.equal((await signed(server.origin,payload)).status,200);
    await until(()=>downloads===1);assert.equal(api.calls.filter(c=>c.method==='chat.postEphemeral').length,0);
    release();await server.preparations.idle();assert.equal(downloads,1);
    assert.match(String(api.calls.find(c=>c.method==='chat.postEphemeral')?.args.text),/아직 사용할 수 없습니다/);
    assert.equal((await fetch(server.origin+'/api/dev/documents')).status,404);
  } finally {release();await server.stop();}
});
test('help and malformed commands acknowledge without document API or response_url calls',async()=>{
  const server=await start();try{
    const help=await signed(server.origin,new URLSearchParams(command({text:'help'})));assert.equal(help.status,200);assert.match(await help.text(),/dhwp pdf/);
    const bad=await signed(server.origin,new URLSearchParams(command({text:'open https://attacker.invalid/a.hwp'})));assert.equal(bad.status,200);assert.match(await bad.text(),/워크스페이스/);
    assert.equal(server.api.calls.length,0);
  }finally{await server.stop();}
});
test('multiple attachments open a modal; selection is bound and one-use',async()=>{
  const server=await start();try{
    const shortcut={type:'message_action',callback_id:'rhwp_open_document',team:{id:'TTEST'},user:{id:'UTEST'},channel:{id:'CTEST'},trigger_id:'multi.trigger',message_ts:'123.456',message:{type:'message',ts:'123.456',files:[{id:'FTEST',name:'one.hwp'},{id:'FOTHER',name:'two.hwpx'}]}};
    assert.equal((await signed(server.origin,shortcut)).status,200);
    assert.equal((await signed(server.origin,shortcut)).status,200);
    await until(()=>server.api.calls.some(c=>c.method==='views.open'));
    assert.equal(server.api.calls.filter(c=>c.method==='views.open').length,1);
    const view=server.api.calls.find(c=>c.method==='views.open')!.args.view as {private_metadata:string};
    const submission={type:'view_submission',api_app_id:'ATEST',team:{id:'TTEST'},user:{id:'UTEST'},view:{id:'VTEST',type:'modal',callback_id:'rhwp_select_document',private_metadata:view.private_metadata,state:{values:{document:{file:{type:'static_select',selected_option:{value:'FOTHER'}}}}}}};
    const bad=await signed(server.origin,{...submission,user:{id:'UOTHER'}});assert.match(await bad.text(),/올바르지/);
    assert.equal((await signed(server.origin,submission)).status,200);await server.preparations.idle();
    assert.equal(server.api.calls.filter(c=>c.method==='files.info').length,2);
    const replay=await signed(server.origin,submission);assert.match(await replay.text(),/만료/);
    assert.equal(server.api.calls.filter(c=>c.method==='files.info').length,2);
  }finally{await server.stop();}
});
test('startup auth.test rejects a mismatched workspace before receiver start',async()=>{
  const api=new FakeApi();assert.deepEqual(await verifyInstallation(api,config),{botId:'BBOT',botUserId:'UBOT'});
  api.handler=async()=>({ok:true,team_id:'TOTHER',bot_id:'BBOT',user_id:'UBOT'});await assert.rejects(verifyInstallation(api,config));
});
