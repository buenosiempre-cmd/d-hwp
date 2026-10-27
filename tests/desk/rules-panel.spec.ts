import {expect, test, type Page} from '@playwright/test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import type {AssistantOptions, AssistantPanel} from '../../src/assistant/panel';
import type {RulesReply, RulesRequest} from '../../src/shared/rules';

// Synthetic, non-private examples following dongguk-rule-mcp's citations.js,
// index.js lookup outcome, and finance-desk.js contracts. No live MCP is called.
const checkedAt = '2026-10-28T02:00:00.000Z';
const sourceUrl = 'https://rule.example.invalid/rule/123';
const citationText = '「합성 업무규정」 제5조에 따라 검토합니다.';
function citationReply(status = 'EXISTS', overrides: Record<string, unknown> = {}): RulesReply {
  const verified = status === 'EXISTS';
  const missing = status === 'NOT_FOUND';
  return {ok: true, operation: 'citations', tool: 'verify_rule_citations', checkedAt, data: {
    summary: {verified: verified ? 1 : 0, exists: verified ? 1 : 0, notFound: missing ? 1 : 0, needsReview: !verified && !missing ? 1 : 0, total: 1, floating: 0},
    citations: [{raw: '「합성 업무규정」 제5조', ruleName: '합성 업무규정', article: '제5조', status,
      symbol: verified ? '✓' : missing ? '✗' : '⚠',
      note: verified ? '제5조(합성 근거) 실존' : missing ? '제5조 없음 (합성 본칙 범위: 제1조~제4조)' : '규정 하나를 확정할 수 없음 — 공식 규정명과 캠퍼스 확인 필요',
      rule: {lawId: 123, historyId: 456, title: '합성 업무규정', revisedAt: '2026-01-01'}}],
    floating: [], rules: [], truncated: {citations: 0, rules: 0}, basis: '각 규정의 최신 개정본 기준',
    source: {name: '합성 규정 출처', url: sourceUrl, returnedAt: checkedAt}, ...overrides,
  }};
}
const partialLookup: RulesReply = {ok: true, operation: 'lookup', tool: 'lookup_dongguk_rule', checkedAt, data: {
  evidenceStatus: 'partial', identityStatus: 'candidate_preview',
  rules: [{lawId: 123, historyId: 456, title: '합성 업무규정', sourceUrl, sourceType: '원문 HWP',
    evidenceStatus: 'partial', incompleteReasons: ['EXCERPT_BLOCK_LIMIT'],
    excerpt: {text: '합성 규정의 일부 근거입니다.', truncated: true, omittedBlockCount: 1, blocksTruncated: true, charactersTruncated: false}}],
}};
const financeReply: RulesReply = {ok: true, operation: 'finance', tool: 'review_finance_case', checkedAt, data: {
  context: {missing_facts: [{key: 'base_date', label: '거래 기준일을 확인해 주세요'}, {key: 'accounting_unit', label: '어느 회계의 업무인가요'}],
    questions: [{key: 'base_date', label: '거래 기준일을 확인해 주세요'}, {key: 'accounting_unit', label: '어느 회계의 업무인가요'}], remaining_question_count: 0},
  evidence_status: 'needs_input', review: {status: 'needs_input', findings: ['거래 조건이 부족하여 적정 여부와 계정을 확정하지 않았습니다.'], questions: []},
  applicability: 'not_determined', external_action_state: 'none',
}};

