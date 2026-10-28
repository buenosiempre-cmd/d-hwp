import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {documentMessage,documentMetadata} from '../../src/server/document-message';
import {Settings} from '../../src/server/settings';
import type {Card} from '../../src/server/documents';
import {FakeApi,config,actor} from './support';

const origin='https://dhwp.example.test';
function card(overrides:Partial<Card>={}):Card {
  return {id:'synthetic-card',actor,fileId:'FTEST',rootFileId:'FTEST',name:'<@UTEST> & 업무보고.hwp',size:100,createdAt:0,revision:0,
    pageCount:12,pdf:'ready',pdfUrl:'https://rhwp-test.slack.com/files/UBOT/FPDF/document.pdf',pdfFileId:'FPDF',imageState:'ready',
    images:[1,2,3].map(page=>({page,fileId:'FIMAGE'+page,shared:true})),...overrides};
}
interface Button {action_id:string;value?:string;url?:string;text:{text:string};}
interface Block {type:string;text?:{text:string};elements?:Button[];}
function buttons(message:Record<string,unknown>):Button[]{return (message.blocks as Block[]).filter(block=>block.type==='actions').flatMap(block=>block.elements??[]);}

test('conversion card leads with PDF and original Markdown while retaining bounded PNG and optional editing',()=>{
  const source=card(),message=documentMessage(source,origin,'browser'),actions=buttons(message);
  assert.equal(message.metadata,undefined);
  assert.deepEqual(actions.map(button=>button.action_id),['rhwp_view_pdf','rhwp_export_markdown','rhwp_export_options','rhwp_more_pages','rhwp_browser_edit']);
  assert.equal(actions[0].url,source.pdfUrl);assert.equal(actions[0].text.text,'PDF 열기');
  assert.equal(actions[1].value,source.id);assert.equal(actions[1].url,undefined);
  assert.equal(actions[1].text.text,'문서 Markdown (ZIP)');
  assert.equal(actions[2].text.text,'형식·쪽 선택');assert.equal(actions[2].value,source.id);assert.equal(actions[2].url,undefined);
  assert.equal(actions[3].text.text,'PNG 이미지 (앞 10쪽)');assert.equal(actions[3].value,source.id);
  assert.equal(actions[4].text.text,'문서 편집 (RHWP)');
  const section=(message.blocks as Block[]).find(block=>block.type==='section')!.text!.text;
  assert.ok(section.includes('&lt;@UTEST&gt; &amp; 업무보고.hwp'));assert.ok(!section.includes('<@UTEST>'));
  assert.match(JSON.stringify(message.blocks),/Markdown ZIP/);
  assert.match(JSON.stringify(message.blocks),/TXT/);assert.match(JSON.stringify(message.blocks),/OCR/);
  const metadata=documentMetadata(source,origin) as {entity_payload:{attributes:{product_name:string}}};
  assert.equal(metadata.entity_payload.attributes.product_name,'D-HWP');
});

test('unfinished outputs are not offered as ready and an existing Markdown still uses authorized export action',()=>{
  const pending=buttons(documentMessage(card({pdf:'pending',pdfUrl:undefined,imageState:'pending'}),origin));
  assert.equal(pending.some(button=>button.action_id==='rhwp_view_pdf'),false);
  assert.equal(pending.some(button=>button.action_id==='rhwp_more_pages'),false);
  assert.equal(pending.some(button=>button.action_id==='rhwp_export_markdown'),true);
  const ready=buttons(documentMessage(card({exports:{'markdown-v3':{request:{format:'markdown'},url:'https://rhwp-test.slack.com/files/UBOT/FMD/document_Markdown.zip'}}}),origin));
  const markdown=ready.find(button=>button.action_id==='rhwp_export_markdown')!;
  assert.equal(markdown.text.text,'문서 Markdown 다시 받기');assert.equal(markdown.value,'synthetic-card');assert.equal(markdown.url,undefined);
  const complete=documentMessage(card({images:Array.from({length:10},(_,index)=>({page:index+1,fileId:'FIMAGE'+(index+1),shared:true}))}),origin);
  assert.equal(buttons(complete).some(button=>button.action_id==='rhwp_more_pages'),false);
  assert.match(JSON.stringify(complete.blocks),/앞 10페이지를 표시/);
});

test('D-HWP Home explains conversion for ordinary members without exposing administrator controls',async()=>{
  const api=new FakeApi(),settings=new Settings({...config,adminIds:new Set(['UTEST'])},api);
  await settings.home('TTEST','UOTHER');
  const home=api.calls.find(call=>call.method==='views.publish')!;
  const value=JSON.stringify(home.args);
  for(const expected of ['D-HWP','PDF 열기','PNG 이미지 (앞 10쪽)','문서 Markdown (ZIP)','형식·쪽 선택','TXT','PNG ZIP','최대 10쪽','동국 한글문서 변환','/dhwp md','문서 편집 (RHWP)'])assert.ok(value.includes(expected),expected);
  assert.ok(!value.includes('rhwp_settings'));assert.ok(!value.includes('CPRIVATE'));
  assert.match(value,/Markdown ZIP/);
});

test('new Slack manifest uses the distinct dhwp command and conversion shortcut without extra channel-history scopes',()=>{
  const manifest=JSON.parse(readFileSync('slack/manifest.json','utf8'));
  assert.equal(manifest.display_information.name,'D-HWP 동국 한글문서 도우미');
  assert.deepEqual(manifest.features.slash_commands.map((entry:{command:string})=>entry.command),['/dhwp']);
  assert.equal(manifest.features.shortcuts[0].name,'동국 한글문서 변환');
  assert.equal(manifest.features.shortcuts[0].callback_id,'rhwp_open_document');
  for(const description of [manifest.display_information.description,manifest.features.slash_commands[0].description,manifest.features.shortcuts[0].description]){
    assert.ok(description.length<=80);assert.match(description,/TXT/);assert.match(description,/ZIP/);
  }
  assert.ok(manifest.oauth_config.scopes.bot.includes('files:write'));
  assert.ok(manifest.oauth_config.scopes.bot.every((scope:string)=>!scope.endsWith(':history')));
});
