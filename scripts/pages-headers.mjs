import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {editorPolicy} from '../src/server/editor-policy.ts';

/** One canonical HTTPS origin, with an optional trailing slash; no URL normalization surprises. */
export function exactApiOrigin(value){
 const invalid=()=>new Error('Supply one exact HTTPS API origin');
 if(typeof value!=='string'||/[\s\x00-\x1f\x7f]/u.test(value))throw invalid();
 let api;
 try{api=new URL(value);}catch{throw invalid();}
 if(api.protocol!=='https:'||api.username||api.password||api.hostname.includes('*')
   ||(value!==api.origin&&value!==api.origin+'/'))throw invalid();
 return api.origin;
}

/** Static program namespaces are immutable; editor/configuration pages remain revalidatable. */
export function pagesHeaders(apiOrigin,{publicSite=false}={}){
 const origin=exactApiOrigin(apiOrigin);
 const blocks=[
  `/*\n  Referrer-Policy: no-referrer\n  X-Content-Type-Options: nosniff\n${publicSite?'':'  X-Robots-Tag: noindex, nofollow\n'}  Content-Security-Policy: ${editorPolicy(origin)}${publicSite?"; media-src 'self'":""}`,
  `/editor/*\n  Cache-Control: no-cache${publicSite?'\n  X-Robots-Tag: noindex, nofollow':''}`,
  `/api/*\n  Cache-Control: no-store${publicSite?'\n  X-Robots-Tag: noindex, nofollow':''}`,
  '/locale-init.js\n  Cache-Control: no-cache\n  X-Robots-Tag: noindex, nofollow',
  '/404.html\n  Cache-Control: no-store',
  `/static/*\n${publicSite?'  X-Robots-Tag: noindex, nofollow\n':''}  Cache-Control: public, max-age=31536000, immutable`,
 ];
 if(publicSite){
  blocks.push('/review/*\n  X-Robots-Tag: noindex, nofollow','/assets/review/*\n  X-Robots-Tag: noindex, nofollow');
  for(const path of ['/','/guide/','/privacy/','/support/','/licenses/','/licenses/MIT.txt','/licenses/THIRD_PARTY_NOTICES.md','/review/','/site.css','/rhwp-logo.png'])blocks.push(path+'\n  Cache-Control: no-cache');
 }
 if(blocks.length>100||blocks.some(b=>b.split('\n').some(line=>line.length>2000)))throw Error('Pages header limit exceeded');
 return blocks.join('\n\n')+'\n';
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{
  const args=process.argv.slice(2);
  if(args[0]!=='--api-origin'||![2,3].includes(args.length)||(args.length===3&&args[2]!=='--public-site'))throw Error('Usage: pages-headers.mjs --api-origin HTTPS_ORIGIN [--public-site]');
  process.stdout.write(pagesHeaders(args[1],{publicSite:args.length===3}));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