interface RulesHarness {
  panel: AssistantPanel;
  calls: {request: RulesRequest; aborted: boolean}[];
  reply: RulesReply;
  requestMode: 'resolved' | 'pending' | 'reject';
  resolveRules(reply?: RulesReply): void;
  currentMode: 'current' | 'stale' | 'pending' | 'reject';
  currentChecks: number;
  resolveCurrent(current: boolean): void;
  readMode: 'resolved' | 'pending';
  resolveRead(value: {text: string; name: string}): void;
  copied: string[];
  downloads: {name: string; blob: Blob}[];
}
interface RulesWindow extends Window {
  PanelBundle: {mountAssistant(container: HTMLElement, options: AssistantOptions): AssistantPanel};
  rulesHarness: RulesHarness;
}
let bundle: string;
let css: string;
let deskBundle: string;
let deskHtml: string;
test.beforeAll(async () => {
  const [result, desk, html] = await Promise.all([
    build({entryPoints: ['src/assistant/panel.ts'], bundle: true, write: false, format: 'iife', globalName: 'PanelBundle', loader: {'.css': 'empty'}}),
    build({entryPoints: ['src/desk/main.ts'], bundle: true, write: false, format: 'iife', loader: {'.css': 'empty'}, define: {__STUDIO_BASE__: JSON.stringify('/unused-studio/')}}),
    readFile('src/desk/index.html', 'utf8'),
  ]);
  bundle = result.outputFiles[0].text;
  deskBundle = desk.outputFiles[0].text;
  deskHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  css = await readFile('src/assistant/panel.css', 'utf8');
});
test.beforeEach(async ({page}) => {
  await page.setContent('<main id="panel"></main>');
  await page.addStyleTag({content: css});
  await page.addScriptTag({content: bundle});
  await page.evaluate(({reply, text}) => {
    const host = window as unknown as RulesWindow;
    const harness: RulesHarness = {
      panel: undefined as unknown as AssistantPanel, calls: [], reply, requestMode: 'resolved', resolveRules: () => {},
      currentMode: 'current', currentChecks: 0, resolveCurrent: () => {}, copied: [], downloads: [],
      readMode: 'resolved', resolveRead: () => {},
    };
    host.rulesHarness = harness;
    Object.defineProperty(navigator, 'clipboard', {configurable: true, value: {writeText: async (value: string) => { harness.copied.push(value); }}});
    const blobs = new Map<string, Blob>();
    URL.createObjectURL = (blob: Blob | MediaSource) => { const url = `blob:rules-harness-${blobs.size}`; blobs.set(url, blob as Blob); return url; };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function () { const blob = blobs.get(this.href); if (blob) harness.downloads.push({name: this.download, blob}); };
    harness.panel = host.PanelBundle.mountAssistant(document.querySelector('#panel') as HTMLElement, {
      readDocument: () => harness.readMode === 'pending'
        ? new Promise(resolve => { harness.resolveRead = resolve; })
        : Promise.resolve({text, name: '합성문서.hwpx'}),
      isDocumentCurrent: () => {
        harness.currentChecks++;
        if (harness.currentMode === 'pending') return new Promise(resolve => { harness.resolveCurrent = resolve; });
        if (harness.currentMode === 'reject') return Promise.reject(new Error('문서 상태 확인 실패'));
        return Promise.resolve(harness.currentMode === 'current');
      },
      rulesClient: (request, signal) => {
        const call = {request: structuredClone(request), aborted: signal?.aborted ?? false};
        harness.calls.push(call);
        signal?.addEventListener('abort', () => { call.aborted = true; });
        if (harness.requestMode === 'pending') return new Promise(resolve => { harness.resolveRules = value => resolve(value ?? harness.reply); });
        if (harness.requestMode === 'reject') return Promise.reject(new Error('합성 연결 실패'));
        return Promise.resolve(harness.reply);
      },
    });
  }, {reply: citationReply(), text: citationText});
});

const source = (page: Page) => page.getByLabel('문서 내용', {exact: true});
const preview = (page: Page) => page.getByLabel('AI 요청문 미리보기', {exact: true});
const consent = (page: Page) => page.getByLabel('위 내용을 규정 MCP로 전송하는 데 동의합니다', {exact: true});
const runRules = (page: Page) => page.getByRole('button', {name: '규정 검토 실행', exact: true});
const include = (page: Page) => page.getByLabel('이 근거를 요청문에 포함', {exact: true});
const generate = (page: Page) => page.getByRole('button', {name: 'AI 요청문 만들기', exact: true});
async function setReply(page: Page, reply: RulesReply): Promise<void> {
  await page.evaluate(value => { (window as unknown as RulesWindow).rulesHarness.reply = value; }, reply);
}
async function runCitation(page: Page, imported = false): Promise<void> {
  if (imported) await page.getByRole('button', {name: '문서 전체 가져오기', exact: true}).click();
  else await source(page).fill(citationText);
  await expect(source(page)).toHaveValue(citationText);
  await consent(page).check();
  await runRules(page).click();
}
async function calls(page: Page) {
  return page.evaluate(() => (window as unknown as RulesWindow).rulesHarness.calls);
}
function promptEvidence(prompt: string): Record<string, unknown> | undefined {
  const match = prompt.match(/```json\n([\s\S]*?)\n```/);
  expect(match, 'generated prompt has its reference JSON').not.toBeNull();
  const reference = JSON.parse(match![1]) as {evidence?: string};
  return reference.evidence === undefined ? undefined : JSON.parse(reference.evidence) as Record<string, unknown>;
}

