import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {State} from '../../src/server/state';
import {SqliteMetadata} from '../../src/server/cloud/sqlite-metadata';
import {DurableTasks} from '../../src/server/cloud/tasks';
import {CloudApplication} from '../../src/server/cloud/application';
import {CloudEvents} from '../../src/server/cloud/events';
import {createCloudReceiver} from '../../src/server/cloud/receiver';
import {workspaceWorker} from '../../src/server/cloud/workspace-worker';
import {EditorApi} from './editor-support';
import {actor,config,bytes} from './support';

export async function legacyFixture(overrides:Partial<typeof config>={}){
 const dir=mkdtempSync(join(tmpdir(),'rhwp-legacy-contract-')),state=new State(join(dir,'state.sqlite'),'TTEST');let time=Date.now();
 const store=new SqliteMetadata(state,()=>time),api=new EditorApi(),pending:string[]=[],scheduled:{id:string;at?:number}[]=[],uploaded=new Map<string,Buffer>();
 const tasks=new DurableTasks(store,{async publish(id,at){scheduled.push({id,at});if(at===undefined)pending.push(id);}},()=>time);
 const cfg={...config,editorMode:'embed' as const,publicOrigin:'https://legacy-api.example.com',editorOrigin:'https://legacy-editor.example.com',...overrides};
 const application=new CloudApplication(cfg,api,store,tasks,{download:async source=>uploaded.get(source.id)??bytes,fetcher:async(url,init)=>{uploaded.set(new URL(String(url)).pathname.split('/').pop()!,Buffer.from(init!.body as Uint8Array));return new Response('ok');},
  convert:async()=>({pdf:Buffer.from('%PDF-synthetic'),pageCount:2,pages:[1,2].map(page=>({page,png:Buffer.from('png')}))}),
  images:async()=>({pageCount:2,pages:[1,2].map(page=>({page,png:Buffer.from('png')}))})});
 const events=new CloudEvents(application,'UBOT');
 const worker=workspaceWorker(tasks,application,events,{audience:'https://legacy-worker.example.com',serviceAccount:'worker@example.iam.gserviceaccount.com',verify:async token=>token==='valid'});
 await new Promise<void>(r=>worker.listen(0,'127.0.0.1',r));const workerAddress=worker.address();if(!workerAddress||typeof workerAddress==='string')throw Error('listen');
 const runtime=createCloudReceiver(cfg,application,{botId:'BBOT',botUserId:'UBOT'}),server=await runtime.receiver.start({host:'127.0.0.1',port:0}),address=server.address();if(!address||typeof address==='string')throw Error('listen');
 const origin=`http://127.0.0.1:${address.port}`;
 const dispatch=(id:string,token='valid')=>fetch(`http://127.0.0.1:${workerAddress.port}/internal/tasks`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({id})});
 return {cfg,origin,application,events,tasks,store,api,pending,scheduled,uploaded,dispatch,advance(n:number){time+=n;},
  async drain(){let count=0;while(pending.length){if(++count>30)throw Error('Unbounded queue');const r=await dispatch(pending.shift()!);if(r.status!==204)throw Error('Worker '+r.status);}},
  async prepare(){const id=await application.submit({...actor,threadTs:'100.001'},'FTEST','thread:legacy');await this.drain();return id;},
  async close(){await runtime.receiver.stop();await new Promise<void>(r=>worker.close(()=>r()));state.close();rmSync(dir,{recursive:true,force:true});}};
}
