import {verifyOcrRuntime} from '../../conversion/ocr.mjs';
import {closeConversionRuntime} from '../../conversion/convert.mjs';
import {runtimeId} from './telemetry';
import {Firestore} from '@google-cloud/firestore';
import {CloudTasksClient} from '@google-cloud/tasks';
import {loadConfig} from '../config';
import {HttpSlackApi} from '../slack-api';
import {verifyInstallation} from '../receiver';
import {FirestoreMetadata} from './firestore-metadata';
import {GoogleTaskPublisher,DurableTasks} from './tasks';
import {CloudApplication} from './application';
import {CloudEvents} from './events';
import {createCloudReceiver} from './receiver';
import {workspaceWorker} from './workspace-worker';
async function main(){try{
 const starting=Date.now();
 const required=(name:string)=>{const value=process.env[name];if(!value)throw new Error('Missing cloud setting');return value;};
 const config=loadConfig(),role=required('CLOUD_ROLE');if(config.markdownOcr)await verifyOcrRuntime(config.markdownOcr);if(!['ingress','worker'].includes(role))throw new Error('Invalid role');
 const projectId=required('GOOGLE_CLOUD_PROJECT'),database=new Firestore({projectId}),store=new FirestoreMetadata(database,required('CLOUD_ENVIRONMENT'),config.teamId);
 const client=new CloudTasksClient({projectId}),publisher=new GoogleTaskPublisher(client,required('TASK_QUEUE'),required('WORKER_ORIGIN'),required('TASK_SERVICE_ACCOUNT'));
 const tasks=new DurableTasks(store,publisher),api=new HttpSlackApi(config.botToken);
 // Warm authenticated SDK connections while Slack installation verification is in flight.
 const [identity]=await Promise.all([verifyInstallation(api,config),store.get('settings','initialized'),client.initialize()]);
 const application=new CloudApplication(config,api,store,tasks);
 const events=new CloudEvents(application,identity.botUserId);
 const runtime=role==='ingress'?createCloudReceiver(config,application,identity):undefined;
 const worker=role==='worker'?workspaceWorker(tasks,application,events,{audience:required('WORKER_ORIGIN'),serviceAccount:required('TASK_SERVICE_ACCOUNT')}):undefined;
 if(runtime)await runtime.receiver.start({host:'0.0.0.0',port:config.port});else await new Promise<void>(resolve=>worker!.listen(config.port,'0.0.0.0',resolve));
 console.log(JSON.stringify({event:'cloud_ready',runtimeId,role,initializationMs:Date.now()-starting,processUptimeMs:Math.round(process.uptime()*1000)}));
 let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;if(runtime)await runtime.receiver.stop();if(worker)await new Promise<void>(r=>worker.close(()=>r()));await closeConversionRuntime();await database.terminate();await client.close();};
 process.once('SIGTERM',()=>{void stop();});process.once('SIGINT',()=>{void stop();});
}catch{console.error('Cloud runtime configuration or installation check failed.');process.exitCode=1;}
}
// Build-time warmup loads code only; it never reads secrets or contacts services.
if(process.argv[2]!=='--warm-code')void main();
