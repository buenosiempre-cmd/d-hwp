import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand,parseFileLink,HELP} from '../../src/server/commands';
import {loadConfig} from '../../src/server/config';
import {Selections,candidatesFrom,selectionView} from '../../src/server/shortcuts';
import {config,actor} from './support';
test('command aliases preserve conversion and editing intent with Korean Slack file links',()=>{
  const link='https://rhwp-test.slack.com/files/UTEST/FTEST/'+encodeURIComponent('업무보고.hwp');
  for(const [cmd,mode] of [['open','open'],['edit','open'],['pdf','pdf'],['png','png'],['md','markdown'],['markdown','markdown']])assert.deepEqual(parseCommand(`${cmd} <${link}|업무 보고.hwp>`,config.workspaceHost),{kind:'prepare',mode,fileId:'FTEST'});
  assert.deepEqual(parseCommand('',config.workspaceHost),{kind:'help'});
  assert.deepEqual(parseCommand('help',config.workspaceHost),{kind:'help'});
  assert.match(HELP,/D-HWP/);assert.match(HELP,/\/dhwp png.*앞 10쪽/);assert.match(HELP,/\/dhwp md.*원문/);
  assert.match(HELP,/편집본은 새 파일로 저장/);
  for(const text of ['png x --page 3','thumbnail x','open','unknown x','help extra'])assert.throws(()=>parseCommand(text,config.workspaceHost));
});
test('file links reject foreign hosts, messages, credentials, ports and ambiguous paths',()=>{
  for(const link of [
    'https://rhwp-test.slack.com.evil.invalid/files/UTEST/FTEST/a.hwp',
    'https://other.slack.com/files/UTEST/FTEST/a.hwp',
    'http://rhwp-test.slack.com/files/UTEST/FTEST/a.hwp',
    'https://rhwp-test.slack.com:123/files/UTEST/FTEST/a.hwp',
    'https://x@rhwp-test.slack.com/files/UTEST/FTEST/a.hwp',
    'https://rhwp-test.slack.com/archives/CTEST/p123',
    'https://rhwp-test.slack.com/files/UTEST/%46TEST/a.hwp',
    'https://rhwp-test.slack.com/files/UTEST/FTEST/%2e%2e',
    'https://rhwp-test.slack.com/files/UTEST/FTEST/a%2fb.hwp',
    'https://rhwp-test.slack.com/files/UTEST/FTEST/a.hwp?x=1',
    'https://rhwp-test.slack.com/files/UTEST/FTEST/a.hwp#secret',
  ])assert.throws(()=>parseFileLink(link,config.workspaceHost),link);
});
test('configuration rejects missing/invalid settings without printing secret values',()=>{
  assert.throws(()=>loadConfig({}),/APP_ORIGIN/);
  assert.throws(()=>loadConfig({SLACK_CHANNEL_IDS:'bad'}),/SLACK_CHANNEL_IDS/);
  assert.throws(()=>loadConfig({SLACK_CHANNEL_IDS:'CTEST',SLACK_SIGNING_SECRET:'private-value'}),e=>e instanceof Error&&!e.message.includes('private-value'));
  const result=loadConfig({APP_ORIGIN:'https://editor.example.com',SLACK_CHANNEL_IDS:'CTEST, CPRIVATE',SLACK_SIGNING_SECRET:'a'.repeat(32),SLACK_BOT_TOKEN:'xoxb-test',SLACK_TEAM_ID:'TTEST',SLACK_APP_ID:'ATEST',SLACK_WORKSPACE_HOST:'rhwp-test.slack.com'});
  assert.equal(result.channelIds.size,2);assert.equal(result.port,3000);assert.equal(result.host,'127.0.0.1');
  const invited=loadConfig({APP_ORIGIN:'https://editor.example.com',SLACK_CHANNEL_IDS:'',SLACK_SIGNING_SECRET:'a'.repeat(32),SLACK_BOT_TOKEN:'xoxb-test',SLACK_TEAM_ID:'TTEST',SLACK_APP_ID:'ATEST',SLACK_WORKSPACE_HOST:'rhwp-test.slack.com'});
  assert.equal(invited.channelIds.size,0);
  assert.throws(()=>loadConfig({HOST:'untrusted-host',SLACK_CHANNEL_IDS:'CTEST'}),/HOST/);
});
test('selection binds user, workspace and exact candidates, then expires',()=>{
  let now=0;const store=new Selections(()=>now,10);
  const files=candidatesFrom([{id:'FTEST',name:'a.hwp'},{id:'FOTHER',name:'<@UTEST>.hwpx'},{id:'FXLS',name:'a.xlsx'}]);
  const id=store.create(actor,files);
  for(const [team,user,file] of [['TOTHER','UTEST','FTEST'],['TTEST','UOTHER','FTEST'],['TTEST','UTEST','FXLS']])assert.throws(()=>store.get(id,team,user,file));
  assert.deepEqual(store.get(id,'TTEST','UTEST','FTEST'),actor);
  const view=selectionView(id,files);
  assert.equal(view.blocks[0].element.options[1].text.type,'plain_text');
  assert.equal(view.title.text,'동국 한글문서 변환');assert.equal(view.blocks[0].label.text,'변환할 한글 문서');
  store.delete(id);assert.throws(()=>store.get(id,'TTEST','UTEST','FTEST'));
  const expired=store.create(actor,files);now=11;assert.throws(()=>store.get(expired,'TTEST','UTEST','FTEST'));
});
