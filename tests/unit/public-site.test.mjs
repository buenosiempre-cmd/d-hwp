import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const exporter=resolve('scripts/export-pages.mjs');
test('Pages public site is opt-in, links only the deployment API and publishes no document or secret files',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'rhwp-public-site-'));
 try{
  const version='a'.repeat(64);
  await mkdir(join(cwd,'dist/editor'),{recursive:true});await mkdir(join(cwd,'dist/studio'),{recursive:true});
 const program=`<script src="/static/${version}/studio/theme-init.js"></script><script src="/static/${version}/studio/locale-init.js"></script><script type="module" src="/static/${version}/studio/assets/app.js"></script>`;
 const shell='<meta name="rhwp-api-origin" content="">';
  await writeFile(join(cwd,'dist/editor/index.html'),shell);await writeFile(join(cwd,'dist/studio/index.html'),program);
  await writeFile(join(cwd,'dist/.env'),'must never be public');await writeFile(join(cwd,'dist/source.hwp'),'private document');
  const record={identity:{file:'studio/index.html',etag:'"'+createHash('sha256').update(program).digest('hex')+'"'}};
  // More than 100 program paths must not exhaust the Pages header rule budget.
  const programFiles={'studio/index.html':record,...Object.fromEntries(Array.from({length:120},(_,i)=>[`studio/assets/chunk-${i}.js`,record]))};
  await mkdir(join(cwd,'studio'),{recursive:true});
  const members={};
  for(const name of ['theme-init.js','locale-init.js']){
   const bytes='/* '+name+' */';const digest=createHash('sha256').update(bytes).digest('hex');
   await writeFile(join(cwd,'dist/studio',name),bytes);
   members['rhwp-studio/public/'+name]={size:Buffer.byteLength(bytes),sha256:digest};
   programFiles['studio/'+name]={identity:{file:'studio/'+name,etag:'"'+digest+'"'}};
  }
  await writeFile(join(cwd,'studio/source-files.json'),JSON.stringify({members}));
  await writeFile(join(cwd,'dist/static-manifest.json'),JSON.stringify({version,files:programFiles}));
  const run=(...args)=>execFileSync(process.execPath,[exporter,...args],{cwd,encoding:'utf8',stdio:'pipe'});
  run('https://api.example.test');
  await assert.rejects(readFile(join(cwd,'dist/pages/index.html')),{code:'ENOENT'});
  assert.match(await readFile(join(cwd,'dist/pages/robots.txt'),'utf8'),/Disallow: \/\n/);
  const internalHeaders=await readFile(join(cwd,'dist/pages/_headers'),'utf8');
  assert.ok(!internalHeaders.includes('media-src'));
  assert.equal(internalHeaders.trimEnd().split('\n\n').length,6);
  assert.ok(internalHeaders.includes('/static/*\n  Cache-Control: public, max-age=31536000, immutable'));
  run('https://api.example.test','--public-site');
  const root=join(cwd,'dist/pages'),files=await readdir(root,{recursive:true});
  assert.ok(files.includes('privacy/index.html'));assert.ok(files.includes('guide/index.html'));assert.ok(files.includes('support/index.html'));
  assert.ok(files.includes('licenses/index.html'));
  assert.equal(await readFile(join(root,'licenses/MIT.txt'),'utf8'),await readFile(new URL('../../LICENSE',import.meta.url),'utf8'));
  assert.equal(await readFile(join(root,'licenses/THIRD_PARTY_NOTICES.md'),'utf8'),await readFile(new URL('../../THIRD_PARTY_NOTICES.md',import.meta.url),'utf8'));
  const banner=await readFile(join(root,'assets/banner.png'));
  assert.deepEqual(banner,await readFile(new URL('../../site/assets/banner.png',import.meta.url)));
  assert.equal(banner.subarray(1,4).toString(),'PNG');
  assert.equal(banner.readUInt32BE(16),2756);assert.equal(banner.readUInt32BE(20),2122);
  assert.ok(!files.some(f=>f.startsWith('mydocs/')));
  assert.ok(!files.includes('.env'));assert.ok(!files.includes('source.hwp'));
  for(const path of files.filter(f=>f.endsWith('.html'))){
   const html=await readFile(join(root,path),'utf8');assert.ok(!html.includes('{{INSTALL_URL}}'));
   if(!path.startsWith('static/')&&!path.startsWith('editor/')&&path!=='404.html'){
    assert.match(html,/https:\/\/api.example.test\/install/);assert.ok(!/<script\b/i.test(html));
    const meta=Object.fromEntries([...html.matchAll(/<meta (?:property|name)="([^"]+)" content="([^"]*)">/g)].map(m=>[m[1],m[2]]));
    assert.equal(meta['og:title'],html.match(/<title>(.*?)<\/title>/)[1]);
    assert.equal(meta['og:description'],meta.description);
    assert.equal(meta['og:url'],'https://rhwp-slack.pages.dev/'+path.replace(/index\.html$/,''));
    assert.equal(meta['og:image'],'https://rhwp-slack.pages.dev/assets/banner.png');
    assert.equal(meta['og:image:width'],String(banner.readUInt32BE(16)));
    assert.equal(meta['og:image:height'],String(banner.readUInt32BE(20)));
    assert.equal(meta['og:image:type'],'image/png');assert.ok(meta['og:image:alt']);
    assert.equal(meta['twitter:card'],'summary_large_image');
    assert.equal(meta['twitter:image'],meta['og:image']);
    for(const [,url] of html.matchAll(/(?:href|src)="(\/[^"#]*)"/g)){
     await readFile(join(root,url.replace(/^\//,'')+(url.endsWith('/')?'index.html':'')));
    }
   }
  }
  const headers=await readFile(join(root,'_headers'),'utf8');
  assert.match(headers,/connect-src 'self' https:\/\/api.example.test/);
  assert.match(headers,/media-src 'self'(?:;|\n)/);
  assert.match(headers,/default-src 'none'/);
  assert.equal(headers.trimEnd().split('\n\n').length,18);
  assert.ok(!headers.includes('/static/'+version));
  assert.ok(files.includes(`static/${version}/studio/assets/chunk-119.js`));
  assert.equal(await readFile(join(root,'locale-init.js'),'utf8'),await readFile(join(root,`static/${version}/studio/locale-init.js`),'utf8'));
  const privacy=await readFile(join(root,'privacy/index.html'),'utf8');
  const privacySource=await readFile(new URL('../../site/privacy/index.html',import.meta.url),'utf8');
  assert.equal(privacy,privacySource.replaceAll('{{INSTALL_URL}}','https://api.example.test/install'));
  assert.ok(files.includes('assets/demo/rhwp-slack-20260926.mp4'));
  assert.ok(files.includes('assets/demo/rhwp-slack-20260926.jpg'));
  assert.ok(!headers.split('\n\n')[0].includes('X-Robots-Tag'));
  assert.match(headers,/\/editor\/\*\n  Cache-Control: no-cache\n  X-Robots-Tag: noindex, nofollow/);
  assert.match(await readFile(join(root,'editor/index.html'),'utf8'),/content="https:\/\/api.example.test"/);
  await writeFile(join(root,'output-marker'),'preserve on invalid input');
  assert.throws(()=>run('https://api.example.test/unsafe','--public-site'));
  assert.throws(()=>run('http://api.example.test','--public-site'));
  assert.throws(()=>run('https://api.example.test\n','--public-site'));
  await writeFile(join(cwd,'dist/studio/locale-init.js'),'tampered');
  assert.throws(()=>run('https://api.example.test','--public-site'));
  assert.equal(await readFile(join(root,'output-marker'),'utf8'),'preserve on invalid input');
 }finally{await rm(cwd,{recursive:true,force:true});}
});
