import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EditorApi, editorServer} from './editor-support';
import {actor,bytes} from './support';
import {writeArchive} from '../../src/conversion/archive.mjs';
import type {Card} from '../../src/server/documents';

const markdown = Buffer.from('# 합성 문서\n\n재시작 검사용 본문\n');
const report = {schemaVersion:1};
const zip = writeArchive([{name:'document.md',bytes:markdown},{name:'report.json',bytes:Buffer.from(JSON.stringify(report))},{name:'source/original.hwp',bytes}]);
const markdownPackage = {markdown,zip,report};
const isMarkdown = (api: EditorApi, id: unknown) => String(api.files.get(String(id))?.name).endsWith('_Markdown.zip');
const allocations = (api: EditorApi) => api.calls.filter(call => call.method === 'files.getUploadURLExternal' && String(call.args.filename).endsWith('_Markdown.zip'));
const completions = (api: EditorApi) => api.calls.filter(call => call.method === 'files.completeUploadExternal'
  && isMarkdown(api, (call.args.files as {id: string}[])[0].id));

test('lost Markdown completion response reconciles the same file and concurrent callers do not duplicate it', async () => {
  const api = new EditorApi();
  let converted = 0, streamed = 0;
  api.handler = async (method, args) => {
    const result = api.response(method, args);
    if (method === 'files.completeUploadExternal' && isMarkdown(api, (args.files as {id: string}[])[0].id)) {
      throw new Error('Synthetic completion response was lost');
    }
    return result;
  };
  const server = await editorServer({api, markdown: async () => { converted++; return markdownPackage; }, fetcher: async (url) => {
    if (isMarkdown(api, String(url).split('/').at(-1))) streamed++;
    return new Response('ok');
  }});
  try {
    const id = await server.prepare(); await server.documents!.pdf.idle();
    const card = await server.documents!.authorize(id, actor);
    const exportFile = () => server.documents!.exportMarkdown(id, actor, card.messageTs!);
    const [first, second] = await Promise.all([exportFile(), exportFile()]);
    assert.equal(first.id, second.id);
    assert.equal((await exportFile()).id, first.id);
    assert.equal(converted, 1);
    assert.equal(streamed, 1);
    assert.equal(allocations(api).length, 1);
    assert.equal(completions(api).length, 1);
    assert.equal(completions(api)[0].args.channel_id, actor.channelId);
    assert.equal(completions(api)[0].args.thread_ts, card.messageTs);
    assert.equal((await server.documents!.authorize(id, actor)).exports?.['markdown-v2']?.attempt?.saved, true);
  } finally { await server.stop(); }
});

test('an uncertain Markdown command survives restart and recovers one original file without uploading or completing twice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dhwp-markdown-recovery-'));
  const statePath = join(directory, 'state.sqlite');
  const api = new EditorApi();
  let visible = false, converted = 0, streamed = 0;
  api.handler = async (method, args) => {
    const result = api.response(method, args);
    if (method === 'files.completeUploadExternal' && isMarkdown(api, (args.files as {id: string}[])[0].id)) {
      throw new Error('Synthetic completion response was lost');
    }
    if (method === 'files.info' && isMarkdown(api, args.file) && !visible) {
      // The remote completion succeeded, but its channel-share receipt is not
      // visible yet. Keep the original file and later expose its real receipt.
      return {...result, file: {...result.file as Record<string, unknown>, shares: {}}};
    }
    return result;
  };
  const options = {api, statePath, markdown: async () => { converted++; return markdownPackage; }, fetcher: async (url: Parameters<typeof fetch>[0]) => {
    if (isMarkdown(api, String(url).split('/').at(-1))) streamed++;
    return new Response('ok');
  }};
  let server: Awaited<ReturnType<typeof editorServer>> | undefined;
  try {
    server = await editorServer(options); await server.ready;
    const {id} = server.preparations.submit({...actor, threadTs: '100.001'}, 'FTEST', 'markdown', 'synthetic-md-command');
    await server.preparations.idle(); await server.documents!.pdf.idle();
    const before = server.state!.get<Card>('cards', id)!;
    const attempt = before.exports?.['markdown-v2']?.attempt;
    const originalFileId = attempt?.fileId;
    assert.ok(originalFileId);
    assert.equal(before.requestedMode, 'markdown');
    assert.equal(attempt?.streamed, true);
    assert.equal(attempt?.completing, true);
    assert.notEqual(attempt?.saved, true);
    assert.equal(attempt?.url, undefined);
    assert.equal(allocations(api).length, 1);
    assert.equal(completions(api).length, 1);
    assert.equal(streamed, 1);
    assert.ok(api.calls.some(call => call.method === 'chat.postEphemeral' && String(call.args.text).includes('저장 결과를 확인 중')));
    const persisted = JSON.stringify(server.state!.all('cards'));
    assert.ok(!persisted.includes('/upload/v1/'));
    assert.ok(!persisted.includes('재시작 검사용 본문'));
    const posts = api.calls.filter(call => call.method === 'chat.postMessage').length;
    await server.stop(); server = undefined;

    visible = true;
    server = await editorServer(options); await server.ready;
    const recovered = await server.documents!.authorize(id, actor);
    assert.equal(recovered.exports?.['markdown-v2']?.fileId, originalFileId);
    assert.equal(recovered.exports?.['markdown-v2']?.attempt?.saved, true);
    assert.equal(recovered.markdownFileId, undefined);
    assert.equal(recovered.requestedMode, 'markdown');
    assert.equal(allocations(api).length, 1, 'restart must reuse the remotely completed file ID');
    assert.equal(completions(api).length, 1, 'an uncertain completion must never be issued again');
    assert.equal(streamed, 1, 'already streamed bytes must not be transmitted again');
    assert.equal(completions(api)[0].args.thread_ts, '100.001');
    assert.equal(api.calls.filter(call => call.method === 'chat.postMessage').length, posts);
    const saved = await server.documents!.exportMarkdown(id, actor, recovered.messageTs!);
    assert.equal(saved.id, originalFileId);
    assert.equal(converted, 2, 'the receipt recovery may regenerate bytes once; the ready receipt must then be reused');
    assert.equal(allocations(api).length, 1);
  } finally {
    await server?.stop();
    await rm(directory, {recursive: true, force: true});
  }
});
