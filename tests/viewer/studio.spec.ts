import { test, expect, type Page } from '@playwright/test';
import type { RhwpEditor } from '@rhwp/editor';
import init, { HwpDocument } from '@rhwp/core';
import { readFileSync, writeFileSync } from 'node:fs';
declare global { interface Window { __studio: RhwpEditor; __loadDocument: (bytes: Uint8Array, name: string) => Promise<void>; __documentDbOpens: string[]; } }
const source = readFileSync('tests/fixtures/viewer-two-pages.hwp');
async function ready(page: Page) {
  await page.goto('/editor/');
  await page.waitForFunction(() => Boolean(window.__studio));
}
async function load(page: Page, extension = 'hwp') {
  await page.locator('#file').setInputFiles(`tests/fixtures/viewer-two-pages.${extension}`);
  await expect(page).toHaveTitle(/viewer-two-pages/, {timeout:60_000});
  expect(await page.evaluate(()=>window.__studio.pageCount())).toBe(2);
}
async function text(page: Page) {
  return page.evaluate(() => window.__studio.hwpctrl.call('GetTextFile', ['TEXT','']));
}
for (const extension of ['hwp','hwpx']) {
  test(`${extension}: Studio menu, real edit, undo/redo and export roundtrip`, async ({page}) => {
    const external: string[] = [];
    page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4173/')) external.push(request.url()); });
    await ready(page); await load(page,extension);
    const ui = page.frameLocator('#editor iframe');
    await expect(ui.locator('#menu-bar')).toBeVisible();
    await expect(ui.locator('#icon-toolbar')).toBeVisible();
    const commands = await page.evaluate(() => window.__studio.commands.list());
    for (const id of ['edit:undo','edit:redo','file:page-setup']) expect(commands.some(c=>c.id===id)).toBeTruthy();
    for (const id of ['file:open','file:save','edit:document-history','edit:compare-documents']) expect(commands.some(c=>c.id===id)).toBeFalsy();
    const before = await text(page);
    await page.evaluate(() => window.__studio.hwpctrl.call('SetTextFile', ['Slack 편집 검증', 'TEXT','']));
    const after = await text(page); expect(after).toContain('Slack 편집 검증'); expect(after).not.toEqual(before);
    expect(await page.evaluate(() => window.__studio.getDocumentState())).toMatchObject({dirty:true});
    await page.evaluate(() => window.__studio.hwpctrl.undo()); expect(await text(page)).toEqual(before);
    await page.evaluate(() => window.__studio.hwpctrl.redo()); expect(await text(page)).toEqual(after);
    const exported = await page.evaluate(async extension => Array.from(extension==='hwp' ? await window.__studio.exportHwp() : await window.__studio.exportHwpx()), extension);
    expect(exported.slice(0,4)).toEqual(extension==='hwp' ? [208,207,17,224] : [80,75,3,4]);
    // Export is not a host-save acknowledgement.
    expect(await page.evaluate(() => window.__studio.getDocumentState())).toMatchObject({dirty:true});
    page.on('dialog', dialog => dialog.accept());
    await page.evaluate(async ({bytes,extension}) => window.__studio.loadFile(new Uint8Array(bytes),'roundtrip.' + extension,{skipUnsavedGuard:true}), {bytes:exported,extension});
    expect(await text(page)).toEqual(after);
    expect(external).toEqual([]);
    await page.screenshot({path:`test-results/studio-${extension}.png`});
  });
}
test('document databases are never opened across edit, idle, settings and reload', async ({page}) => {
  await page.addInitScript(() => {
    window.__documentDbOpens=[];
    const open=IDBFactory.prototype.open;
    IDBFactory.prototype.open=function(name,version) { window.__documentDbOpens.push(name); return version===undefined?open.call(this,name):open.call(this,name,version); };
  });
  await ready(page);
  // Synthetic pre-existing recovery record and persisted settings, before Studio reload.
  await page.evaluate(async bytes => {
    localStorage.setItem('rhwp-settings',JSON.stringify({autosave:{recoveryEnabled:true,idleSaveEnabled:true,recoveryIntervalMinutes:1,idleDelaySeconds:1}}));
    await new Promise<void>((resolve,reject)=>{
      const request=indexedDB.open('rhwpStudioAutosave',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('drafts',{keyPath:'id'});
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{
        const db=request.result; const tx=db.transaction('drafts','readwrite');
        tx.objectStore('drafts').put({id:'old-draft',fileName:'이전문서.hwp',sourceFormat:'hwp',savedAt:Date.now(),byteLength:bytes.length,data:new Uint8Array(bytes).buffer});
        tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>reject(tx.error);
      };
    });
  }, Array.from(source));
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__studio));
  expect(await page.evaluate(()=>window.__studio.pageCount())).toBe(0);
  await load(page);
  await page.evaluate(() => window.__studio.commands.execute('tool:options',{}, {allowDialog:true}));
  const ui=page.frameLocator('#editor iframe');
  await ui.locator('.dialog-tab[data-tab="file"]').click();
  await expect(ui.locator('.opt-desc').filter({hasText:'Slack에서는 복구본과 자동 저장을 사용하지 않습니다.'})).toBeVisible();
  for (const id of ['opt-recovery-enabled','opt-idle-save-enabled']) {
    await expect(ui.locator('#'+id)).not.toBeChecked(); await expect(ui.locator('#'+id)).toBeDisabled();
  }
  // Even an old saved preference or a programmatic setting change cannot enable disk writes.
  await ui.locator('#opt-recovery-enabled').evaluate((el: HTMLInputElement)=>{el.checked=true;});
  await ui.getByRole('button',{name:'확인',exact:true}).click();
  await page.evaluate(() => window.__studio.hwpctrl.call('SetTextFile',['기록 금지 검증','TEXT','']));
  await page.clock.install(); await page.clock.fastForward(11*60_000);
  const frame = page.frames().find(f=>f.url().includes('/studio/'))!;
  expect(await frame.evaluate(()=>window.__documentDbOpens.filter(n=>/Recent|Autosave|History/i.test(n)))).toEqual([]);
  expect((await frame.evaluate(()=>indexedDB.databases())).filter(d=>/Recent|Autosave|History/i.test(d.name??'')).map(d=>d.name)).toEqual(['rhwpStudioAutosave']);
  expect(await frame.evaluate(()=>navigator.serviceWorker.getRegistrations().then(r=>r.length))).toBe(0);
  await page.reload(); await page.waitForFunction(()=>Boolean(window.__studio));
  expect(await page.evaluate(()=>window.__studio.pageCount())).toBe(0);
  await expect(page.frameLocator('#editor iframe').locator('#recent-docs-panel')).toHaveCount(0);
});
test('real same-origin Slack sandbox permits nested Studio SDK',async ({page})=>{
  await page.goto('/sandbox');
  const host=page.frameLocator('iframe').first();
  await expect(host.locator('#status')).toContainText('Slack에서 문서 열기', {timeout:60_000});
  await host.locator('#file').setInputFiles('tests/fixtures/viewer-two-pages.hwp');
  await expect(host.locator('#editor iframe')).toHaveAttribute('title', /viewer-two-pages/);
  await expect(host.frameLocator('#editor iframe').locator('#menu-bar')).toBeVisible();
});
test('production excludes local file ingress; direct Studio forces embed and ignores URL file', async ({page})=>{
  await page.goto('http://127.0.0.1:4174/editor/?devtools=1');
  await expect(page.locator('#status')).toHaveText('Slack에서 문서 열기를 선택하세요.', {timeout:60_000});
  await expect(page.locator('#local')).toBeHidden();
  expect(await page.evaluate(()=>Object.hasOwn(window,'__studio'))).toBe(false);
  const requests: string[]=[]; page.on('request',r=>requests.push(r.url()));
  await page.goto('/studio/?chrome=full&url=https://example.invalid/private.hwp');
  await expect(page.locator('[data-cmd="file:open"]')).toHaveCount(0);
  expect(requests.some(url=>new URL(url).hostname==='example.invalid')).toBe(false);
});
test('invalid bytes are rejected by host before entering Studio',async ({page})=>{
  await ready(page);
  await page.locator('#file').setInputFiles({name:'bad.hwp',mimeType:'application/octet-stream',buffer:Buffer.from('bad')});
  await expect(page.locator('#status')).toContainText('HWP5 또는 HWPX');
  expect(await page.evaluate(()=>window.__studio.pageCount())).toBe(0);
});