test('document data is sent only after explicit scope consent and click', async ({page}) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await source(page).fill(citationText);
  await expect(runRules(page)).toBeDisabled();
  expect(await page.getByLabel('전송할 내용 확인', {exact: true}).inputValue()).toContain(citationText);
  expect(await calls(page)).toEqual([]);
  await consent(page).check();
  expect(await calls(page)).toEqual([]);
  await runRules(page).click();
  await expect.poll(() => calls(page)).toHaveLength(1);
  expect((await calls(page))[0].request).toMatchObject({operation: 'citations', text: citationText});
  expect(requests).toEqual([]);
  await expect(page.getByText('제5조(합성 근거) 실존', {exact: false})).toBeVisible();
  await expect(page.locator(`a[href="${sourceUrl}"]`).first()).toBeVisible();
});

test('connection check sends no document text', async ({page}) => {
  await source(page).fill('연결 확인에 보내지 않을 문서 내용');
  await setReply(page, {ok: true, operation: 'status', tool: 'get_service_info', checkedAt, data: {name: '합성 규정 서비스', version: '0.12.0'}});
  await page.getByRole('button', {name: '규정 MCP 연결 확인', exact: true}).click();
  await expect.poll(() => calls(page)).toHaveLength(1);
  expect((await calls(page))[0].request).toEqual({operation: 'status'});
});

test('a completed deferred import clears consent given for the previous text', async ({page}) => {
  const previous = '이전에 붙여넣은 합성 문서';
  const imported = '「새 합성규정」 제2조에 관한 가져온 문서';
  await source(page).fill(previous);
  await page.evaluate(() => { (window as unknown as RulesWindow).rulesHarness.readMode = 'pending'; });
  await page.getByRole('button', {name: '문서 전체 가져오기', exact: true}).click();
  await expect(page.getByLabel('전송할 내용 확인', {exact: true})).toHaveValue(new RegExp(previous));
  await consent(page).check();
  await expect(consent(page)).toBeChecked();
  await page.evaluate(text => { (window as unknown as RulesWindow).rulesHarness.resolveRead({text, name: '새합성문서.hwpx'}); }, imported);
  await expect(source(page)).toHaveValue(imported);
  await expect(consent(page)).not.toBeChecked();
  await expect(runRules(page)).toBeDisabled();
  expect(await calls(page)).toEqual([]);
  await consent(page).check();
  await runRules(page).click();
  await expect.poll(() => calls(page)).toHaveLength(1);
  expect((await calls(page))[0].request).toMatchObject({operation: 'citations', text: imported});
});

for (const [status, expected] of [['EXISTS', '제5조(합성 근거) 실존'], ['NOT_FOUND', '제5조 없음'], ['RULE_AMBIGUOUS', '규정 하나를 확정할 수 없음']] as const) {
  test(`citation result preserves ${status} and is not treated as approval`, async ({page}) => {
    await setReply(page, citationReply(status));
    await runCitation(page);
    await expect(page.getByText(expected, {exact: false})).toBeVisible();
    await include(page).check();
    await generate(page).click();
    await expect(preview(page)).toHaveValue(new RegExp(status));
    expect(promptEvidence(await preview(page).inputValue())).toMatchObject({tool: 'verify_rule_citations', data: {citations: [{status}]}});
    if (status !== 'EXISTS') expect(await preview(page).inputValue()).not.toContain('지급 승인 완료');
  });
}

test('truncated citation coverage is visible and retained in evidence', async ({page}) => {
  await setReply(page, citationReply('EXISTS', {truncated: {citations: 2, rules: 1}}));
  await runCitation(page);
  await expect(page.getByText(/미검증|생략|일부|상한/).last()).toBeVisible();
  await include(page).check();
  await generate(page).click();
  expect(promptEvidence(await preview(page).inputValue())).toMatchObject({data: {truncated: {citations: 2, rules: 1}}});
});

