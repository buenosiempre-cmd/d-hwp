import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import type { AssistantOptions, AssistantPanel } from '../../src/assistant/panel';

interface Harness {
  panel: AssistantPanel;
  resolveRead(value: { text: string; name: string }): void;
  rejectRead(error: Error): void;
  resolveCurrent(value: boolean): void;
  mode: 'current' | 'stale' | 'pending' | 'fail';
  checks: number;
  copied: string[];
  downloads: string[];
}
interface HarnessWindow extends Window {
  PanelBundle: { mountAssistant(container: HTMLElement, options: AssistantOptions): AssistantPanel };
  harness: Harness;
}

let bundle: string;
let style: string;
test.beforeAll(async () => {
  const compiled = await build({ entryPoints: ['src/assistant/panel.ts'], bundle: true, write: false, format: 'iife', globalName: 'PanelBundle', loader: { '.css': 'empty' } });
  bundle = compiled.outputFiles[0].text;
  style = await readFile('src/assistant/panel.css', 'utf8');
});

test.beforeEach(async ({ page }) => {
  // A browser-only fixture; no test controls are included in the application build.
  await page.setContent('<main id="panel"></main>');
  await page.addStyleTag({ content: style });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const host = window as unknown as HarnessWindow;
    const harness: Harness = {
      panel: undefined as unknown as AssistantPanel,
      resolveRead: () => {}, rejectRead: () => {}, resolveCurrent: () => {},
      mode: 'current', checks: 0, copied: [], downloads: [],
    };
    host.harness = harness;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { harness.copied.push(text); },
    } });
    HTMLAnchorElement.prototype.click = function () { harness.downloads.push(this.download); };
    harness.panel = host.PanelBundle.mountAssistant(document.querySelector('#panel') as HTMLElement, {
      readDocument: () => new Promise((resolve, reject) => { harness.resolveRead = resolve; harness.rejectRead = reject; }),
      isDocumentCurrent: () => {
        harness.checks += 1;
        if (harness.mode === 'pending') return new Promise(resolve => { harness.resolveCurrent = resolve; });
        if (harness.mode === 'fail') return Promise.reject(new Error('revision unavailable'));
        return Promise.resolve(harness.mode === 'current');
      },
    });
  });
});

const source = (page: Page) => page.getByLabel('문서 내용', { exact: true });
const output = (page: Page) => page.getByLabel('AI 요청문 미리보기', { exact: true });
const generate = (page: Page) => page.getByRole('button', { name: 'AI 요청문 만들기', exact: true });

async function importSource(page: Page): Promise<void> {
  await page.getByRole('button', { name: '문서 전체 가져오기', exact: true }).click();
  await page.evaluate(() => (window as unknown as HarnessWindow).harness.resolveRead({ text: '검토할 문서 원문', name: '예시.hwpx' }));
  await expect(source(page)).toHaveValue('검토할 문서 원문');
}

test('manual input prepares literal text and every changed field invalidates the result', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await expect(generate(page)).toBeDisabled();
  await source(page).fill('<img src=x onerror="alert(1)"> 문서 원문');
  await generate(page).click();
  await expect(output(page)).toHaveValue(/문서 원문/);
  await expect(page.locator('img')).toHaveCount(0);
  await page.getByLabel('문서명 (선택)', { exact: true }).fill('새 문서.hwp');
  await expect(output(page)).toHaveValue('');
  await generate(page).click();
  await page.getByLabel('업무 배경·추가 요청 (선택)', { exact: true }).fill('회의 보고용');
  await expect(output(page)).toHaveValue('');
  await generate(page).click();
  await page.getByLabel('검토 업무', { exact: true }).selectOption('finance');
  await expect(output(page)).toHaveValue('');
  await generate(page).click();
  await source(page).fill('수정한 직접 입력');
  await expect(output(page)).toHaveValue('');
  expect(await page.evaluate(() => (window as unknown as HarnessWindow).harness.checks)).toBe(0);
  expect(requests).toEqual([]);
});

