import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
// Content-derived namespace covers public program inputs, including pinned fonts/engine.
// No environment variables, deployment secrets, document bytes or timestamps enter the hash.
export function staticVersion(){
  const hash=createHash('sha256');
  function visit(path){for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
    const file=path+'/'+entry.name;if(entry.isDirectory())visit(file);else {hash.update(file+'\0');hash.update(readFileSync(file));}
  }}
  for(const path of ['src/editor','src/shared','studio'])visit(path);
  for(const path of ['package-lock.json','vite.config.ts','scripts/build-studio.mjs','scripts/studio-bootstrap.mjs','scripts/build-host.mjs','scripts/prepare-studio.mjs','scripts/static-version.mjs','scripts/build-static.mjs']){hash.update(path+'\0');hash.update(readFileSync(path));}
  return hash.digest('hex');
}