test('no citation found is an unsuccessful lookup and clears previous evidence', async ({page}) => {
  await runCitation(page);
  await include(page).check();
  await generate(page).click();
  await expect(preview(page)).toHaveValue(/verify_rule_citations/);
  await source(page).fill('규정명이나 조문을 인용하지 않은 합성 문장입니다.');
  await setReply(page, {ok: false, error: {code: 'NOT_FOUND', message: '텍스트에서 규정 인용을 찾지 못했습니다.'}});
  await consent(page).check();
  await runRules(page).click();
  await expect(page.getByText('텍스트에서 규정 인용을 찾지 못했습니다.', {exact: false})).toBeVisible();
  await expect(preview(page)).toHaveValue('');
  await expect(include(page)).not.toBeChecked();
  await generate(page).click();
  expect(await preview(page).inputValue()).not.toContain('verify_rule_citations');
});

test('lookup keeps partial evidence and distinguishes ambiguous rule errors', async ({page}) => {
  await page.getByLabel('규정 검토 방식', {exact: true}).selectOption('lookup');
  await page.getByLabel('규정 검색·검토 질문', {exact: true}).fill('합성 업무규정 제5조');
  await setReply(page, partialLookup);
  await consent(page).check();
  await runRules(page).click();
  await expect(page.getByText('합성 규정의 일부 근거입니다.', {exact: false})).toBeVisible();
  await expect(page.getByText(/partial|일부/).last()).toBeVisible();
  await page.getByLabel('규정 검색·검토 질문', {exact: true}).fill('합성 규정');
  await setReply(page, {ok: false, error: {code: 'AMBIGUOUS_RULE', message: '여러 규정 후보가 있습니다. 제목과 적용범위를 확인하세요.'}});
  await consent(page).check();
  await runRules(page).click();
  await expect(page.getByText('여러 규정 후보가 있습니다. 제목과 적용범위를 확인하세요.', {exact: false})).toBeVisible();
  await expect(page.getByText('합성 규정의 일부 근거입니다.', {exact: false})).toHaveCount(0);
});

test('untrusted rule text is literal and unsafe source URLs never become active links', async ({page}) => {
  await setReply(page, citationReply('EXISTS', {source: {name: '<img src=x onerror="alert(1)"> 합성 출처', url: 'javascript:alert(1)', returnedAt: checkedAt},
    citations: [{raw: '합성 인용', ruleName: '<svg onload="alert(1)">', article: '제5조', status: 'EXISTS', symbol: '✓', note: '<img src=x onerror="alert(1)"> 합성 원문'}]}));
  await runCitation(page);
  await expect(page.getByText('<img src=x onerror="alert(1)"> 합성 원문', {exact: false}).first()).toBeVisible();
  await expect(page.locator('#panel img, #panel svg, #panel iframe')).toHaveCount(0);
  await expect(page.locator('#panel a[href^="javascript:"], #panel a[href^="data:"]')).toHaveCount(0);
});

test('opted-in evidence is included in the displayed, copied and downloaded request', async ({page}) => {
  await runCitation(page);
  await generate(page).click();
  expect(promptEvidence(await preview(page).inputValue())).toBeUndefined();
  await include(page).check();
  await expect(preview(page)).toHaveValue('');
  await generate(page).click();
  const text = await preview(page).inputValue();
  expect(text).toContain('verify_rule_citations');
  expect(text).toContain(sourceUrl);
  expect(text).toContain(checkedAt);
  expect(promptEvidence(text)).toMatchObject({tool: 'verify_rule_citations', checkedAt, data: {source: {url: sourceUrl}}});
  await page.getByRole('button', {name: '요청문 복사', exact: true}).click();
  await page.getByRole('button', {name: 'Markdown 저장', exact: true}).click();
  expect(await page.evaluate(() => (window as unknown as RulesWindow).rulesHarness.copied)).toEqual([text]);
  expect(await page.evaluate(async () => Promise.all((window as unknown as RulesWindow).rulesHarness.downloads.map(download => download.blob.text())))).toEqual([text]);
});

