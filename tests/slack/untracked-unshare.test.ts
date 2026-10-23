import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import type {MetadataStore} from '../../src/server/cloud/metadata';
import {DurableTasks,type Work} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents} from '../../src/server/cloud/events';
import {UserError} from '../../src/server/errors';
import {attachSlackDiagnostics} from '../../src/server/slack-diagnostics';
import type {Card} from '../../src/server/documents';
import {actor,config,file,FakeApi} from './support';

function fixture(wrap?:(store:MetadataStore)=>MetadataStore){
 const dir=mkdtempSync(join(tmpdir(),'rhwp-untracked-unshare-')),state=new State(join(dir,'state.sqlite'),'TTEST');
 const raw=new SqliteMetadata(state),store=wrap?wrap(raw):raw,api=new FakeApi();
 const published:string[]=[],terminal:Record<string,unknown>[]=[],notices:Record<string,unknown>[]=[];
 const tasks=new DurableTasks(store,{async publish(id){published.push(id);}},Date.now,60_000,r=>terminal.push(r));
 const app=new CloudApplication(config,api,store,tasks),events=new CloudEvents(app,'UBOT',r=>notices.push(r));
 return {raw,store,api,tasks,app,events,published,terminal,notices,
  async put<T>(kind:string,key:string,value:T){await raw.atomic(kind,key,()=>({value,result:undefined}));},
  async enqueue(fileId='FUNTRACKED',eventId=randomUUID(),kind:'file_unshared'|'file_deleted'='file_unshared'){
   await events.enqueue(eventId,{kind,fileId});return published.at(-1)!;
  },
  run(id:string){return tasks.execute(id,(s,c)=>events.execute(s,c),(s,c)=>events.terminal(s,c));},
  async snapshot(){const result:Record<string,unknown>={};for(const kind of ['cards','observed','tickets','sessions','revocations'])result[kind]=await raw.list(kind);return result;},
  close(){state.close();rmSync(dir,{recursive:true,force:true});}};
}
function card(fileId='FOTHER',rootFileId=fileId,channelId='CTEST'):Card{
 return {id:randomUUID(),actor:{...actor,channelId},fileId,rootFileId,name:file.name,size:file.size,createdAt:Date.now(),revision:0,pdf:'ready',imageState:'ready'};
}
const infoCalls=(f:ReturnType<typeof fixture>)=>f.api.calls.filter(c=>c.method==='files.info').length;
const visibilityError=()=>attachSlackDiagnostics(new UserError('slack_rejected','synthetic visibility rejection'),200,'file_not_found');

