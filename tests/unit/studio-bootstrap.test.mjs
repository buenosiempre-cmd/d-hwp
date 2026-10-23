import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {validateBootstrapHtml} from '../../scripts/studio-bootstrap.mjs';
const version='a'.repeat(64);
const html=`<script src="/static/${version}/studio/theme-init.js"></script><script src="/static/${version}/studio/locale-init.js"></script><script type="module" src="/static/${version}/studio/app.js"></script>`;
test('bootstrap guards synchronous versioned scripts before module execution',()=>{
 validateBootstrapHtml(html,version);
 for(const bad of [html.replace('locale-init.js','absent.js'),html+`<script src="locale-init.js"></script>`,html.replace('<script src=','<script async src='),html.replace('<script src=','<script defer src='),html.replace(`/static/${version}/studio/locale-init.js`,'/locale-init.js'),html.replace('theme-init.js','locale-init.js')])assert.throws(()=>validateBootstrapHtml(bad,version));
 assert.throws(()=>validateBootstrapHtml(html,'b'.repeat(64)));
});
test('pinned locale bootstrap uses query then storage then Korean without navigator',()=>{
 const source=readFileSync('tests/fixtures/locale-init.js','utf8');
 for(const [query,stored,blocked,want] of [['?lang=en','ko',false,'en'],['?lang=ko-KR','en',false,'ko'],['?lang=fr','en_US',false,'en'],['','en',false,'en'],['','fr',false,'ko'],['','en',true,'ko'],['?lang=en','ko',true,'en']]){
  const document={documentElement:{lang:''}};
  runInNewContext(source,{document,URLSearchParams,location:{search:query},localStorage:{getItem(){if(blocked)throw Error('blocked');return stored;}},navigator:new Proxy({},{get(){throw Error('navigator must not affect locale');}})});
  assert.equal(document.documentElement.lang,want);
 }
});