for (const mutation of ['source', 'context', 'name', 'task', 'clear', 'destroy', 'document'] as const) {
  test(`a pending rules request is aborted and cannot restore evidence after ${mutation}`, async ({page}) => {
    await page.evaluate(() => { (window as unknown as RulesWindow).rulesHarness.requestMode = 'pending'; });
    await runCitation(page, true);
    await expect.poll(() => calls(page)).toHaveLength(1);
    if (mutation === 'source') await source(page).fill('새 문서 내용');
    if (mutation === 'context') await page.getByLabel('업무 배경·추가 요청 (선택)', {exact: true}).fill('새로운 검토 목적');
    if (mutation === 'name') await page.getByLabel('문서명 (선택)', {exact: true}).fill('새문서.hwpx');
    if (mutation === 'task') await page.getByLabel('검토 업무', {exact: true}).selectOption('finance');
    if (mutation === 'clear' || mutation === 'destroy') await page.evaluate(value => (window as unknown as RulesWindow).rulesHarness.panel[value](), mutation);
    if (mutation === 'document') await page.evaluate(() => (window as unknown as RulesWindow).rulesHarness.panel.notifyDocumentChanged());
    await expect.poll(async () => (await calls(page))[0].aborted).toBe(true);
    await page.evaluate(() => (window as unknown as RulesWindow).rulesHarness.resolveRules());
    if (mutation === 'destroy') await expect(page.locator('.d-hwp-assistant')).toHaveCount(0);
    else {
      await expect(preview(page)).toHaveValue('');
      await expect(consent(page)).not.toBeChecked();
      await expect(page.getByText('제5조(합성 근거) 실존', {exact: false})).toHaveCount(0);
    }
  });
}

test('stale imported document is rejected before contacting MCP', async ({page}) => {
  await page.getByRole('button', {name: '문서 전체 가져오기', exact: true}).click();
  await expect(source(page)).toHaveValue(citationText);
  await page.evaluate(() => { (window as unknown as RulesWindow).rulesHarness.currentMode = 'stale'; });
  await consent(page).check();
  await runRules(page).click();
  await expect(page.getByText('문서 변경됨 · 다시 가져오기 필요', {exact: true})).toBeVisible();
  expect(await calls(page)).toEqual([]);
});

test('document is checked again after the MCP response and changed text discards the result', async ({page}) => {
  await page.evaluate(() => { (window as unknown as RulesWindow).rulesHarness.requestMode = 'pending'; });
  await runCitation(page, true);
  await expect.poll(() => calls(page)).toHaveLength(1);
  await page.evaluate(() => { const h = (window as unknown as RulesWindow).rulesHarness; h.currentMode = 'stale'; h.resolveRules(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as RulesWindow).rulesHarness.currentChecks)).toBeGreaterThanOrEqual(2);
  await expect(page.getByText('제5조(합성 근거) 실존', {exact: false})).toHaveCount(0);
  await expect(preview(page)).toHaveValue('');
});

test('clearing during the pre-request document check prevents the later network action', async ({page}) => {
  await page.getByRole('button', {name: '문서 전체 가져오기', exact: true}).click();
  await expect(source(page)).toHaveValue(citationText);
  await page.evaluate(() => { (window as unknown as RulesWindow).rulesHarness.currentMode = 'pending'; });
  await consent(page).check();
  await runRules(page).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as RulesWindow).rulesHarness.currentChecks)).toBeGreaterThan(0);
  await page.evaluate(() => { const h = (window as unknown as RulesWindow).rulesHarness; h.panel.clear(); h.resolveCurrent(true); });
  await expect(source(page)).toHaveValue('');
  expect(await calls(page)).toEqual([]);
});

test('finance missing facts require user input and only confirmed answers are resent', async ({page}) => {
  await page.getByLabel('규정 검토 방식', {exact: true}).selectOption('finance');
  await page.getByLabel('규정 검색·검토 질문', {exact: true}).fill('합성 비용 처리 검토');
  await setReply(page, financeReply);
  await consent(page).check();
  await runRules(page).click();
  await expect(page.getByText('거래 조건이 부족하여 적정 여부와 계정을 확정하지 않았습니다.', {exact: false})).toBeVisible();
  await expect(page.getByText('거래 기준일을 확인해 주세요', {exact: true}).first()).toBeVisible();
  await expect(page.getByText('어느 회계의 업무인가요', {exact: true}).first()).toBeVisible();
  const date = page.getByLabel('거래·검토 기준일', {exact: true});
  const unit = page.getByLabel('회계 구분', {exact: true});
  await expect(date).toHaveValue('');
  await expect(unit).toHaveValue('');
  await date.fill('2026-10-28');
  await unit.fill('교비회계');
  await expect(consent(page)).not.toBeChecked();
  await consent(page).check();
  await runRules(page).click();
  await expect.poll(() => calls(page)).toHaveLength(2);
  expect((await calls(page))[1].request).toMatchObject({operation: 'finance', facts: {base_date: '2026-10-28', accounting_unit: '교비회계'}});
});

