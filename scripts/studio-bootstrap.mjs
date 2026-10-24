import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
export const bootstrapNames=['theme-init.js','locale-init.js'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validatePreparedBootstrap(){
 const manifest=JSON.parse(readFileSync('studio/source-files.json','utf8'));
 for(const name of bootstrapNames){
  const bytes=readFileSync(resolve('.cache/studio-public',name));
  const expected=manifest.members['rhwp-studio/public/'+name];
  if(!expected||bytes.length!==expected.size||sha(bytes)!==expected.sha256)throw Error('Invalid prepared bootstrap: '+name);
 }
}
export function validateBootstrapHtml(html,version){
 if(!/^[a-f0-9]{64}$/.test(version))throw Error('Invalid bootstrap version');
 const tags=[...html.matchAll(/<script\b[^>]*>/gi)];
 const firstModule=tags.findIndex(tag=>/\btype\s*=\s*["']module["']/i.test(tag[0]));
 if(firstModule<0)throw Error('Missing Studio module');
 for(const name of bootstrapNames){
  const found=tags.filter(tag=>tag[0].includes(name));
  if(found.length!==1)throw Error('Missing or duplicate bootstrap: '+name);
  const tag=found[0];
  const src=/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
  if(src!==`/static/${version}/studio/${name}`||/\b(?:async|defer|type)\b/i.test(tag[0])||tag.index>=tags[firstModule].index)throw Error('Bootstrap must run synchronously before Studio: '+name);
 }
}
export function validateExportBootstrap(manifest){
 const html=readFileSync('dist/studio/index.html','utf8');
 validateBootstrapHtml(html,manifest.version);
 const source=JSON.parse(readFileSync('studio/source-files.json','utf8'));
 for(const name of bootstrapNames){
  const record=manifest.files['studio/'+name]?.identity;
  if(record?.file!=='studio/'+name)throw Error('Missing bootstrap identity: '+name);
  const bytes=readFileSync('dist/'+record.file),expected=source.members['rhwp-studio/public/'+name];
  if(!expected||bytes.length!==expected.size||sha(bytes)!==expected.sha256||record.etag!=='"'+sha(bytes)+'"')throw Error('Changed bootstrap identity: '+name);
 }
 return readFileSync('dist/studio/locale-init.js');
}
