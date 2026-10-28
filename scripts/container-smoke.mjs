import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
assert.equal(process.platform,'linux');assert.notEqual(process.getuid(),0);
for(const file of ['.env','.git','dist/dev-editor','studio/upstream.json'])assert.equal(existsSync(file),false,`${file} leaked into runtime`);
assert.throws(()=>writeFileSync('/app/should-be-read-only','x'));
const evidence=process.env.RHWP_SMOKE_EVIDENCE;
// CI-only writable mount; production still has no persistent document output.
if(evidence)assert.equal(evidence,'/evidence');
const output=join(evidence??'/tmp','test-results');
try {
for(const suite of ['unit','slack','security']){
  const result=spawnSync(process.execPath,['scripts/run-tests.mjs',suite],{stdio:'inherit'});
  assert.equal(result.status,0,`${suite} checks failed`);
}
const conversion=spawnSync(process.execPath,['--test','tests/conversion/render.test.mjs','tests/conversion/structured-document.test.mjs','tests/conversion/markdown-package-frames.test.mjs'],{stdio:'inherit'});
assert.equal(conversion.status,0,'PDF/PNG and structured Markdown package checks failed');
if(process.argv.includes('--server-only')){
  const {convertPdf,closeConversionRuntime}=await import('../src/conversion/convert.mjs');
  for(const format of ['hwp','hwpx']){
    const pdf=await convertPdf(readFileSync(`tests/fixtures/viewer-two-pages.${format}`));
    assert.equal(pdf.subarray(0,5).toString(),'%PDF-');
  }
  await closeConversionRuntime();
}else{
  // This target additionally hosts the user's Studio browser inside the same cgroup.
  const result=spawnSync(process.execPath,['node_modules/@playwright/test/cli.js','test','tests/viewer/slack-flow.spec.ts','--output='+output],{stdio:'inherit'});
  assert.equal(result.status,0,'production Studio + PDF smoke failed');
}
} finally {
  const metrics={};
  for(const file of ['memory.events','memory.peak','cpu.stat']){
    const path='/sys/fs/cgroup/'+file;
    if(existsSync(path))metrics[file]=readFileSync(path,'utf8');
  }
  console.log(JSON.stringify({event:'smoke_cgroup',...metrics}));
  if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'cgroup.json'),JSON.stringify(metrics,null,2));}
}
if(existsSync('/sys/fs/cgroup/memory.events'))assert.match(readFileSync('/sys/fs/cgroup/memory.events','utf8'),/^oom_kill 0$/m,'cgroup reported an OOM kill');
console.log('Container smoke passed: Linux non-root, read-only runtime; Slack API is synthetic.');
