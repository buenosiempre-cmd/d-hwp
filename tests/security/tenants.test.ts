import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {Installations,type InstallationInput} from '../../src/server/installations/store';
import {Tenants} from '../../src/server/installations/tenants';
import {UserError} from '../../src/server/errors';
import {attachSlackDiagnostics} from '../../src/server/slack-diagnostics';
import {distributedReceiver} from '../../src/server/installations/receiver';
import {traceDelivery,bindDelivery,deliveryFailure} from '../../src/server/cloud/telemetry';
import {config,signed,command,FakeApi} from '../slack/support';
const input:InstallationInput={appId:'ATEST',teamId:'TONE',installerUserId:'UTEST',botId:'BBOT',botUserId:'UBOT',workspaceHost:'one.slack.com',scopes:['commands'],botToken:'xoxb-synthetic-one'};
async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rhwp-tenants-')),states:State[]=[];
  const create=(file:string)=>{const state=new State(join(dir,file+'.sqlite'),'TREGISTRY');states.push(state);return new SqliteMetadata(state);};
  const registry=create('registry'),vault=new Installations(registry,'ATEST','k1',new Map([['k1',Buffer.alloc(32,19)]])),stores=new Map<string,SqliteMetadata>(),apis=new Map<string,FakeApi>(),published:string[]=[];
  const tenants=new Tenants({config:{...config,publicOrigin:'https://beta.example.com'},installations:vault,registry,publisher:{async publish(id){published.push(id);}},store:install=>{
    const id=install.teamId+'-'+install.generation;let s=stores.get(id);if(!s){s=create(id);stores.set(id,s);}return s;
  },api:token=>{let api=apis.get(token);if(!api){api=new FakeApi();apis.set(token,api);}return api;}});
  const a=await vault.activate(input),b=await vault.activate({...input,teamId:'TTWO',workspaceHost:'two.slack.com',botToken:'xoxb-synthetic-two'});
  return {registry,vault,tenants,apis,published,a,b,stores,close(){for(const s of states)s.close();rmSync(dir,{recursive:true,force:true});}};
}
test('same record keys stay isolated and selected tenant uses only its own token',async()=>{
  const f=await fixture();try{
    const a=await f.tenants.resolve('TONE'),b=await f.tenants.resolve('TTWO');
    await a.documents.store.atomic('settings','same',()=>({value:'one',result:undefined}));await b.documents.store.atomic('settings','same',()=>({value:'two',result:undefined}));
    assert.equal(await a.documents.store.get('settings','same'),'one');assert.equal(await b.documents.store.get('settings','same'),'two');
    await a.documents.api.call('auth.test',{});await b.documents.api.call('auth.test',{});
    assert.equal(f.apis.get('xoxb-synthetic-one')!.calls.length,1);assert.equal(f.apis.get('xoxb-synthetic-two')!.calls.length,1);
    await assert.rejects(a.documents.accessConfig({teamId:'TTWO',userId:'UTEST',channelId:'CTEST'}));
    assert.equal(await a.documents.mode('CTEST'),'off'); // Installer must enable channels explicitly.
  }finally{f.close();}
});
test('reinstall and revoke invalidate retained clients, stores and generation-routed queued work',async()=>{
  const f=await fixture();try{
    const a=await f.tenants.resolve('TONE');
    await a.tasks.enqueue('same',{teamId:'TONE',cardId:'event-one',kind:'event'});const old=f.published.at(-1)!;
    assert.equal((await f.registry.get<any>('deliveries',old)).generation,f.a.generation);
    await f.vault.activate({...input,botToken:'xoxb-new-one'});
    await assert.rejects(a.documents.api.call('auth.test',{}));await assert.rejects(a.documents.store.get('cards','same'));
    const next=await f.tenants.resolve('TONE');await next.tasks.enqueue('same',{teamId:'TONE',cardId:'event-one',kind:'event'});
    assert.notEqual(f.published.at(-1),old);await f.tenants.execute(old); // Acknowledge old generation, no API calls.
    assert.equal(f.apis.get('xoxb-synthetic-one')!.calls.length,0);
    await f.vault.revoke('TONE',next.installation.generation);await assert.rejects(f.tenants.resolve('TONE'));
    await f.tenants.execute(f.published.at(-1)!);assert.equal(f.apis.get('xoxb-new-one')!.calls.length,0);
  }finally{f.close();}
});
test('delivery registry cannot redirect a physical id to another workspace',async()=>{
  const f=await fixture();try{
    const a=await f.tenants.resolve('TONE');await a.tasks.enqueue('same',{teamId:'TONE',cardId:'event',kind:'event'});const id=f.published.at(-1)!;
    await f.registry.atomic<any,void>('deliveries',id,current=>({value:{...current,teamId:'TTWO',generation:f.b.generation},result:undefined}));
    await assert.rejects(f.tenants.execute(id),/Unknown delivery/);
  }finally{f.close();}
});
test('validated delivery routing keeps logical identity when tenant resolution fails before task tracing',async()=>{
 const f=await fixture(),rows:Record<string,unknown>[]=[];try{
  const a=await f.tenants.resolve('TONE');const logical=await a.tasks.enqueue('route-failure',{teamId:'TONE',cardId:'private-card',kind:'event'});
  const physical=f.published.at(-1)!;f.tenants.resolve=async()=>{throw new Error('private tenant failure');};
  await traceDelivery(undefined,async()=>{
   bindDelivery(physical);try{await f.tenants.execute(physical);}catch(error){deliveryFailure(error);}
  },()=>503,r=>rows.push(r));
  assert.equal(rows.at(-1)?.deliveryId,physical);assert.equal(rows.at(-1)?.taskId,logical);
  assert.equal(rows.at(-1)?.attempt,undefined);assert.equal(rows.at(-1)?.statusCode,503);
  assert.equal(rows.some(r=>r.event==='task_finished'),false);
  assert.equal(JSON.stringify(rows).includes('private tenant failure'),false);
 }finally{f.close();}
});
test('Slack signature is verified before installation lookup; cross-app and conflicting team envelopes are ignored',async()=>{
  const f=await fixture();let lookups=0;const resolve=f.tenants.resolve.bind(f.tenants);f.tenants.resolve=async(...args)=>{lookups++;return resolve(...args);};
  const runtime=distributedReceiver({appId:'ATEST',signingSecret:config.signingSecret,tenants:f.tenants}),server=await runtime.receiver.start({host:'127.0.0.1',port:0}),address=server.address();assert.ok(address&&typeof address!=='string');const origin=`http://127.0.0.1:${address.port}`;
  try{
    assert.equal((await signed(origin,new URLSearchParams(command({team_id:'TONE',text:'help'})),{tamper:true})).status,401);assert.equal(lookups,0);
    assert.equal((await signed(origin,new URLSearchParams(command({team_id:'TONE',api_app_id:'AOTHER',text:'help'})))).status,200);assert.equal(lookups,0);
    assert.equal((await signed(origin,{type:'event_callback',api_app_id:'ATEST',team_id:'TONE',team:{id:'TTWO'},event:{type:'app_home_opened'}},{json:true})).status,200);assert.equal(lookups,0);
    assert.equal((await signed(origin,new URLSearchParams(command({team_id:'TONE',text:'help'})))).status,200);assert.equal(lookups,1);
    assert.equal((await signed(origin,new URLSearchParams(command({team_id:'TTWO',text:'help'})))).status,200);assert.equal(lookups,2);
  }finally{await runtime.receiver.stop();f.close();}
});

