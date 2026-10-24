// Export already-built program assets only. No environment files, credentials or document data.
import {readFile,writeFile,mkdir,copyFile,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {validateExportBootstrap} from './studio-bootstrap.mjs';
import {exportPublicSite} from './public-site.mjs';
import {exactApiOrigin,pagesHeaders} from './pages-headers.mjs';
export async function exportPages(apiOrigin,output=resolve('dist/pages'),{publicSite=false}={}){
 const api=new URL(exactApiOrigin(apiOrigin));
 const headers=pagesHeaders(api.origin,{publicSite});
 const headerRules=headers.trimEnd().split('\n\n').length;
 const manifest=JSON.parse(await readFile('dist/static-manifest.json','utf8'));
 if(!/^[a-f0-9]{64}$/.test(manifest.version))throw Error('Invalid static manifest');
 const locale=validateExportBootstrap(manifest);
 // Fixed output under dist prevents accidentally erasing an unrelated directory.
 if(output!==resolve('dist/pages'))throw Error('Output must be dist/pages');
 await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
 let count=0,total=0;
 for(const [path,record] of Object.entries(manifest.files)){
   if(!/^(studio|editor)\//.test(path)||path.split('/').includes('..'))throw Error('Invalid public asset');
   const bytes=await readFile(resolve('dist',record.identity.file));
   if(bytes.length>25*1024*1024)throw Error('Pages file limit exceeded');
   if('"'+createHash('sha256').update(bytes).digest('hex')+'"'!==record.identity.etag)throw Error('Asset changed after manifest generation');
   const target=`/static/${manifest.version}/${path}`;
   await mkdir(dirname(output+target),{recursive:true});await copyFile(resolve('dist',record.identity.file),output+target);
   total+=bytes.length;count++;
 }
 await writeFile(output+'/locale-init.js',locale);
 const shell=await readFile('dist/editor/index.html','utf8');
 if(!shell.includes('<meta name="rhwp-api-origin" content="">'))throw Error('Editor config anchor changed');
 await mkdir(output+'/editor');await writeFile(output+'/editor/index.html',shell.replace('<meta name="rhwp-api-origin" content="">',`<meta name="rhwp-api-origin" content="${api.origin}">`));
 await writeFile(output+'/404.html','<!doctype html><meta charset="utf-8"><title>rhwp</title><p>Slack에서 편집 카드를 다시 열어 주세요.</p>');
 const site=publicSite?await exportPublicSite(output,api.origin):{files:0,bytes:0};
 await writeFile(output+'/robots.txt',publicSite?'User-agent: *\nAllow: /\nDisallow: /editor/\nDisallow: /static/\nDisallow: /api/\nDisallow: /review/\nDisallow: /assets/review/\n':'User-agent: *\nDisallow: /\n');
 await writeFile(output+'/_headers',headers);
 // Explicit 404 disables Pages SPA fallback; no redirects forward fragments to the API.
 return {version:manifest.version,apiOrigin:api.origin,files:count+5+site.files,programBytes:total,siteBytes:site.bytes,headers:headerRules};
}
if(process.argv[1]?.endsWith('export-pages.mjs'))console.log(JSON.stringify(await exportPages(process.argv[2],undefined,{publicSite:process.argv.includes('--public-site')})));
