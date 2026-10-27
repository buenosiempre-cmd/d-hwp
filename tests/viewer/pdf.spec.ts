import {test, expect} from '@playwright/test';
import {readFileSync, writeFileSync} from 'node:fs';

for (const extension of ['hwp', 'hwpx']) {
  test(`${extension}: server PDF snapshot and legacy link open the source directly in Studio`, async ({page, request}) => {
    const source = readFileSync(`tests/fixtures/viewer-two-pages.${extension}`);
    const created = await request.post('/api/dev/documents', {
      headers: {Origin: 'http://127.0.0.1:4173', 'X-Document-Name': `viewer-two-pages.${extension}`},
      data: source, timeout: 65_000,
    });
    expect(created.status()).toBe(201);
    const {id} = await created.json();
    const pdfResponse = await request.get(`/api/dev/documents/${id}/pdf`);
    expect(pdfResponse.headers()['content-type']).toBe('application/pdf');
    const pdf = await pdfResponse.body();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    writeFileSync(`test-results/preview-${extension}.pdf`, pdf);
    // Old shared entry URLs preserve their fragment through the redirect, then consume it.
    await page.goto(`/viewer/#document=${id}`);
    await expect(page).toHaveTitle(`viewer-two-pages.${extension} · D-HWP`, {timeout:60_000});
    expect(new URL(page.url()).pathname).toBe('/editor/');
    expect(await page.evaluate(() => location.hash)).toBe('');
    expect(await page.evaluate(() => window.__studio.pageCount())).toBe(2);
    expect(await page.evaluate(() => window.__studio.hwpctrl.call('GetTextFile', ['TEXT', '']))).toContain('첫 번째 페이지');
    await expect(page.locator('#host, #pdf-canvas, #save')).toHaveCount(0);
    await expect(page.locator('#file')).toBeHidden();
    await page.evaluate(() => window.__studio.hwpctrl.call('SetTextFile', ['편집 중', 'TEXT', '']));
    await expect(page).toHaveTitle(`* viewer-two-pages.${extension} · D-HWP`);
    await expect(page.locator('#status')).toHaveText('저장하지 않은 변경 있음');
    // An unsaved edit cannot mutate the prepared original PDF.
    expect(await (await request.get(`/api/dev/documents/${id}/pdf`)).body()).toEqual(pdf);
    await page.setViewportSize({width:669, height:863});
    expect(await page.locator('#editor iframe').boundingBox()).toMatchObject({x:0, y:0, width:669, height:863});
    await page.screenshot({path:`test-results/editor-full-${extension}.png`});
  });
}

test('direct editor uses full height, dev tools are opt-in, and dirty state survives without a header', async ({page}) => {
  await page.setViewportSize({width:400, height:800});
  await page.goto('/viewer/');
  await page.waitForFunction(() => Boolean(window.__studio));
  await expect(page.locator('#local')).toBeHidden();
  await page.goto('/viewer/?devtools=1');
  await expect(page.locator('#file')).toBeVisible();
  const conversions: string[] = [];
  page.on('request', r => {if (r.url().includes('/api/dev/documents')) conversions.push(r.url());});
  const name = '21868765_별표2_보건소_분장사무_매우긴문서이름_'.repeat(5) + '.hwp';
  await page.locator('#file').setInputFiles({name, mimeType:'application/octet-stream', buffer:readFileSync('tests/fixtures/viewer-two-pages.hwp')});
  await expect(page).toHaveTitle(`${name} · D-HWP`);
  await expect(page.locator('#local')).toBeHidden();
  expect(await page.locator('#editor iframe').boundingBox()).toMatchObject({x:0, y:0, width:400, height:800});
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
  expect(conversions).toEqual([]); // Editor entry does not wait for PDF generation.
  await page.evaluate(() => window.postMessage({type:'rhwp-slack:dirty', dirty:true}, location.origin));
  await expect(page).toHaveTitle(`${name} · D-HWP`);
  const ui = page.frameLocator('#editor iframe');
  const input = ui.getByLabel('문서 편집 입력', {exact:true});
  await input.focus(); await input.pressSequentially('Edit ');
  await expect(page).toHaveTitle(`* ${name} · D-HWP`);
  await expect(page.locator('#status')).toHaveText('저장하지 않은 변경 있음');
  expect(await page.evaluate(() => window.__studio.getDocumentState())).toMatchObject({dirty:true});
  await page.screenshot({path:'test-results/editor-long-name.png'});
});

test('conversion and expired-ticket errors remain explicit without a PDF UI or production dev API', async ({page, request}) => {
  const failed = await request.post('/api/dev/documents', {
    headers:{Origin:'http://127.0.0.1:4173'}, data:Buffer.from([80,75,3,4,0]), timeout:65_000,
  });
  expect(failed.status()).toBe(422);
  expect((await failed.json()).error).toContain('PDF를 만들지 못했습니다.');
  expect((await request.post('http://127.0.0.1:4174/api/dev/documents', {data:'test'})).status()).toBe(404);
  expect((await request.post('/api/dev/documents', {data:'test', headers:{Origin:'https://other.invalid'}})).status()).toBe(403);
  expect((await request.get('/viewer/pdfjs/LICENSE')).status()).toBe(404);
  expect((await request.get('/viewer/assets/pdf-reader.js')).status()).toBe(404);
  await page.goto('/editor/#document=00000000-0000-0000-0000-000000000000');
  await expect(page.locator('#status')).toContainText('문서가 만료', {timeout:60_000});
  await expect(page.locator('body')).toHaveAttribute('data-state', 'error');
  await expect(page.locator('#notice')).toBeInViewport();
  await page.screenshot({path:'test-results/editor-expired.png'});
});
