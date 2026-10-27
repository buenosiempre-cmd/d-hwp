import {test, expect, type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import init, {HwpDocument} from '@rhwp/core';

const fixture = (format = 'hwp') => `tests/fixtures/viewer-two-pages.${format}`;
const sourceInput = (page: Page) => page.getByLabel('문서 내용', {exact: true});
const preview = (page: Page) => page.getByLabel('AI 요청문 미리보기', {exact: true});

async function open(page: Page, format = 'hwp'): Promise<void> {
  await page.locator('#file').setInputFiles(fixture(format));
  await expect(page.locator('#document-name')).toHaveText(`viewer-two-pages.${format}`, {timeout: 60_000});
  await expect(page.locator('#page-count')).toHaveText('2페이지');
  await expect(page.locator('#desk-editor iframe')).toBeVisible();
}

async function importText(page: Page): Promise<void> {
  await page.getByRole('button', {name: '문서 전체 가져오기', exact: true}).click();
  await expect(sourceInput(page)).toHaveValue(/한글 문서 미리보기/);
}

async function edit(page: Page, text: string): Promise<void> {
  const editor = page.frameLocator('#desk-editor iframe').getByLabel('문서 편집 입력', {exact: true});
  await editor.focus();
  await editor.press('ControlOrMeta+Home');
  await editor.pressSequentially(text);
  await expect(page.locator('body')).toHaveAttribute('data-dirty', 'true');
}

for (const format of ['hwp', 'hwpx']) {
  test(`${format}: local document, actual edit, prompt, clipboard and verified download roundtrip`, async ({page, context}, testInfo) => {
    const original = createHash('sha256').update(await readFile(fixture(format))).digest('hex');
    const requests: string[] = [];
    page.on('request', request => {
      if (/^https?:/.test(request.url()) && (!request.url().startsWith('http://127.0.0.1:4175/') || !['GET', 'HEAD'].includes(request.method()))) requests.push(`${request.method()} ${request.url()}`);
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/desk/');
    await open(page, format);
    await importText(page);
    await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
    await expect(preview(page)).toHaveValue(/한글 문서 미리보기/);
    await page.getByRole('button', {name: '요청문 복사', exact: true}).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('한글 문서 미리보기');
    const markdownDownload = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Markdown 저장', exact: true}).click();
    const markdown = await markdownDownload;
    expect(markdown.suggestedFilename()).toMatch(/\.md$/);
    expect(await readFile((await markdown.path())!, 'utf8')).toContain('한글 문서 미리보기');

    await edit(page, 'D-HWP local edit ');
    await expect(preview(page)).toHaveValue('');
    await importText(page);
    await expect(sourceInput(page)).toHaveValue(/D-HWP local edit/);
    await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
    await expect(preview(page)).toHaveValue(/D-HWP local edit/);

    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', {name: '현재 편집본 다운로드', exact: true}).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe(`viewer-two-pages_편집본.${format}`);
    const editedPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(editedPath);
    const bytes = await readFile(editedPath);
    expect(Array.from(bytes.subarray(0, 4))).toEqual(format === 'hwp' ? [208, 207, 17, 224] : [80, 75, 3, 4]);
    expect(createHash('sha256').update(bytes).digest('hex')).not.toBe(original);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#file').setInputFiles(editedPath);
    await expect(page.locator('#document-name')).toHaveText(download.suggestedFilename());
    await expect(sourceInput(page)).toHaveValue('');
    await importText(page);
    await expect(sourceInput(page)).toHaveValue(/D-HWP local edit/);
    expect(createHash('sha256').update(await readFile(fixture(format))).digest('hex')).toBe(original);
    expect(requests).toEqual([]);
    await page.screenshot({path: testInfo.outputPath(`desk-${format}.png`), fullPage: true});
  });
}

test('paste without a file, regenerate, then clear all fields', async ({page}) => {
  await page.goto('/desk/');
  await page.getByRole('button', {name: '문서 없이 텍스트로 시작하기'}).click();
  await expect(sourceInput(page)).toBeFocused();
  await sourceInput(page).fill('2026년 부서 업무개선 회의. 자료 제출 마감은 11월 5일입니다.');
  await page.getByLabel('문서명 (선택)', {exact: true}).fill('업무개선 회의');
  await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
  await expect(preview(page)).toHaveValue(/11월 5일/);
  await sourceInput(page).fill('수정한 문서');
  await expect(preview(page)).toHaveValue('');
  await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
  await expect(preview(page)).toHaveValue(/수정한 문서/);
  await page.getByRole('button', {name: '전체 초기화', exact: true}).click();
  await expect(sourceInput(page)).toHaveValue('');
  await expect(preview(page)).toHaveValue('');
  await expect(page.getByLabel('문서명 (선택)', {exact: true})).toHaveValue('');
  await expect(page.getByRole('button', {name: 'Markdown 저장', exact: true})).toBeDisabled();
});

test('further changes while already dirty invalidate imported text at generation time', async ({page}) => {
  await page.goto('/desk/');
  await open(page);
  await edit(page, 'First revision ');
  await importText(page);
  await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
  await expect(preview(page)).toHaveValue(/First revision/);
  await edit(page, 'Second revision ');
  await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
  await expect(preview(page)).toHaveValue('');
  await expect(page.locator('.d-hwp-assistant__source-state')).toContainText('다시 가져오기');
  await importText(page);
  await expect(sourceInput(page)).toHaveValue(/Second revision/);
  await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
  await expect(preview(page)).toHaveValue(/Second revision/);
});

test('discard guard preserves declined changes; closing and parser errors erase old document and AI text', async ({page}) => {
  await page.goto('/desk/');
  await open(page);
  await edit(page, 'Keep my changes ');
  await importText(page);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#file').setInputFiles(fixture('hwpx'));
  await expect(page.locator('#document-name')).toHaveText('viewer-two-pages.hwp');
  await expect(sourceInput(page)).toHaveValue(/Keep my changes/);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: '문서 닫기', exact: true}).click();
  await expect(page.locator('#desk-editor iframe')).toHaveCount(0);
  await expect(sourceInput(page)).toHaveValue('');
  await expect(preview(page)).toHaveValue('');
  await open(page);
  await importText(page);
  await page.locator('#file').setInputFiles({name: 'broken.hwpx', mimeType: 'application/octet-stream', buffer: Buffer.from([80, 75, 3, 4, 0])});
  await expect(page.locator('body')).toHaveAttribute('data-state', 'error', {timeout: 60_000});
  await expect(page.locator('#desk-editor iframe')).toHaveCount(0);
  await expect(sourceInput(page)).toHaveValue('');
  await expect(page.locator('#document-name')).toHaveText('열린 문서 없음');
  await open(page, 'hwpx');
});

test('closing during file reading cannot restore the late document or previous AI text', async ({page}) => {
  await page.addInitScript(() => {
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'slow.hwp') {
        await new Promise(resolve => setTimeout(resolve, 600));
        (window as unknown as Record<string, unknown>).__slowReadFinished = true;
      }
      return original.call(this);
    };
  });
  await page.goto('/desk/');
  await sourceInput(page).fill('이전 문서의 비공개 문장');
  await page.locator('#file').setInputFiles({name: 'slow.hwp', mimeType: 'application/octet-stream', buffer: await readFile(fixture())});
  await expect(page.locator('body')).toHaveAttribute('data-state', 'loading');
  await page.getByRole('button', {name: '문서 닫기', exact: true}).click();
  await page.waitForFunction(() => (window as unknown as Record<string, unknown>).__slowReadFinished === true);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'empty');
  await expect(page.locator('#desk-editor iframe')).toHaveCount(0);
  await expect(sourceInput(page)).toHaveValue('');
});

