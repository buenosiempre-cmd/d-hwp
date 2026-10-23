import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {exactApiOrigin,pagesHeaders} from '../../scripts/pages-headers.mjs';

const origin='https://api.example.test';
const script=fileURLToPath(new URL('../../scripts/pages-headers.mjs',import.meta.url));
const parse=text=>Object.fromEntries(text.trimEnd().split('\n\n').map(block=>{
 const [path,...lines]=block.split('\n');
 return [path,Object.fromEntries(lines.map(line=>{const i=line.indexOf(':');return [line.slice(0,i).trim(),line.slice(i+1).trim()];}))];
}));

test('both roles keep editor/API policy and cache current and retained namespaces with one static rule',()=>{
 for(const publicSite of [false,true]){
  const text=pagesHeaders(origin,{publicSite}),rules=parse(text);
  assert.equal(Object.keys(rules).length,publicSite?17:5);
  assert.equal(rules['/editor/*']['Cache-Control'],'no-cache');
  assert.equal(rules['/api/*']['Cache-Control'],'no-store');
  assert.equal(rules['/404.html']['Cache-Control'],'no-store');
  assert.equal(rules['/static/*']['Cache-Control'],'public, max-age=31536000, immutable');
  assert.equal(Object.keys(rules).filter(path=>path.startsWith('/static/')).length,1);
  for(const namespace of ['a'.repeat(64),'b'.repeat(64)]){
   for(const suffix of ['studio/','studio/index.html','studio/fonts/font.woff2','editor/assets/app.js']){
    const path=`/static/${namespace}/${suffix}`;
    const applicable=Object.entries(rules).filter(([pattern])=>pattern.endsWith('*')?path.startsWith(pattern.slice(0,-1)):path===pattern);
    assert.equal(applicable.filter(([,value])=>value['Cache-Control']).length,1);
    assert.equal(Object.assign({},...applicable.map(([,value])=>value))['Cache-Control'],'public, max-age=31536000, immutable');
   }
  }
  const global=rules['/*'];
  assert.equal(global['Referrer-Policy'],'no-referrer');assert.equal(global['X-Content-Type-Options'],'nosniff');
  assert.ok(global['Content-Security-Policy'].includes(`connect-src 'self' ${origin};`));
  assert.ok(global['Content-Security-Policy'].includes("frame-ancestors 'self' https://*.slack.com https://*.slack-gov.com https://*.slack-mcps.com"));
  assert.equal(global['Content-Security-Policy'].includes("media-src 'self'"),publicSite);
  assert.equal(global['X-Robots-Tag'],publicSite?undefined:'noindex, nofollow');
  assert.equal(rules['/static/*']['X-Robots-Tag'],publicSite?'noindex, nofollow':undefined);
  if(publicSite)assert.equal(rules['/privacy/']['Cache-Control'],'no-cache');
 }
});

test('origin validation rejects header injection and normalized non-origin URLs',()=>{
 assert.equal(exactApiOrigin(origin+'/'),origin);
 for(const input of [undefined,null,'','http://api.example.test','https:api.example.test',origin+'/api',origin+'/?',origin+'/#',origin+'?x=1',origin+'#fragment','https://user:secret@api.example.test','https://@api.example.test','https://*.example.test','https://%2a.example.test',origin+'/../',origin+'/\\unsafe',' '+origin,origin+'\n',origin+'\r\nX-Test: injected',origin+'\t','https://api.example.test:443']){
  assert.throws(()=>pagesHeaders(input),/exact HTTPS API origin/);
 }
});

test('CLI emits only the header document; importing the module emits nothing',()=>{
 for(const publicSite of [false,true]){
  const output=execFileSync(process.execPath,[script,'--api-origin',origin,...(publicSite?['--public-site']:[])],{encoding:'utf8'});
  assert.equal(output,pagesHeaders(origin,{publicSite}));
 }
 const moduleUrl=new URL('../../scripts/pages-headers.mjs',import.meta.url).href;
 assert.equal(execFileSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(moduleUrl)})`],{encoding:'utf8'}),'');
 for(const args of [[],['--api-origin'],['--api-origin',origin,'--unknown'],['--api-origin',origin,'--public-site','--public-site'],['--api-origin',origin+'\n']]){
  const result=spawnSync(process.execPath,[script,...args],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.ok(result.stderr.length>0);
 }
});
