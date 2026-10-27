import {expect, test, type Page} from '@playwright/test';
import {build} from 'esbuild';
import type {RulesReply} from '../../src/shared/rules';
import type {renderRulesReply} from '../../src/assistant/rules-view';

type Success = Extract<RulesReply, {ok: true}>;
interface ViewWindow extends Window {
  RulesView: {renderRulesReply: typeof renderRulesReply};
  rendered: ReturnType<typeof renderRulesReply>;
}
const checkedAt = '2026-10-28T02:00:00.000Z';
const url = 'https://rule.example.invalid/view?SEQ=123&SEQ_HISTORY=456';
// Authored synthetic contents following dongguk-rule-mcp src/index.js's hContent,
// hApplicableRule, and lookupFinanceRules outcomes. No live regulations are fixtures.
function finance(rules: unknown[]): Success {
  return {ok: true, operation: 'finance', tool: 'review_finance_case', checkedAt, data: {
    evidence_status: 'partial', review: {status: 'requires_review'}, rules,
    rule_coverage: {status: 'partial'}, applicability: 'requires_review',
  }};
}
function wrapped(tool: string, data: Record<string, unknown>, article = '제3조') {
  return {structuredContent: {ok: true, tool, data}, requested_reference: {keyword: '합성 여비규정', article}};
}
let bundle: string;
test.beforeAll(async () => {
  const compiled = await build({entryPoints: ['src/assistant/rules-view.ts'], bundle: true, write: false, format: 'iife', globalName: 'RulesView'});
  bundle = compiled.outputFiles[0].text;
});
test.beforeEach(async ({page}) => {
  await page.setContent('<main id="results"></main>');
  await page.addScriptTag({content: bundle});
});
async function render(page: Page, reply: Success) {
  await page.evaluate(value => {
    const host = window as unknown as ViewWindow;
    host.rendered = host.RulesView.renderRulesReply(document.querySelector('#results') as HTMLElement, value);
  }, reply);
}
async function evidence(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse((window as unknown as ViewWindow).rendered.evidence!));
}

test('finance applicable_rule exposes the article, historical identity and enforcement caveat', async ({page}) => {
  const reply = finance([wrapped('applicable_rule', {
    lawId: 123, title: '합성 여비규정', targetDate: '2026-03-01',
    applied: {historyId: 456, revisedAt: '2026-01-01'},
    enforcement: {dates: ['2026-04-01'], latest: '2026-04-01', afterTarget: true},
    basis: '개정일', applicability: 'requires_enforcement_review',
    caveat: '개정일 기준 후보입니다. 시행일과 경과조치를 확인하세요.',
    articles: [{article: '제3조', content: '합성 조문: 출장 전에 출장명령과 적용 기준을 확인한다.'}],
    source: {url, returnedAt: checkedAt},
  })]);
  await render(page, reply);
  const card = page.locator('.d-hwp-rules__card');
  await expect(card).toContainText('합성 조문: 출장 전에 출장명령과 적용 기준을 확인한다.');
  await expect(card).toContainText('개정본 번호: 456');
  await expect(card).toContainText('개정일: 2026-01-01');
  await expect(card).toContainText('요청 기준일: 2026-03-01');
  await expect(card).toContainText('부칙의 명시 시행일: 2026-04-01');
  await expect(card).toContainText('확인된 시행일이 요청 기준일 이후입니다.');
  await expect(card).toContainText('시점 확인 한계: 개정일 기준 후보입니다. 시행일과 경과조치를 확인하세요.');
  await expect(card.locator('a')).toHaveAttribute('href', url);
  await expect(page.getByText(/본문이 포함되지|본문을 확보하지/)).toHaveCount(0);
  expect((await evidence(page)).data).toEqual(reply.data);
});

