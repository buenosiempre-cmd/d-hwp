import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import init, {HwpDocument} from '@rhwp/core';
import {convertMarkdown, convertPdf, convertPageImages, closeConversionRuntime, MAX_MARKDOWN_BYTES} from '../../src/conversion/convert.mjs';
import {markdownFromUnicode} from '../../src/conversion/markdown.mjs';
import {readFrames, OutputError} from '../../src/conversion/frames.mjs';

test('text-based Markdown preserves paragraphs and literal syntax without active HTML or links', () => {
  const source = '# 원문 제목\r\n<img src="https://example.invalid/x"> &amp;\r\n'
    + '[링크](https://example.invalid) ![그림](x)\nhttps://example.invalid/a user@example.invalid\n'
    + '*** _강조_ | 표 | `코드` \\ 경로\n    1. 들여쓰기\n\t+ 탭\n\n마지막 한글 😀';
  const markdown = markdownFromUnicode(JSON.stringify(source)).toString('utf8');
  assert.ok(markdown.startsWith('# 문서 텍스트\n\n>'));
  assert.ok(markdown.includes('텍스트 기반 Markdown'));
  assert.ok(markdown.includes('셀 병합·열 구조'));
  assert.ok(markdown.includes('OCR하지 않았습니다'));
  const body = markdown.split('\n\n').slice(2).join('\n\n');
  assert.equal(body, '\\# 원문 제목  \n&lt;img src\\=\\"https\\:\\/\\/example\\.invalid\\/x\\"&gt; &amp;amp\\;  \n'
    + '\\[링크\\]\\(https\\:\\/\\/example\\.invalid\\) \\!\\[그림\\]\\(x\\)  \nhttps\\:\\/\\/example\\.invalid\\/a user\\@example\\.invalid  \n'
    + '\\*\\*\\* \\_강조\\_ \\| 표 \\| \\`코드\\` \\\\ 경로  \n&#32;&#32;&#32;&#32;1\\. 들여쓰기  \n&#9;\\+ 탭  \n  \n마지막 한글 😀\n');
  assert.doesNotMatch(body, /<img|https:\/\/|!\[|\n#{1,6} |\n {4}|\n\t/);
});

test('empty text is disclosed; malformed extraction and byte/escape expansion limits never truncate', () => {
  assert.match(markdownFromUnicode('""').toString(), /추출된 텍스트가 없습니다/);
  for (const value of [null, '{secret', '{}', '[]', 'null', '12']) {
    assert.throws(() => markdownFromUnicode(value), error => error.reason === 'conversion_error' && !error.message.includes('secret'));
  }
  const overhead = markdownFromUnicode('"a"').length - 1;
  const payload = MAX_MARKDOWN_BYTES - overhead;
  const exact = '가'.repeat(Math.floor(payload / 3)) + 'a'.repeat(payload % 3);
  assert.equal(markdownFromUnicode(JSON.stringify(exact)).length, MAX_MARKDOWN_BYTES);
  for (const text of [exact + 'a', 'a'.repeat(MAX_MARKDOWN_BYTES + 1), '*'.repeat(MAX_MARKDOWN_BYTES / 2)]) {
    assert.throws(() => markdownFromUnicode(JSON.stringify(text)), error => error.reason === 'markdown_size');
  }
});

const frame = (value, bytes = Buffer.alloc(0)) => {
  const json = Buffer.from(JSON.stringify(value)), length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, bytes]);
};
const info = () => frame({type: 'document', pageCount: 1});
const end = () => frame({type: 'end'});
const md = bytes => frame({type: 'markdown', bytes: bytes.length}, bytes);
const consume = bytes => readFrames(Readable.from([bytes]), 'markdown', 0, 0);