for(const scenario of ['empty','unrelated','derived_output_only'] as const){
 test(`untracked unshare: ${scenario} finishes durable work without Slack lookup, mutations or notices`,async()=>{
  const f=fixture();try{
   let session:string|undefined;
   if(scenario!=='empty'){
    const c={...card(),...(scenario==='derived_output_only'?{pdfFileId:'FUNTRACKED',images:[{page:1,fileId:'FUNTRACKED',shared:true}]}:{})};
    await f.put('cards',c.id,c);await f.put('observed','unrelated',{file:'FOTHER',channel:'CTEST'});
    session=await f.app.sessions.exchange(f.app.sessions.issue(c.id,c.actor));
   }
   const before=await f.snapshot();f.api.calls.length=0;
   // An erroneous lookup would fail three attempts, reproducing the former bug.
   f.api.handler=async(method,args)=>{if(method==='files.info')throw visibilityError();return f.api.response(method,args);};
   const eventId=randomUUID(),id=await f.enqueue('FUNTRACKED',eventId);
   await f.run(id);await f.run(id);await f.enqueue('FUNTRACKED',eventId);await f.run(id);
   const work=(await f.raw.get<Work>('tasks',id))!;
   assert.equal(work.state,'done');assert.equal(work.generation,1);assert.equal(work.failureCode,undefined);
   assert.equal(infoCalls(f),0);assert.equal(f.api.calls.length,0);assert.deepEqual(await f.snapshot(),before);
   assert.equal((await f.raw.list('tasks')).length,1);assert.equal(f.terminal.length,0);assert.equal(f.notices.length,0);
   if(session){f.api.handler=undefined;await f.app.sessions.require(session);}
  }finally{f.close();}
 });
}
test('observed-only unshare still queries sharing and removes only the revoked channel',async()=>{
 const f=fixture();try{
  await f.put('observed','revoked',{file:'FUNTRACKED',channel:'CPRIVATE'});
  await f.put('observed','kept',{file:'FUNTRACKED',channel:'CTEST'});
  await f.put('observed','other',{file:'FOTHER',channel:'CPRIVATE'});
  const id=await f.enqueue();await f.run(id);
  assert.equal(infoCalls(f),1);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'done');
  assert.equal(await f.raw.get('observed','revoked'),undefined);
  assert.deepEqual(await f.raw.get('observed','kept'),{file:'FUNTRACKED',channel:'CTEST'});
  assert.deepEqual(await f.raw.get('observed','other'),{file:'FOTHER',channel:'CPRIVATE'});
  assert.deepEqual(await f.raw.list('cards'),[]);assert.deepEqual(await f.raw.list('revocations'),[]);
 }finally{f.close();}
});
for(const relation of ['source','root'] as const){
 test(`${relation} card alone requires sharing lookup and revokes its session epoch`,async()=>{
  const f=fixture();try{
   const c=card(relation==='source'?'FUNTRACKED':'FREVISION','FUNTRACKED','CPRIVATE');
   await f.put('cards',c.id,c);const ticket=await f.app.sessions.issue(c.id,c.actor);
   const id=await f.enqueue();await f.run(id);
   assert.equal(infoCalls(f),1);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'done');
   assert.equal((await f.raw.get<Card&{removed:boolean}>('cards',c.id))!.removed,true);
   assert.equal(await f.raw.get('revocations',c.id),1);await assert.rejects(f.app.sessions.exchange(ticket));
  }finally{f.close();}
 });
}
for(const kind of ['cards','observed'] as const){
 test(`failure reading ${kind} propagates and cannot turn into untracked success`,async()=>{
  const f=fixture(raw=>({get:raw.get.bind(raw),atomic:raw.atomic.bind(raw),list:async<T>(name:string,limit?:number)=>{
   if(name===kind)throw new Error('synthetic metadata read failure');return raw.list<T>(name,limit);
  }}));try{
   const c=card('FUNTRACKED');await f.put('cards',c.id,c);const before=await f.snapshot(),id=await f.enqueue();
   await assert.rejects(f.run(id),/synthetic metadata read failure/);assert.equal(infoCalls(f),0);
   assert.equal((await f.raw.get<Work>('tasks',id))!.state,'queued');assert.deepEqual(await f.snapshot(),before);
   await assert.rejects(f.run(id));await f.run(id);
   assert.equal((await f.raw.get<Work>('tasks',id))!.state,'failed');assert.equal(f.terminal.length,1);
  }finally{f.close();}
 });
}
test('metadata query limit remains an error for an untracked file',async()=>{
 const f=fixture();try{
  for(let i=0;i<1001;i++)await f.put('observed',String(i),{file:'FOTHER',channel:'CTEST'});
  const id=await f.enqueue();await assert.rejects(f.run(id),/Metadata query limit exceeded/);
  assert.equal((await f.raw.get<Work>('tasks',id))!.state,'queued');assert.equal(infoCalls(f),0);
  assert.equal((await f.raw.list('observed',10000)).length,1001);
 }finally{f.close();}
});
test('related-record file_not_found defers cleanup without changing metadata or granting access',async()=>{
 const f=fixture();try{
  await f.put('observed','target',{file:'FUNTRACKED',channel:'CTEST'});const c=card('FREVISION','FUNTRACKED');
  await f.put('cards',c.id,c);const before=await f.snapshot();
  f.api.handler=async(method,args)=>{if(method==='files.info')throw visibilityError();return f.api.response(method,args);};
  const id=await f.enqueue();await f.run(id);await f.run(id);
  assert.equal(infoCalls(f),1);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'done');
  assert.deepEqual(await f.snapshot(),before);assert.equal(f.terminal.length,0);assert.equal(f.notices.length,0);
  await assert.rejects(f.app.authorize(c.id,c.actor),{code:'slack_rejected'});
 }finally{f.close();}
});
for(const scenario of ['outage','incomplete'] as const){
 test(`related-record ${scenario} retains retries and final failure without revocation`,async()=>{
  const f=fixture();try{
   await f.put('observed','target',{file:'FUNTRACKED',channel:'CTEST'});const c=card('FREVISION','FUNTRACKED');
   await f.put('cards',c.id,c);const before=await f.snapshot();
   f.api.handler=async(method,args)=>{
    if(method==='files.info'){
     if(scenario==='outage')throw new Error('synthetic Slack outage');
     return {ok:true,file:{...file,id:args.file,has_more_shares:true}};
    }
    return f.api.response(method,args);
   };
   const id=await f.enqueue();await assert.rejects(f.run(id));await assert.rejects(f.run(id));await f.run(id);
   assert.equal(infoCalls(f),3);assert.equal((await f.raw.get<Work>('tasks',id))!.state,'failed');
   assert.deepEqual(await f.snapshot(),before);assert.equal(f.terminal.length,1);assert.deepEqual(f.notices.map(n=>n.status),['skipped']);
   assert.equal(f.api.calls.some(c=>c.method.startsWith('chat.')),false);
  }finally{f.close();}
 });
}
test('sharing lookup is followed by fresh candidate reads, preserving changed records and handling newly added ones',async()=>{
 const f=fixture();try{
  const changed=card('FUNTRACKED','FUNTRACKED','CTEST'),added=card('FREVISION','FUNTRACKED','CTEST'),kept=card('FUNTRACKED','FUNTRACKED','CPRIVATE');
  await f.put('cards',changed.id,changed);await f.put('observed','changed',{file:'FUNTRACKED',channel:'CTEST'});
  f.api.handler=async(method,args)=>{
   assert.equal(method,'files.info');
   await f.put('cards',changed.id,{...changed,actor:{...changed.actor,channelId:'CPRIVATE'}});
   await f.put('cards',added.id,added);await f.put('cards',kept.id,kept);
   await f.put('observed','changed',{file:'FOTHER',channel:'CTEST'});
   await f.put('observed','new-revoked',{file:'FUNTRACKED',channel:'CTEST'});
   await f.put('observed','new-kept',{file:'FUNTRACKED',channel:'CPRIVATE'});
   return {ok:true,file:{...file,id:args.file,shares:{private:{CPRIVATE:[{team_id:'TTEST',ts:'123.456'}]}}}};
  };
  const id=await f.enqueue();await f.run(id);assert.equal(infoCalls(f),1);
  for(const c of [changed,kept]){assert.equal((await f.raw.get<Card&{removed?:boolean}>('cards',c.id))!.removed,undefined);assert.equal(await f.raw.get('revocations',c.id),undefined);}
  assert.equal((await f.raw.get<Card&{removed:boolean}>('cards',added.id))!.removed,true);assert.equal(await f.raw.get('revocations',added.id),1);
  assert.deepEqual(await f.raw.get('observed','changed'),{file:'FOTHER',channel:'CTEST'});
  assert.equal(await f.raw.get('observed','new-revoked'),undefined);assert.notEqual(await f.raw.get('observed','new-kept'),undefined);
 }finally{f.close();}
});
test('a post-lookup metadata read failure is not swallowed by the preflight',async()=>{
 let reads=0;
 const f=fixture(raw=>({get:raw.get.bind(raw),atomic:raw.atomic.bind(raw),list:async<T>(kind:string,limit?:number)=>{
  if(kind==='cards'&&++reads===2)throw new Error('synthetic post-lookup failure');return raw.list<T>(kind,limit);
 }}));try{
  const c=card('FUNTRACKED');await f.put('cards',c.id,c);const before=await f.snapshot(),id=await f.enqueue();
  await assert.rejects(f.run(id),/synthetic post-lookup failure/);assert.equal(infoCalls(f),1);
  assert.equal((await f.raw.get<Work>('tasks',id))!.state,'queued');assert.deepEqual(await f.snapshot(),before);
 }finally{f.close();}
});
test('file deletion still invalidates related cards and observed records without a sharing lookup',async()=>{
 const f=fixture();try{
  const c=card('FREVISION','FUNTRACKED');await f.put('cards',c.id,c);
  await f.put('observed','target',{file:'FUNTRACKED',channel:'CTEST'});
  await f.put('observed','other',{file:'FOTHER',channel:'CTEST'});
  f.api.handler=async()=>{throw new Error('deletion must not call Slack');};
  const id=await f.enqueue('FUNTRACKED',randomUUID(),'file_deleted');await f.run(id);
  assert.equal((await f.raw.get<Work>('tasks',id))!.state,'done');assert.equal(f.api.calls.length,0);
  assert.equal((await f.raw.get<Card&{removed:boolean}>('cards',c.id))!.removed,true);assert.equal(await f.raw.get('revocations',c.id),1);
  assert.equal(await f.raw.get('observed','target'),undefined);assert.notEqual(await f.raw.get('observed','other'),undefined);
 }finally{f.close();}
});
