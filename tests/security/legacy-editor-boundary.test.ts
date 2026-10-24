import test from 'node:test';
import assert from 'node:assert/strict';
import {actor,signed} from '../slack/support';
import {legacyFixture} from '../slack/legacy-support';

test('legacy signed app/team/actor and exact editor origin remain required after common source integration',async()=>{
 const f=await legacyFixture();try{
  const id=await f.prepare();
  const base={type:'event_callback',api_app_id:'ATEST',team_id:'TTEST',event_id:'EVALID',event:{type:'entity_details_requested',user:'UTEST',channel:'CTEST',external_ref:{id,type:'document'},entity_url:`${f.cfg.publicOrigin}/documents/${id}`,trigger_id:'detail.trigger'}};
  for(const payload of [{...base,api_app_id:'AOTHER'},{...base,team_id:'TOTHER'},{...base,event_id:'EACTOR',event:{...base.event,user:'UOTHER'}},{...base,event_id:'EURL',event:{...base.event,entity_url:'https://wrong.example.com/documents/'+id}}])await signed(f.origin,payload,{json:true});
  assert.equal(f.api.calls.some(c=>c.method==='entity.presentDetails'),false);
  await signed(f.origin,base,{json:true,tamper:true});assert.equal(f.api.calls.some(c=>c.method==='entity.presentDetails'),false);
  const ticket=await f.application.sessions.issue(id,actor);
  const exchange=(origin:string)=>fetch(f.origin+'/api/editor/exchange',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({ticket})});
  const wrong=await exchange('https://evil.example.com');assert.equal(wrong.status,403);assert.equal(wrong.headers.get('access-control-allow-origin'),null);
  const valid=await exchange(f.cfg.editorOrigin);assert.equal(valid.status,200);assert.equal(valid.headers.get('cache-control'),'no-store');
  const {token}=await valid.json() as {token:string};assert.equal((await exchange(f.cfg.editorOrigin)).status,403);
  assert.equal((await fetch(f.origin+'/api/editor/document',{headers:{Authorization:'Bearer '+token,'X-Rhwp-Workspace':'TOTHER'}})).status,200);
  // A tenant hint never switches this single-workspace session to another team.
  assert.equal((await f.application.sessions.require(token)).actor.teamId,'TTEST');
  await f.application.invalidate('FTEST');
  assert.equal((await fetch(f.origin+'/api/editor/source',{headers:{Authorization:'Bearer '+token}})).status,403);
  await assert.rejects(f.application.authorize(id,{...actor,teamId:'TOTHER'}));
 }finally{await f.close();}
});