test('Markdown frames require bounded UTF-8 bytes, the right artifact and a complete end frame', async () => {
  const text = Buffer.from('# 합성 문서\n\n원문 😀\n');
  const wire = Buffer.concat([info(), md(text), end()]);
  // Deliberately split JSON lengths and multibyte Korean text across chunks.
  const fragmented = Readable.from(Array.from(wire, byte => Buffer.from([byte])));
  assert.deepEqual(await readFrames(fragmented, 'markdown', 0, 0), text);
  for (const body of [
    Buffer.concat([info(), frame({type: 'markdown', bytes: MAX_MARKDOWN_BYTES + 1})]),
    Buffer.concat([info(), frame({type: 'markdown', bytes: 0}), end()]),
    Buffer.concat([info(), frame({type: 'pdf', bytes: text.length}, text), end()]),
    Buffer.concat([info(), md(Buffer.from([0xff, 0xfe])), end()]),
    Buffer.concat([info(), md(text)]),
    Buffer.concat([info(), md(text), end(), Buffer.from('unframed document')]),
  ]) await assert.rejects(consume(body), OutputError);
});

for (const format of ['hwp', 'hwpx']) test(`real ${format} Markdown contains document and table text, with no PDF/image callbacks`, async () => {
  const bytes = await readFile(`tests/fixtures/viewer-two-pages.${format}`);
  const events = [];
  const markdown = (await convertMarkdown(bytes, {onPdf: () => events.push('pdf'), onPage: () => events.push('png')})).toString('utf8');
  for (const text of ['한글 문서 미리보기', '첫 번째 페이지', '항목', '내용', '상태', '정상', '두 번째 페이지', '마지막 페이지', 'English 123', '초록색 사각형']) assert.ok(markdown.includes(text), text);
  assert.ok(markdown.indexOf('항목') < markdown.indexOf('두 번째 페이지'), 'table cell text must retain its source order');
  assert.deepEqual(events, []);
  assert.ok(Buffer.byteLength(markdown) <= MAX_MARKDOWN_BYTES);
});

test('real engine preserves hostile literal text in ordinary escaped Markdown for both formats', async () => {
  await init({module_or_path: await readFile('node_modules/@rhwp/core/rhwp_bg.wasm')});
  const doc = HwpDocument.createEmpty();
  const text = '# 합성 <script>alert(1)</script> ![외부그림](https://example.invalid/x) `코드` & 원문';
  try {
    doc.createBlankDocument();
    assert.notEqual(JSON.parse(doc.insertText(0, 0, 0, text)).ok, false);
    for (const bytes of [doc.exportHwp(), doc.exportHwpx()]) {
      const markdown = (await convertMarkdown(bytes)).toString();
      assert.ok(markdown.includes('\\# 합성 &lt;script&gt;alert\\(1\\)&lt;\\/script&gt;'));
      assert.ok(markdown.includes('\\!\\[외부그림\\]\\(https\\:\\/\\/example\\.invalid\\/x\\)'));
      assert.ok(markdown.includes('\\`코드\\` &amp; 원문'));
      assert.doesNotMatch(markdown, /<script>|!\[외부그림\]|https:\/\//);
    }
  } finally { doc.free(); }
});

test('Markdown cancellation and malformed input discard runtime; later Markdown, PDF and PNG still work', async () => {
  await closeConversionRuntime();
  const bytes = await readFile('tests/fixtures/viewer-two-pages.hwp');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(convertMarkdown(bytes, {signal: controller.signal}), error => error.code === 'conversion_aborted');
  await assert.rejects(convertMarkdown(bytes, {timeoutMs: 1}), error => error.code === 'conversion_timeout');
  await assert.rejects(convertMarkdown(Buffer.from('not a document')));
  assert.match((await convertMarkdown(bytes)).toString(), /한글 문서 미리보기/);
  assert.equal((await convertPdf(bytes)).subarray(0, 5).toString(), '%PDF-');
  const images = await convertPageImages(bytes, {start: 2, end: 2});
  assert.deepEqual(images.pages.map(page => page.page), [2]);
  assert.equal(images.pages[0].png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await closeConversionRuntime();
});