test('keyboard, bold formatting and table creation use original Studio commands', async ({page})=>{
  await ready(page); await load(page);
  const ui=page.frameLocator('#editor iframe');
  const input=ui.getByLabel('문서 편집 입력',{exact:true});
  await input.focus(); await input.pressSequentially('Keyboard edit ');
  expect(await text(page)).toContain('Keyboard edit');
  await input.press('Shift+Home');
  const textBefore=await text(page);
  const svgBefore=await page.evaluate(()=>window.__studio.getPageSvg(0));
  await ui.locator('#btn-bold').click();
  const svgAfter=await page.evaluate(()=>window.__studio.getPageSvg(0));
  expect(svgAfter).not.toEqual(svgBefore);
  await page.evaluate(()=>window.__studio.hwpctrl.undo());
  expect(await text(page)).toEqual(textBefore);
  const restored=await page.evaluate(()=>window.__studio.getPageSvg(0));
  expect([...restored.matchAll(/font-weight="[^"]+"/g)].map(m=>m[0])).toEqual([...svgBefore.matchAll(/font-weight="[^"]+"/g)].map(m=>m[0]));
  await input.press('ArrowLeft');
  const beforeTable=await page.evaluate(()=>window.__studio.getPageSvg(0));
  await page.evaluate(()=>window.__studio.commands.execute('table:create',{}, {allowDialog:true}));
  await ui.getByText('표 만들기...', {exact:false}).click();
  await ui.getByRole('button',{name:'만들기',exact:true}).click();
  const afterTable=await page.evaluate(()=>window.__studio.getPageSvg(0));
  expect(afterTable).not.toEqual(beforeTable);
  await page.evaluate(()=>window.__studio.hwpctrl.undo());
  const restoredTable=await page.evaluate(()=>window.__studio.getPageSvg(0));
  expect([...restoredTable.matchAll(/<line /g)]).toHaveLength([...beforeTable.matchAll(/<line /g)].length);
  expect(await text(page)).toEqual(textBefore);
});
test('size, parser error and 201 page limits fail without acknowledging a save', async ({page})=>{
  await ready(page);
  const oversize=Buffer.alloc(20*1024*1024+1); oversize.set([80,75,3,4]);
  await page.locator('#file').setInputFiles({name:'huge.hwpx',mimeType:'application/octet-stream',buffer:oversize});
  await expect(page.locator('#status')).toContainText('20 MiB');
  await page.locator('#file').setInputFiles({name:'broken.hwpx',mimeType:'application/octet-stream',buffer:Buffer.from([80,75,3,4,0])});
  await expect(page.locator('#status')).not.toHaveText('문서를 여는 중입니다.');
  await load(page); // parser failure must allow a valid next document
  await init({module_or_path:readFileSync('node_modules/@rhwp/core/rhwp_bg.wasm')});
  const doc=HwpDocument.createEmpty(); doc.createBlankDocument();
  let para=0; for(let i=0;i<200;i++) para=JSON.parse(doc.insertPageBreak(0,para,0)).paraIdx;
  const bytes=Buffer.from(doc.exportHwp()); doc.free();
  await page.locator('#file').setInputFiles({name:'201-pages.hwp',mimeType:'application/octet-stream',buffer:bytes});
  await expect(page.locator('#status')).toContainText('200페이지 이하',{timeout:60_000});
  await expect(page.locator('#editor iframe')).toHaveCount(0);
});

test('mixed-format selection undo preserves formatting and SVG geometry',async ({page}, testInfo)=>{
  await ready(page); await load(page);
  const ui=page.frameLocator('#editor iframe');
  const input=ui.getByLabel('문서 편집 입력',{exact:true});
  await input.focus(); await input.pressSequentially('Keyboard edit ');
  await page.evaluate(()=>window.__studio.commands.execute('edit:select-all'));
  const before=await page.evaluate(()=>window.__studio.getPageSvg(0));
  writeFileSync(testInfo.outputPath('before.svg'),before);
  await ui.locator('#scroll-container').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:testInfo.outputPath('before.png')});
  await ui.locator('#btn-bold').click();
  await page.evaluate(()=>window.__studio.hwpctrl.undo());
  const after=await page.evaluate(()=>window.__studio.getPageSvg(0));
  writeFileSync(testInfo.outputPath('after-undo.svg'),after);
  await ui.locator('#scroll-container').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:testInfo.outputPath('after-undo.png')});
  expect(after===before, 'Undo changed SVG geometry; do not update a baseline to hide this.').toBe(true);
});
