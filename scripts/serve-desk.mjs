import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {staticAssets} from '../src/server/static-assets.ts';
import {createRulesMcp} from '../src/server/rules-mcp.ts';
import {createRulesHandler} from '../src/server/rules-api.ts';
import {resolveDeskOrigin} from '../src/server/desk-public-origin.ts';
import {createDeskAuth} from '../src/server/desk-auth.ts';

async function main(){
const port=Number(process.env.PORT||4175);
const authFile=process.env.DHWP_DESK_AUTH_FILE;
const {origin,host,isPublic}=resolveDeskOrigin({port,publicOrigin:process.env.DHWP_DESK_PUBLIC_ORIGIN,authFile});
const auth=authFile?await createDeskAuth({origin,authFile}):null;
const assets=staticAssets();
const rules=createRulesMcp();
const handleRules=createRulesHandler(rules);
const mount=resolve('dist/desk');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json'};
createServer(async(req,res)=>{
  // Keep authenticated assets out of shared and browser caches, even when the
  // shared static-asset handler requests its normal immutable public caching.
  if(isPublic){
    const setHeader=res.setHeader.bind(res);
    res.setHeader=(name,value)=>setHeader(name,name.toLowerCase()==='cache-control'?'private, no-store':value);
    res.setHeader('Strict-Transport-Security','max-age=31536000');
  }
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src ${origin} 'wasm-unsafe-eval'; worker-src ${origin} blob:; style-src ${origin} 'unsafe-inline'; font-src ${origin} data:; connect-src ${origin}; img-src ${origin} data: blob:; frame-src ${origin}; object-src 'none'; frame-ancestors ${origin}; base-uri 'none'; form-action ${origin}`);
  if(req.headers.host!==host){res.writeHead(403).end();return;}
  try{
    const url=new URL(req.url??'/',origin);
    if(url.origin!==origin||url.username||url.password){res.writeHead(403).end();return;}
    if(auth&&await auth.handle(req,res,url))return;
    if(url.pathname==='/api/assistant/rules'){
      if(req.headers.origin!==origin){res.writeHead(403).end();return;}
      await handleRules(req,res,async()=>{
        if(auth&&!auth.isAuthenticated(req)){
          if(!res.destroyed&&!res.writableEnded){
            res.writeHead(401,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify({ok:false,error:{code:'AUTH_REQUIRED',message:'CoP 접속 인증이 필요합니다.'}}));
          }
          throw new Error('Desk authentication required');
        }
      });return;
    }
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
    if(url.pathname==='/healthz'){
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.end(req.method==='HEAD'?undefined:JSON.stringify({ok:true}));return;
    }
    if(url.pathname==='/'||url.pathname==='/desk'){res.writeHead(302,{Location:'/desk/'}).end();return;}
    if(url.pathname.startsWith('/static/')){await assets(req,res,url.pathname);return;}
    const notices={'/licenses/MIT.txt':'LICENSE','/licenses/THIRD_PARTY_NOTICES.md':'THIRD_PARTY_NOTICES.md'};
    if(Object.hasOwn(notices,url.pathname)){
      const data=await readFile(notices[url.pathname]);res.setHeader('Content-Type','text/plain; charset=utf-8');res.end(req.method==='HEAD'?undefined:data);return;
    }
    if(!url.pathname.startsWith('/desk/')){res.writeHead(404).end();return;}
    const file=resolve(mount,decodeURIComponent(url.pathname.slice(6)||'index.html'));
    if(!file.startsWith(mount+sep)){res.writeHead(403).end();return;}
    let bytes=await readFile(file);
    if(isPublic&&file===resolve(mount,'index.html')){
      const placeholder='<a id="desk-logout" class="text-button" href="/auth/logout" hidden>로그아웃</a>';
      const html=bytes.toString('utf8');
      if(html.split(placeholder).length!==2)throw new Error('Invalid desk authentication markup');
      bytes=Buffer.from(html.replace(placeholder,placeholder.replace(' hidden','')),'utf8');
    }
    res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');
    res.end(req.method==='HEAD'?undefined:bytes);
  }catch(error){
    if(res.destroyed||res.writableEnded)return;
    if(res.headersSent){res.end();return;}
    const code=error&&typeof error==='object'?'code' in error?error.code:undefined:undefined;
    const status=code==='ERR_INVALID_URL'||error instanceof URIError?400:code==='ENOENT'||code==='ENOTDIR'?404:500;
    const message=status===400?'올바르지 않은 요청입니다.':status===404?'요청한 파일을 찾지 못했습니다.':'요청을 처리하지 못했습니다.';
    res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'}).end(message);
  }
}).listen(port,'127.0.0.1',()=>console.log(`D-HWP ${isPublic?'authenticated':'local'} desk: ${origin}/desk/`));
}

main().catch(()=>{
  console.error('D-HWP desk startup failed. Check server configuration.');
  process.exitCode=1;
});
