import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {OAuth2Client} from 'google-auth-library';
import {DurableTasks,TaskBusy,type TaskSpec,type TaskContext} from './tasks';
import {traceDelivery,bindDelivery,deliveryFailure} from './telemetry';
export function workerServer(tasks:Pick<DurableTasks,'execute'>,run:(spec:TaskSpec,context:TaskContext)=>Promise<void>,options:{audience:string;serviceAccount:string;verify?:(token:string)=>Promise<boolean>;diagnosticSink?:(record:Record<string,unknown>)=>void}){
 const oauth=new OAuth2Client();
 const verify=options.verify??(async(token:string)=>{const ticket=await oauth.verifyIdToken({idToken:token,audience:options.audience});const p=ticket.getPayload();return p?.email===options.serviceAccount&&p.email_verified===true;});
 return createServer(async(req:IncomingMessage,res:ServerResponse)=>{
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/healthz'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'}).end('{"ok":true}');return;}
  if(req.url!=='/internal/tasks'||req.method!=='POST'){res.writeHead(404).end();return;}
  await traceDelivery(req.headers['x-cloud-trace-context'],async()=>{try{
   const token=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization??'')?.[1];
   if(!token||!await verify(token)){res.writeHead(403).end();return;}
   if(req.headers['content-type']!=='application/json'||Number(req.headers['content-length']??0)>1024){res.writeHead(400).end();return;}
   const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>1024){res.writeHead(413).end();return;}chunks.push(b);}
   const data=JSON.parse(Buffer.concat(chunks).toString());
   if(typeof data.id!=='string'||!/^[a-f0-9]{64}$/.test(data.id)||Object.keys(data).length!==1){res.writeHead(400).end();return;}
   bindDelivery(data.id);
   await tasks.execute(data.id,run);res.writeHead(204).end();
  }catch(error){deliveryFailure(error);res.writeHead(error instanceof TaskBusy?409:503).end('Retry task');}},()=>res.statusCode,options.diagnosticSink);
 });
}
