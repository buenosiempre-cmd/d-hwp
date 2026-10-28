import test from 'node:test';
import assert from 'node:assert/strict';
import {start,signed,command,actor} from '../slack/support';
test('actual Bolt rejects tampered, stale and unsigned bodies before API access',async()=>{
  const server=await start();try{
    for(const options of [{tamper:true},{timestamp:Math.floor(Date.now()/1000)-3600},{signature:'v0=wrong'}]){
      const response=await signed(server.origin,new URLSearchParams(command()),options);assert.ok(response.status>=400);
    }
    const unsigned=await fetch(server.origin+'/slack/events',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(command())});assert.ok(unsigned.status>=400);
    assert.equal(server.api.calls.length,0);
  }finally{await server.stop();}
});
test('foreign team/application make no API calls; an unjoined channel cannot start preparation',async()=>{
  const server=await start();try{
    const changes:Record<string,string>[]=[{team_id:'TOTHER'},{api_app_id:'AOTHER'}];
    for(const change of changes){
      const before=performance.now();
      await signed(server.origin,new URLSearchParams(command(change)));
      assert.ok(performance.now()-before<2500);
    }
    assert.equal(server.api.calls.length,0);
    await signed(server.origin,new URLSearchParams(command({channel_id:'COTHER'})));
    assert.deepEqual(server.api.calls.map(c=>c.method),['conversations.info']);
    assert.equal(server.settings.enabled.has('COTHER'),false);
  }finally{await server.stop();}
});
test('signed file-unshared event invalidates retained bytes and replay cannot invalidate a later request',async()=>{
  const server=await start();try{
    const first=server.preparations.submit(actor,'FTEST','open','original');await server.preparations.idle();assert.equal(server.preparations.get(first.id)?.state,'ready');
    const event={type:'event_callback',team_id:'TTEST',api_app_id:'ATEST',event_id:'EvTEST',event:{type:'file_unshared',file_id:'FTEST'},authorizations:[{team_id:'TTEST',user_id:'UBOT',is_bot:true}]};
    server.api.handler=async(method,args)=>{const result=server.api.response(method,args);return method==='files.info'?{...result,file:{...(result.file as object),shares:{}}}:result;};
    assert.equal((await signed(server.origin,event,{json:true})).status,200);
    // Event handlers run before this response has finished dispatching through Bolt.
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(server.preparations.get(first.id)?.bytes,undefined);
    server.api.handler=undefined;
    const newer=server.preparations.submit(actor,'FTEST','open','after-reshare');await server.preparations.idle();
    await signed(server.origin,event,{json:true});await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(server.preparations.get(newer.id)?.state,'ready');
  }finally{await server.stop();}
});