test('oversized citation text is retained for editing and is never silently sent in part', async ({page}) => {
  const large = '가'.repeat(20_001);
  await source(page).fill(large);
  await expect(runRules(page)).toBeDisabled();
  await expect(source(page)).toHaveValue(large);
  expect(await calls(page)).toEqual([]);
  await expect(page.getByText(/20,000/).last()).toBeVisible();
});

test('finance sends document text only through a separate explicit opt-in', async ({page}) => {
  await source(page).fill(citationText);
  await page.getByLabel('규정 검토 방식', {exact: true}).selectOption('finance');
  await page.getByLabel('규정 검색·검토 질문', {exact: true}).fill('합성 비용 처리 검토');
  await setReply(page, financeReply);
  const includeText = page.getByLabel('문서 내용도 함께 전송', {exact: true});
  await expect(includeText).not.toBeChecked();
  expect(await page.getByLabel('전송할 내용 확인', {exact: true}).inputValue()).not.toContain(citationText);
  await consent(page).check();
  await runRules(page).click();
  await expect.poll(() => calls(page)).toHaveLength(1);
  expect((await calls(page))[0].request).toEqual({operation: 'finance', query: '합성 비용 처리 검토'});
  await includeText.check();
  await expect(consent(page)).not.toBeChecked();
  expect(await page.getByLabel('전송할 내용 확인', {exact: true}).inputValue()).toContain(citationText);
  await consent(page).check();
  await runRules(page).click();
  await expect.poll(() => calls(page)).toHaveLength(2);
  expect((await calls(page))[1].request).toEqual({operation: 'finance', query: '합성 비용 처리 검토', text: citationText});
});

test('finance fact limit preserves the input and refuses sending an overlong answer', async ({page}) => {
  await page.getByLabel('규정 검토 방식', {exact: true}).selectOption('finance');
  await page.getByLabel('규정 검색·검토 질문', {exact: true}).fill('합성 비용 처리 검토');
  const fact = page.getByLabel('회계 구분', {exact: true});
  const value = '가'.repeat(121);
  await fact.fill(value);
  await consent(page).check();
  await expect(runRules(page)).toBeDisabled();
  await expect(fact).toHaveValue(value);
  await expect(page.locator('.d-hwp-rules__validation')).toContainText('120자 이하');
  expect(await calls(page)).toEqual([]);
});

test('the real desk entry mounts the rules panel and calls its same-origin API only after consent', async ({page}) => {
  const sent: {method: string; type: string | undefined; body: RulesRequest}[] = [];
  const unexpected: string[] = [];
  await page.route('http://127.0.0.1:4175/**', async route => {
    const request = route.request();
    if (request.url() === 'http://127.0.0.1:4175/desk/') {
      await route.fulfill({status: 200, contentType: 'text/html', body: deskHtml});
    } else if (request.url() === 'http://127.0.0.1:4175/api/assistant/rules') {
      sent.push({method: request.method(), type: request.headers()['content-type'], body: request.postDataJSON() as RulesRequest});
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(citationReply())});
    } else {
      unexpected.push(request.url());
      await route.abort();
    }
  });
  await page.goto('http://127.0.0.1:4175/desk/');
  await page.addScriptTag({content: deskBundle});
  await expect(page.getByRole('heading', {name: 'D-HWP 동국 한글문서 도우미'})).toBeVisible();
  await source(page).fill(citationText);
  expect(sent).toEqual([]);
  await expect(runRules(page)).toBeDisabled();
  await consent(page).check();
  expect(sent).toEqual([]);
  await runRules(page).click();
  await expect(page.getByText('제5조(합성 근거) 실존', {exact: false})).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({method: 'POST', type: 'application/json', body: {operation: 'citations', text: citationText}});
  expect(unexpected).toEqual([]);
  await include(page).check();
  await generate(page).click();
  expect(promptEvidence(await preview(page).inputValue())).toMatchObject({tool: 'verify_rule_citations', checkedAt});
});