test('dirty events require both current iframe source and same origin', async ({page}) => {
  await page.goto('/desk/');
  await open(page);
  await importText(page);
  await page.evaluate(() => {
    const child = document.querySelector<HTMLIFrameElement>('#desk-editor iframe')!.contentWindow;
    window.dispatchEvent(new MessageEvent('message', {data: {type: 'rhwp-slack:dirty', dirty: true}, origin: location.origin, source: window}));
    window.dispatchEvent(new MessageEvent('message', {data: {type: 'rhwp-slack:dirty', dirty: true}, origin: 'https://example.invalid', source: child}));
  });
  await expect(page.locator('body')).toHaveAttribute('data-dirty', 'false');
  await expect(sourceInput(page)).toHaveValue(/한글 문서 미리보기/);
  await expect(page.locator('.d-hwp-assistant__source-state')).not.toContainText('다시 가져오기');
});

test('size and 201-page documents are rejected, then a valid document can open', async ({page}) => {
  await page.goto('/desk/');
  const huge = Buffer.alloc(20 * 1024 * 1024 + 1); huge.set([80, 75, 3, 4]);
  await page.locator('#file').setInputFiles({name: 'huge.hwpx', mimeType: 'application/octet-stream', buffer: huge});
  await expect(page.locator('#desk-status')).toContainText('20 MiB');
  await init({module_or_path: await readFile('node_modules/@rhwp/core/rhwp_bg.wasm')});
  const document = HwpDocument.createEmpty();
  let bytes: Buffer;
  try {
    document.createBlankDocument();
    let paragraph = 0;
    for (let i = 0; i < 200; i++) paragraph = JSON.parse(document.insertPageBreak(0, paragraph, 0)).paraIdx;
    bytes = Buffer.from(document.exportHwp());
  } finally { document.free(); }
  await page.locator('#file').setInputFiles({name: '201-pages.hwp', mimeType: 'application/octet-stream', buffer: bytes});
  await expect(page.locator('#desk-status')).toContainText('200페이지', {timeout: 60_000});
  await expect(page.locator('#desk-editor iframe')).toHaveCount(0);
  await open(page);
});

test('mobile tabs support open, extract, prompt, download and keyboard navigation without overflow', async ({page}, testInfo) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/desk/');
  await open(page, 'hwpx');
  await expect(page.locator('#assistant-pane')).toBeHidden();
  await page.getByRole('tab', {name: 'AI 업무 도우미', exact: true}).click();
  await expect(page.locator('#document-pane')).toBeHidden();
  await importText(page);
  await page.getByRole('button', {name: 'AI 요청문 만들기', exact: true}).click();
  await expect(preview(page)).toHaveValue(/한글 문서 미리보기/);
  const markdownEvent = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Markdown 저장', exact: true}).click();
  expect((await markdownEvent).suggestedFilename()).toMatch(/\.md$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: testInfo.outputPath('desk-mobile-assistant.png'), fullPage: true});
  await page.getByRole('button', {name: '전체 초기화', exact: true}).click();
  await expect(sourceInput(page)).toHaveValue('');
  await page.getByRole('tab', {name: 'AI 업무 도우미', exact: true}).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', {name: '문서 편집', exact: true})).toBeFocused();
  await expect(page.locator('#desk-editor iframe')).toBeVisible();
  const documentEvent = page.waitForEvent('download');
  await page.getByRole('button', {name: '현재 편집본 다운로드', exact: true}).click();
  expect((await documentEvent).suggestedFilename()).toBe('viewer-two-pages_편집본.hwpx');
  await page.getByRole('button', {name: '문서 닫기', exact: true}).click();
  await expect(page.locator('#desk-editor iframe')).toHaveCount(0);
});
