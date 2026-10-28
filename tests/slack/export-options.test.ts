import test from 'node:test';
import assert from 'node:assert/strict';
import {ExportSelections,exportView,parseExportView} from '../../src/server/export-options';
import {actor} from './support';

const values=(format:unknown,pages:unknown='1')=>({format:{value:{selected_option:{value:format}}},pages:{value:{value:pages}}});
test('export selections bind the verified document, message, workspace and user with defensive copies and expiry',()=>{
  let now=100;const store=new ExportSelections(()=>now,10),input={...actor,threadTs:'10.001'};
  const id=store.create(input,'card-one','10.002');input.channelId='COTHER';
  const selection=store.get(id,'TTEST','UTEST');assert.equal(selection.actor.channelId,'CTEST');assert.equal(selection.cardId,'card-one');assert.equal(selection.messageTs,'10.002');assert.equal(selection.expiresAt,110);
  selection.actor.channelId='CFORGED';assert.equal(store.get(id,'TTEST','UTEST').actor.channelId,'CTEST');
  assert.throws(()=>store.get(id,'TOTHER','UTEST'));assert.throws(()=>store.get(id,'TTEST','UOTHER'));
  now=110;assert.throws(()=>store.get(id,'TTEST','UTEST'));
  const removed=store.create(actor,'card-two','10.003');store.delete(removed);assert.throws(()=>store.get(removed,'TTEST','UTEST'));
});
test('export selection storage is bounded and expired entries release capacity',()=>{
  let now=0;const store=new ExportSelections(()=>now,1);
  for(let i=0;i<1000;i++)store.create(actor,`card-${i}`,'10.001');
  assert.throws(()=>store.create(actor,'overflow','10.001'),{code:'export_selection_full'});
  now=1;assert.ok(store.create(actor,'new','10.001'));
});
test('export modal offers only TXT and selected PNG ZIP and explicitly initializes a valid first range',()=>{
  for(const [count,expected] of [[undefined,'1'],[1,'1'],[4,'1-4'],[20,'1-10']] as const){
    const view=exportView('opaque-selection',count),blocks=view.blocks as any[];
    assert.equal(view.callback_id,'rhwp_export_document');assert.equal(view.private_metadata,'opaque-selection');
    assert.deepEqual(blocks.find(b=>b.block_id==='format').element.options.map((o:any)=>o.value),['txt','zip']);
    assert.equal(blocks.find(b=>b.block_id==='pages').element.initial_value,expected);
    assert.match(JSON.stringify(view),/OCR/);assert.match(JSON.stringify(view),/최대 10쪽/);
  }
});
test('TXT always exports whole text while ZIP parses bounded normalized page selections',()=>{
  assert.deepEqual(parseExportView(values('txt','malformed,0,999')),{format:'txt'});
  assert.deepEqual(parseExportView({format:{value:{selected_option:{value:'txt'}}}}),{format:'txt'});
  assert.deepEqual(parseExportView(values('zip','12,3-5,1,3')),{format:'zip',pages:[1,3,4,5,12]});
  for(const raw of ['',null,'0','201','1-11','4-2','1.5','1;3','all'])assert.throws(()=>parseExportView(values('zip',raw)),String(raw));
  for(const format of ['pdf','markdown','TXT',null])assert.throws(()=>parseExportView(values(format)));
  assert.throws(()=>parseExportView({}));assert.throws(()=>parseExportView(null));
});