test('fits 360px viewport and rejects oversized input without truncating it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await source(page).fill('가'.repeat(60_001));
  await expect(generate(page)).toBeDisabled();
  await expect(source(page)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('status')).toContainText('60,000자 이하');
  expect((await source(page).inputValue()).length).toBe(60_001);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const operation of ['clear', 'destroy'] as const) {
  test(`a late import cannot restore private text after ${operation}`, async ({ page }) => {
    await page.getByRole('button', { name: '문서 전체 가져오기', exact: true }).click();
    await expect(page.getByRole('button', { name: '문서를 가져오는 중…' })).toBeDisabled();
    await page.evaluate(operation => (window as unknown as HarnessWindow).harness.panel[operation](), operation);
    await page.evaluate(() => (window as unknown as HarnessWindow).harness.resolveRead({ text: '늦게 도착한 개인정보', name: '과거문서.hwp' }));
    if (operation === 'clear') {
      await expect(source(page)).toHaveValue('');
      await expect(page.getByLabel('문서명 (선택)', { exact: true })).toHaveValue('');
    } else await expect(page.locator('.d-hwp-assistant')).toHaveCount(0);
  });
}

test('manual edits cancel a pending read and failed reads clear previous output', async ({ page }) => {
  await page.getByRole('button', { name: '문서 전체 가져오기', exact: true }).click();
  await source(page).fill('직접 선택한 텍스트');
  await page.evaluate(() => (window as unknown as HarnessWindow).harness.resolveRead({ text: '늦은 원문', name: '과거문서.hwp' }));
  await expect(source(page)).toHaveValue('직접 선택한 텍스트');
  await generate(page).click();
  await expect(output(page)).not.toHaveValue('');
  await page.getByRole('button', { name: '문서 전체 가져오기', exact: true }).click();
  await page.evaluate(() => (window as unknown as HarnessWindow).harness.rejectRead(new Error('가져오기 실패')));
  await expect(output(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: '요청문 복사', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('가져오기 실패');
});

test('document changes stale imported text while edited text becomes an independent input', async ({ page }) => {
  await importSource(page);
  await generate(page).click();
  await expect(output(page)).not.toHaveValue('');
  await page.evaluate(() => (window as unknown as HarnessWindow).harness.panel.notifyDocumentChanged());
  await expect(generate(page)).toBeDisabled();
  await expect(output(page)).toHaveValue('');
  await expect(page.getByText('문서 변경됨 · 다시 가져오기 필요', { exact: true })).toBeVisible();
  await source(page).fill('원문을 확인한 독립 텍스트');
  await page.evaluate(() => { (window as unknown as HarnessWindow).harness.mode = 'stale'; });
  await generate(page).click();
  await expect(output(page)).toHaveValue(/원문을 확인한 독립 텍스트/);
  await expect(page.getByText('직접 입력', { exact: true })).toBeVisible();
});

test('a rejected oversized import cannot pair previous text with the host new snapshot', async ({ page }) => {
  await importSource(page);
  await generate(page).click();
  await expect(output(page)).not.toHaveValue('');
  await page.getByRole('button', { name: '문서 전체 가져오기', exact: true }).click();
  await page.evaluate(() => {
    const harness = (window as unknown as HarnessWindow).harness;
    // The host reports its newly read snapshot as current, even though the panel rejects its text.
    harness.mode = 'current';
    harness.resolveRead({ text: '가'.repeat(60_001), name: '수정한 문서.hwpx' });
  });
  await expect(page.getByRole('status')).toContainText('60,000자를 초과');
  await expect(source(page)).toHaveValue('검토할 문서 원문');
  await expect(output(page)).toHaveValue('');
  await expect(generate(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: '요청문 복사', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Markdown 저장', exact: true })).toBeDisabled();
  await page.getByLabel('업무 배경·추가 요청 (선택)', { exact: true }).fill('새 추가 요청');
  await expect(generate(page)).toBeDisabled();
  await importSource(page);
  await generate(page).click();
  await expect(output(page)).toHaveValue(/검토할 문서 원문/);
});

const actions = ['AI 요청문 만들기', '요청문 복사', 'Markdown 저장'] as const;
for (const action of actions) {
  test(`${action} refuses imported text when the editor has changed without a dirty event`, async ({ page }) => {
    await importSource(page);
    if (action !== 'AI 요청문 만들기') {
      await generate(page).click();
      await expect(output(page)).not.toHaveValue('');
    }
    await page.evaluate(() => { (window as unknown as HarnessWindow).harness.mode = 'stale'; });
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(output(page)).toHaveValue('');
    await expect(generate(page)).toBeDisabled();
    expect(await page.evaluate(() => ({ copied: (window as unknown as HarnessWindow).harness.copied, downloads: (window as unknown as HarnessWindow).harness.downloads }))).toEqual({ copied: [], downloads: [] });
  });

  for (const mutation of ['clear', 'source', 'context', 'task', 'name', 'destroy'] as const) {
    test(`${action} cancels a pending revision check after ${mutation}`, async ({ page }) => {
      await importSource(page);
      if (action !== 'AI 요청문 만들기') {
        await generate(page).click();
        await expect(output(page)).not.toHaveValue('');
      }
      await page.evaluate(() => { (window as unknown as HarnessWindow).harness.mode = 'pending'; });
      await page.getByRole('button', { name: action, exact: true }).click();
      await expect(page.getByRole('status')).toContainText('일치하는지 확인');
      if (mutation === 'clear' || mutation === 'destroy') await page.evaluate(mutation => (window as unknown as HarnessWindow).harness.panel[mutation](), mutation);
      if (mutation === 'source') await source(page).fill('새 입력');
      if (mutation === 'context') await page.getByLabel('업무 배경·추가 요청 (선택)', { exact: true }).fill('바뀐 요청');
      if (mutation === 'task') await page.getByLabel('검토 업무', { exact: true }).selectOption('handover');
      if (mutation === 'name') await page.getByLabel('문서명 (선택)', { exact: true }).fill('바뀐 문서.hwp');
      await page.evaluate(() => (window as unknown as HarnessWindow).harness.resolveCurrent(true));
      if (mutation === 'destroy') await expect(page.locator('.d-hwp-assistant')).toHaveCount(0);
      else await expect(output(page)).toHaveValue('');
      expect(await page.evaluate(() => ({ copied: (window as unknown as HarnessWindow).harness.copied, downloads: (window as unknown as HarnessWindow).harness.downloads }))).toEqual({ copied: [], downloads: [] });
    });
  }
}

test('revision errors fail closed; successful copy and download use the displayed prompt', async ({ page }) => {
  await importSource(page);
  await page.evaluate(() => { (window as unknown as HarnessWindow).harness.mode = 'fail'; });
  await generate(page).click();
  await expect(output(page)).toHaveValue('');
  await expect(generate(page)).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('대조하지 못했습니다');
  await importSource(page);
  await page.evaluate(() => { (window as unknown as HarnessWindow).harness.mode = 'current'; });
  await generate(page).click();
  await expect(output(page)).not.toHaveValue('');
  const prompt = await output(page).inputValue();
  await page.getByRole('button', { name: '요청문 복사', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('복사했습니다');
  await page.getByRole('button', { name: 'Markdown 저장', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('저장을 요청했습니다');
  expect(await page.evaluate(() => ({ copied: (window as unknown as HarnessWindow).harness.copied, downloads: (window as unknown as HarnessWindow).harness.downloads }))).toEqual({ copied: [prompt], downloads: ['D-HWP_예시_검토요청.md'] });
});
