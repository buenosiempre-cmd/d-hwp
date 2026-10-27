import {build} from 'vite';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

// Desk is a separate local-file surface. The Slack editor keeps its authenticated ingress.
const manifest=JSON.parse(await readFile('dist/static-manifest.json','utf8'));
if(!/^[a-f0-9]{64}$/.test(manifest.version))throw new Error('Build the pinned Studio before the desk.');
await build({
  configFile:false,root:resolve('src/desk'),base:'/desk/',publicDir:false,
  define:{__STUDIO_BASE__:JSON.stringify('/static/'+manifest.version+'/studio/')},
  build:{outDir:resolve('dist/desk'),emptyOutDir:true,target:'es2022'},
});
