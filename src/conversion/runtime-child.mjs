// This process receives no application credentials. Only immutable build assets survive jobs.
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {resolve} from 'node:path';
import {workerEnvironment} from './worker-env.mjs';
import {normalizeSelectedPages} from './selection.mjs';
let active=false,stopping=false;
const send=value=>{if(process.connected)process.send(value);};
const metric=(stage,phase,started)=>send({type:'metric',value:{stage,phase,...(started===undefined?{}:{durationMs:Math.round(performance.now()-started),rssBytes:process.memoryUsage().rss})}});
async function stop(){if(stopping)return;stopping=true;process.exit(1);}
process.on('disconnect',()=>{void stop();});process.on('SIGTERM',()=>{void stop();});
process.stdout.on('error',()=>{void stop();});
try{
 const manifest=JSON.parse(await readFile('.cache/conversion/runtime.json','utf8'));
 const pinned=new Map();
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 for(const path of ['src/conversion/ocr.mjs','node_modules/@rhwp/core/rhwp_bg.wasm','node_modules/@rhwp/core/rhwp.js',...['fonts.json','print.js','pdf-child.mjs','runtime-child.mjs'].map(name=>'.cache/conversion/'+name)]){
  const bytes=await readFile(path);if(digest(bytes)!==manifest.hashes[path])throw new Error('build mismatch');pinned.set(path,bytes);
 }
 const start=performance.now();metric('wasm_compile','start');
 const module=await WebAssembly.compile(pinned.get('node_modules/@rhwp/core/rhwp_bg.wasm'));
 metric('wasm_compile','finish',start);
 const fontManifest=JSON.parse(pinned.get('.cache/conversion/fonts.json').toString());
 const fontBytes=Object.fromEntries(await Promise.all(Object.values(fontManifest.files).map(async file=>{if(!/^[a-f0-9]{64}\.woff2$/.test(file))throw new Error('font name');const bytes=await readFile(resolve('.cache/conversion/fonts',file));if(digest(bytes)!==file.slice(0,-6))throw new Error('font mismatch');return [file,bytes];})));
 const print=pinned.get('.cache/conversion/print.js').toString();pinned.clear();
 const browserWs=process.env.RHWP_PDF_BROWSER_WS;if(!browserWs)throw new Error('supervisor');
 process.on('message',request=>{
  if(active||stopping||request?.type!=='convert'){void stop();return;}
  active=true;
  void (async()=>{
   const {mode,start,end,bytes,ocr}=request;
   if(!Buffer.isBuffer(bytes)||bytes.length>20*1024*1024||!['pdf','preview','images','selected','markdown','markdown-package','text'].includes(mode)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>10)throw new Error('request');
   const selectedPages=mode==='selected'?normalizeSelectedPages(request.selectedPages):undefined;
   const workerStart=performance.now();metric('process_start','start');
   // Each thread gets new JS bindings, WASM instance/memory and copied assets. No SharedArrayBuffer.
   const worker=new Worker(resolve('.cache/conversion/pdf-child.mjs'),{execArgv:[],env:workerEnvironment(),stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:512},workerData:{mode,start,end,selectedPages,bytes,ocr,module,fontManifest,fontBytes,print,browserWs}});
   worker.once('online',()=>metric('process_start','finish',workerStart));
   let failure;
   worker.on('message',value=>{if(value?.phase==='failed')failure=value;send({type:'metric',value});});worker.stderr.resume();
   worker.stdout.pipe(process.stdout,{end:false});
   const [code]=await Promise.all([once(worker,'exit').then(([code])=>code),finished(worker.stdout)]);
   if(code!==0){
    if(failure){send({type:'failure',value:failure});setTimeout(()=>void stop(),5000).unref();return;}
    throw new Error('conversion');
   }
   active=false;
   // End is sent only AFTER the document thread/context have been destroyed.
   const header=Buffer.from(JSON.stringify({type:'end'})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);
   process.stdout.write(Buffer.concat([length,header]));
  })().catch(()=>{void stop();});
 });
 send({type:'ready'});
}catch{await stop();}