test('finance get_rule_content renders article text or the contentMarkdown fallback without duplicates', async ({page}) => {
  const reply = finance([
    wrapped('get_rule_content', {lawId: 123, historyId: 456, title: '합성 여비규정', revisedAt: '2026-01-01',
      articles: [{article: '제3조', content: '선택한 합성 조문 내용'}], contentMarkdown: '선택한 합성 조문 내용', source: {url, returnedAt: checkedAt}}),
    wrapped('get_rule_content', {lawId: 124, historyId: 457, title: '합성 출장규정', revisedAt: '2026-02-01',
      articles: [], contentMarkdown: '조문 필터가 없는 합성 본문 내용', source: {url: 'https://rule.example.invalid/124'}}, ''),
  ]);
  await render(page, reply);
  await expect(page.getByText('선택한 합성 조문 내용', {exact: true})).toHaveCount(1);
  await expect(page.getByText('조문 필터가 없는 합성 본문 내용', {exact: true})).toBeVisible();
  await expect(page.locator('.d-hwp-rules__card').first()).toContainText('개정본 번호: 456');
  await expect(page.locator('.d-hwp-rules__card').last()).toContainText('개정본 번호: 457');
  await expect(page.getByText(/본문이 포함되지|본문을 확보하지/)).toHaveCount(0);
  expect((await evidence(page)).data).toEqual(reply.data);
});

test('nested failure remains visible beside valid finance evidence without exposing raw error messages', async ({page}) => {
  const reply = finance([
    {structuredContent: {ok: false, tool: 'applicable_rule', error: {code: 'AMBIGUOUS_ARTICLE', message: 'RAW_ERROR_SENTINEL should stay within structured evidence'}},
      requested_reference: {keyword: '합성 여비규정', article: '제1조'}},
    wrapped('get_rule_content', {lawId: 123, historyId: 456, title: '합성 여비규정 제3조', articles: [{article: '제3조', content: '확인한 별도의 합성 조문'}], source: {url}}),
  ]);
  await render(page, reply);
  const failed = page.locator('.d-hwp-rules__card').first();
  await expect(failed).toContainText('합성 여비규정 제1조');
  await expect(failed).toContainText('AMBIGUOUS_ARTICLE');
  await expect(failed).toContainText('부칙과 원문 위치 확인 필요');
  await expect(failed).toContainText('이 요청의 규정 근거를 확보하지 못했습니다.');
  await expect(page.getByText('확인한 별도의 합성 조문', {exact: true})).toBeVisible();
  await expect(page.getByText(/RAW_ERROR_SENTINEL/)).toHaveCount(0);
  expect((await evidence(page)).data).toEqual(reply.data);
});

test('nested lookup rules still expose partial coverage and their source', async ({page}) => {
  const reply = finance([wrapped('lookup_dongguk_rule', {rules: [{lawId: 123, historyId: 456, title: '합성 여비규정',
    evidenceStatus: 'partial', incompleteReasons: ['EXCERPT_BLOCK_LIMIT'], sourceUrl: url,
    excerpt: {text: '범위를 줄인 합성 발췌', truncated: true}}]})]);
  await render(page, reply);
  await expect(page.locator('.d-hwp-rules__card')).toContainText('범위를 줄인 합성 발췌');
  await expect(page.locator('.d-hwp-rules__card')).toContainText('일부 조회');
  await expect(page.locator('.d-hwp-rules__card')).toContainText('EXCERPT_BLOCK_LIMIT');
  await expect(page.locator('.d-hwp-rules__card a')).toHaveAttribute('href', url);
  expect((await evidence(page)).data).toEqual(reply.data);
});

test('citation rule metadata is not mistaken for a missing-body evidence card', async ({page}) => {
  const reply: Success = {ok: true, operation: 'citations', tool: 'verify_rule_citations', checkedAt, data: {
    summary: {total: 1, verified: 0, exists: 0, notFound: 1, needsReview: 0, floating: 0},
    citations: [{raw: '「합성 여비규정」 제999조', status: 'NOT_FOUND', note: '제999조 없음', rule: {lawId: 123, historyId: 456, revisedAt: '2026-01-01'}}],
    rules: [{key: '합성여비규정', status: 'ok', lawId: 123, historyId: 456, title: '합성 여비규정', revisedAt: '2026-01-01'}],
    truncated: {citations: 0, rules: 0}, source: {url},
  }};
  await render(page, reply);
  await expect(page.locator('.d-hwp-rules__card')).toHaveCount(1);
  await expect(page.locator('.d-hwp-rules__card')).toContainText('제999조 없음');
  await expect(page.getByText(/본문이 포함되지|본문을 확보하지/)).toHaveCount(0);
  expect((await evidence(page)).data).toEqual(reply.data);
});
