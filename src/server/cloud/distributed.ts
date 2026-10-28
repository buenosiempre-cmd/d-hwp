import {verifyOcrRuntime} from '../../conversion/ocr.mjs';
import {createHash} from 'node:crypto';
import {Firestore} from '@google-cloud/firestore';
import {CloudTasksClient} from '@google-cloud/tasks';
import {closeConversionRuntime} from '../../conversion/convert.mjs';
import {FirestoreMetadata} from './firestore-metadata';
import {GoogleTaskPublisher} from './tasks';
import {workerServer} from './worker';
import {Installations} from '../installations/store';
import {OAuthStates} from '../installations/state';
import {InstallOAuth} from '../installations/oauth';
import {EditorSignIn} from '../installations/signin';
import {Tenants} from '../installations/tenants';
import {distributedReceiver} from '../installations/receiver';
import {installationRoutes} from '../installations/routes';
import {browserSignInRoutes,tenantEditorRoutes} from '../installations/browser-routes';
import {installationLifecycle} from '../installations/lifecycle';
import {loadDistributedConfig} from '../installations/config';
const namespace=(prefix:string,values:string[])=>prefix+'-'+createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0,32);
async function main(){try{
  const {config,oauth,role,keyId,keys,environment}=loadDistributedConfig();
  if(config.markdownOcr)await verifyOcrRuntime(config.markdownOcr);
  const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error('Missing cloud configuration');return value;};
  const projectId=required('GOOGLE_CLOUD_PROJECT'),db=new Firestore({projectId}),client=new CloudTasksClient({projectId});
  const registry=new FirestoreMetadata(db,namespace('r',[environment,config.appId]),'TREGISTRY');
  const vault=new Installations(registry,config.appId,keyId,keys),states=new OAuthStates(registry);
  const publisher=new GoogleTaskPublisher(client,required('TASK_QUEUE'),required('WORKER_ORIGIN'),required('TASK_SERVICE_ACCOUNT'));
  const tenants=new Tenants({config,installations:vault,registry,publisher,store:installation=>new FirestoreMetadata(db,namespace('i',[environment,installation.appId,installation.generation]),installation.teamId)});
  const runtime=role==='ingress'?distributedReceiver({appId:config.appId,signingSecret:config.signingSecret,tenants,lifecycle:installationLifecycle(vault)}):undefined;
  const worker=role==='worker'?workerServer(tenants,async()=>{}, {audience:required('WORKER_ORIGIN'),serviceAccount:required('TASK_SERVICE_ACCOUNT')}):undefined;
  if(runtime){
    runtime.receiver.router.use(installationRoutes(new InstallOAuth(oauth!,states,vault)));
    runtime.receiver.router.use(browserSignInRoutes(new EditorSignIn({...oauth!,editorOrigin:config.editorOrigin!},states,tenants)));
    runtime.receiver.router.use(tenantEditorRoutes(tenants,config.publicOrigin!,config.editorOrigin!));
    await runtime.receiver.start({host:'0.0.0.0',port:config.port});
  }else await new Promise<void>(resolve=>worker!.listen(config.port,'0.0.0.0',resolve));
  console.log(JSON.stringify({event:'distributed_ready',role}));
  let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;if(runtime)await runtime.receiver.stop();if(worker)await new Promise<void>(resolve=>worker.close(()=>resolve()));await closeConversionRuntime();await db.terminate();await client.close();};
  process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
}catch{console.error('Distributed runtime configuration failed.');process.exitCode=1;}}
// Separate entrypoint: the existing single-workspace Cloud Run deployment is unchanged.
if(process.argv[2]!=='--warm-code')void main();
