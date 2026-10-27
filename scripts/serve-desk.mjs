import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {staticAssets} from '../src/server/static-assets.ts';

const port=Number(process.env.PORT||4175);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
const origin=`http://127.0.0.1:${port}`;
const assets=staticAssets();
const mount=resolve('dist/desk');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src ${origin} 'wasm-unsafe-eval'; worker-src ${origin} blob:; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; connect-src ${origin}; img-src ${origin} data: blob:; frame-src ${origin}; object-src 'none'; frame-ancestors ${origin}; base-uri 'none'; form-action 'none'`);
  if(req.headers.host!==new URL(origin).host){res.writeHead(403).end();return;}
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
  try{
    const url=new URL(req.url,origin);
    if(url.pathname==='/'||url.pathname==='/desk'){res.writeHead(302,{Location:'/desk/'}).end();return;}
    if(url.pathname.startsWith('/static/')){await assets(req,res,url.pathname);return;}
    const notices={'/licenses/MIT.txt':'LICENSE','/licenses/THIRD_PARTY_NOTICES.md':'THIRD_PARTY_NOTICES.md'};
    if(Object.hasOwn(notices,url.pathname)){
      const data=await readFile(notices[url.pathname]);res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(req.method==='HEAD'?undefined:data);return;
    }
    if(!url.pathname.startsWith('/desk/')){res.writeHead(404).end();return;}
    const file=resolve(mount,decodeURIComponent(url.pathname.slice(6)||'index.html'));
    if(!file.startsWith(mount+sep)){res.writeHead(403).end();return;}
    const bytes=await readFile(file);
    res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(404).end();}
}).listen(port,'127.0.0.1',()=>console.log(`D-HWP local desk: ${origin}/desk/`));