test('active tenant deliveries enter the redacted task trace',async()=>{
 const f=await fixture(),rows:Record<string,unknown>[]=[];
 const log=mock.method(console,'log',(line:string)=>{rows.push(JSON.parse(line));});
 try{
  const a=await f.tenants.resolve('TONE');await a.tasks.enqueue('trace',{teamId:'TONE',cardId:'missing-private-card',kind:'prepare'});
  await assert.rejects(f.tenants.execute(f.published.at(-1)!));
  assert.ok(rows.some(r=>r.event==='task_started'));assert.ok(rows.some(r=>r.event==='task_finished'&&r.ok===false));
  const text=JSON.stringify(rows);for(const secret of ['TONE','xoxb-','missing-private-card'])assert.equal(text.includes(secret),false);
 }finally{log.mock.restore();f.close();}
});

test('tenant final event callbacks preserve workspace access and run once after durable failure',async()=>{
 const f=await fixture(),rows:Record<string,unknown>[]=[];const log=mock.method(console,'log',(line:string)=>rows.push(JSON.parse(line)));
 try{
  const a=await f.tenants.resolve('TONE');await a.documents.store.atomic('channels','CTEST',()=>({value:{mode:'mention'},result:undefined}));
  const api=f.apis.get('xoxb-synthetic-one')!;
  api.handler=async(method,args)=>{
   if(method==='files.info')throw attachSlackDiagnostics(new UserError('slack_rejected','private error'),200,'missing_scope');
   const response=api.response(method,args);if(method==='conversations.info')return {...response,channel:{...(response.channel as object),context_team_id:'TONE',shared_team_ids:['TONE']}};return response;
  };
  await a.events.enqueue('EFAIL',{kind:'app_mention',actor:{teamId:'TONE',userId:'UTEST',channelId:'CTEST'},files:['FTEST']});const id=f.published.at(-1)!;
  await f.tenants.execute(id);await f.tenants.execute(id);
  assert.equal(api.calls.filter(c=>c.method==='files.info').length,1);assert.equal(api.calls.filter(c=>c.method==='chat.postEphemeral').length,1);
  assert.equal(f.apis.get('xoxb-synthetic-two')?.calls.length??0,0);
  assert.equal(rows.some(r=>r.event==='task_terminal_failed'&&r.slackError==='missing_scope'),true);
  for(const value of ['TONE','UTEST','FTEST','xoxb-','private error'])assert.equal(JSON.stringify(rows).includes(value),false);
 }finally{log.mock.restore();f.close();}
});
test('revocation during terminal notice permission checks prevents sending and preserves failed receipt',async()=>{
 const f=await fixture(),log=mock.method(console,'log',()=>{});try{
  const a=await f.tenants.resolve('TONE');await a.documents.store.atomic('channels','CTEST',()=>({value:{mode:'mention'},result:undefined}));
  const api=f.apis.get('xoxb-synthetic-one')!;let failed=false;
  api.handler=async(method,args)=>{
   if(method==='files.info'){failed=true;throw attachSlackDiagnostics(new UserError('slack_rejected','private error'),200,'missing_scope');}
   const response=api.response(method,args);
   if(failed&&method==='conversations.members')await f.vault.revoke('TONE',f.a.generation);
   if(method==='conversations.info')return {...response,channel:{...(response.channel as object),context_team_id:'TONE',shared_team_ids:['TONE']}};return response;
  };
  await a.events.enqueue('EREVOKE',{kind:'app_mention',actor:{teamId:'TONE',userId:'UTEST',channelId:'CTEST'},files:['FTEST']});const id=f.published.at(-1)!,route=await f.registry.get<any>('deliveries',id);
  await f.tenants.execute(id);assert.equal(api.calls.filter(c=>c.method==='chat.postEphemeral').length,0);
  assert.equal((await f.stores.get('TONE-'+f.a.generation)!.get<any>('tasks',route.logicalId)).state,'failed');
  await f.tenants.execute(id);assert.equal(api.calls.filter(c=>c.method==='files.info').length,1);
 }finally{log.mock.restore();f.close();}
});
