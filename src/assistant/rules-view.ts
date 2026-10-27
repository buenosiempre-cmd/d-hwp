import type { RulesReply } from '../shared/rules';
import { MAX_EVIDENCE_CHARS } from './workflows';

type Success = Extract<RulesReply, { ok: true }>;
type RecordValue = Record<string, unknown>;
export interface RuleQuestion { key: string; label: string }
export function record(value: unknown): RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
}
function entries(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, value = '', className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = value;
  if (className) result.className = className;
  return result;
}

export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

const statusLabels: Record<string, string> = {
  EXISTS: '조문 존재 확인 · 업무 적용은 별도 검토', RULE_EXISTS: '규정 존재 확인 · 조문 확인 필요',
  VERIFIED: '인용 대조됨 · 업무 적용은 별도 검토', NOT_FOUND: '인용 근거를 찾지 못함',
  RULE_NOT_FOUND: '규정을 찾지 못함', ARTICLE_NOT_FOUND: '조문을 찾지 못함',
  RULE_AMBIGUOUS: '규정 후보가 여러 개 · 선택 필요', TITLE_MISMATCH: '조문 제목 불일치',
  AMBIGUOUS_RULE: '규정 후보가 여러 개 · 규정명과 적용 범위 확인 필요',
  AMBIGUOUS_ARTICLE: '조문 후보가 여러 개 · 부칙과 원문 위치 확인 필요',
  CONTENT_UNAVAILABLE: '규정 본문 조회 불가 · 원문 확인 필요',
  UPSTREAM_UNAVAILABLE: '규정 서비스에 연결할 수 없음 · 다시 조회 필요',
  HANG_NOT_FOUND: '항 번호 확인 필요', NEEDS_REVIEW: '원문 대조 필요',
  partial: '일부 조회 · 추가 확인 필요', retrieved: '근거 조회됨 · 적용 검토 필요',
  needs_input: '추가 사실 확인 필요', requires_review: '담당자 검토 필요',
  requires_specialist_review: '별도 전문 검토 필요', scope_review_required: '적용 범위 확인 필요',
  unsupported: '지원 범위 밖 · 별도 조회 필요', unavailable: '조회 불가',
  not_requested: '조회하지 않음', not_required: '이 요청에서는 조회 대상 아님',
  no_match: '일치하는 근거 없음', not_found: '근거를 찾지 못함',
  not_determined: '적용 여부 미확정', requires_enforcement_review: '시행일·적용 범위 확인 필요',
  ambiguous: '후보 확인 필요', unknown: '확인되지 않음', ok: '조회 응답 있음 · 내용 검토 필요',
};
function statusLabel(value: unknown): string {
  const valueText = text(value);
  return statusLabels[valueText] ?? (valueText ? `상태 확인 필요 (${valueText})` : '상태 미확인');
}

function truncated(value: unknown, depth = 0): boolean {
  if (depth > 6 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => truncated(item, depth + 1));
  return Object.entries(record(value)).some(([key, item]) => {
    if (key === 'truncated') return item === true || Object.values(record(item)).some(count => typeof count === 'number' && count > 0);
    if (/omittedBlockCount|blocksTruncated|charactersTruncated/.test(key)) return item === true || typeof item === 'number' && item > 0;
    return truncated(item, depth + 1);
  });
}

interface RuleRecord { data: RecordValue; requested?: RecordValue; error?: RecordValue }
function ruleRecords(value: unknown, depth = 0): RuleRecord[] {
  if (depth > 4) return [];
  return entries(value).flatMap(item => {
    const current = record(item);
    if (!Object.hasOwn(current, 'structuredContent')) return [{ data: current }];
    const outcome = record(current.structuredContent);
    const requested = record(current.requested_reference);
    if (outcome.ok !== true || current.isError === true) return [{ data: {}, requested, error: record(outcome.error) }];
    const nested = record(outcome.data);
    // lookup_dongguk_rule returns data.rules; applicable_rule and get_rule_content
    // return the selected rule directly in data. Preserve failures as separate entries.
    if (Array.isArray(nested.rules)) return ruleRecords(nested.rules, depth + 1).map(entry => ({ ...entry, requested: entry.requested ?? requested }));
    return [{ data: nested, requested }];
  });
}

/** Render only known fields as text; the original response remains inside the evidence data boundary. */
export function renderRulesReply(container: HTMLElement, reply: Success): { evidence?: string; questions: RuleQuestion[] } {
  container.replaceChildren();
  const data = reply.data;
  const source = record(data.source);
  const context = record(data.context);
  const review = record(data.review);
  const rawStatus = data.evidence_status ?? data.evidenceStatus ?? review.status;
  const citations = entries(data.citations);
  const summary = record(data.summary);
  const hasTruncation = truncated(data);
  let status = reply.operation === 'citations' ? '인용 표현과 규정 원문 대조 결과' : statusLabel(rawStatus);
  if (reply.operation === 'citations' && (summary.total === 0 || !citations.length)) status = '인용 표현 없음 · 검사 범위를 확인하세요';
  if (hasTruncation) status += ' · 일부 결과 잘림';
  container.append(node('h4', status, 'd-hwp-rules__result-title'));
  container.append(node('p', '조회 결과는 업무 승인이나 지급 가능 판정이 아닙니다.', 'd-hwp-rules__limit'));
  container.append(node('p', `조회 시점: ${reply.checkedAt || '미확인'}`, 'd-hwp-rules__meta'));
  if (source.returnedAt) container.append(node('p', `원본 응답 시점: ${text(source.returnedAt)}`, 'd-hwp-rules__meta'));
  if (data.basis) container.append(node('p', text(data.basis), 'd-hwp-rules__meta'));
  if (reply.operation === 'citations') container.append(node('p', '최신 개정본 기준 대조입니다. 과거 거래의 적용 규정·시행일이나 캠퍼스 적용 범위를 자동 확정하지 않습니다.', 'd-hwp-rules__limit'));
  if (data.applicability) container.append(node('p', `적용 판단: ${statusLabel(data.applicability)}`, 'd-hwp-rules__limit'));
  if (hasTruncation) container.append(node('p', '응답 일부가 잘렸습니다. 누락된 조문·표·결과를 원문에서 확인하세요.', 'd-hwp-rules__limit'));

  function sourceLink(parent: HTMLElement, value: unknown, fallback?: unknown): void {
    const url = safeSourceUrl(value) ?? safeSourceUrl(fallback);
    if (!url) { parent.append(node('p', '출처 URL 없음 · 원문 확인 필요', 'd-hwp-rules__meta')); return; }
    const link = node('a', `출처: ${new URL(url).hostname}`, 'd-hwp-rules__source');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
  }
  if (source.name) container.append(node('p', text(source.name), 'd-hwp-rules__meta'));
  // Finance and lookup responses often carry per-rule sources, not an umbrella URL.
  if (source.url || source.name || reply.operation === 'citations') sourceLink(container, source.url);

  function card(title: string): HTMLElement {
    const result = node('article', '', 'd-hwp-rules__card');
    result.append(node('h5', title || '근거 제목 미확인'));
    container.append(result);
    return result;
  }
  function paragraph(parent: HTMLElement, label: string, value: unknown): void {
    const content = text(value);
    if (content) parent.append(node('p', `${label}${content}`));
  }
  function body(parent: HTMLElement, value: unknown): void {
    const content = text(value);
    if (content) parent.append(node('p', content, 'd-hwp-rules__excerpt'));
    else parent.append(node('p', '응답에 본문이 포함되지 않았습니다. 원문을 확인하세요.', 'd-hwp-rules__limit'));
  }
  function limits(parent: HTMLElement, item: RecordValue): void {
    const reasons = entries(item.incompleteReasons).map(text).filter(Boolean);
    if (reasons.length) paragraph(parent, '미완료 사유: ', reasons.join(', '));
    if (truncated(item)) parent.append(node('p', '일부 발췌 · 전체 원문 확인 필요', 'd-hwp-rules__limit'));
  }

  if (reply.operation === 'citations') {
    const countLabels: Record<string, string> = { total: '인용', verified: '대조됨', exists: '존재', notFound: '찾지 못함', needsReview: '추가 검토', floating: '규정명 없는 인용' };
    container.append(node('p', Object.entries(countLabels).filter(([key]) => typeof summary[key] === 'number').map(([key, label]) => `${label} ${summary[key]}건`).join(' · '), 'd-hwp-rules__meta'));
    for (const entry of citations.slice(0, 60)) {
      const citation = record(entry);
      const rule = record(citation.rule);
      const current = card(text(citation.raw) || [text(citation.ruleName), text(citation.article)].join(' '));
      paragraph(current, '대조 상태: ', statusLabel(citation.status));
      paragraph(current, '', citation.note);
      paragraph(current, '인용 제목: ', citation.citedTitle);
      paragraph(current, '원문 제목: ', citation.actualTitle);
      paragraph(current, '규정 번호: ', rule.lawId);
      paragraph(current, '개정본 번호: ', rule.historyId);
      paragraph(current, '개정일: ', rule.revisedAt);
      sourceLink(current, rule.sourceUrl, source.url);
    }
    if (citations.length > 60) container.append(node('p', '화면에는 인용 60건까지만 표시합니다. 검토 범위를 나누어 다시 확인하세요.', 'd-hwp-rules__limit'));
    for (const floating of entries(data.floating).slice(0, 20)) {
      const value = record(floating);
      paragraph(container, '규정명 확인 필요: ', typeof floating === 'string' ? floating : value.raw ?? value.note);
    }
  }

  // Citation data.rules is verification metadata, not another set of body excerpts.
  const rules = reply.operation === 'lookup' || reply.operation === 'finance' ? ruleRecords(data.rules) : [];
  for (const entry of rules.slice(0, 30)) {
    const rule = entry.data;
    const requested = entry.requested ?? {};
    const requestedTitle = [text(requested.keyword), text(requested.article)].filter(Boolean).join(' ');
    const current = card(text(rule.title) || text(rule.name) || requestedTitle);
    if (entry.error) {
      const rawCode = text(entry.error.code);
      const code = /^[A-Z0-9_]{1,80}$/.test(rawCode) ? rawCode : 'UNKNOWN_ERROR';
      paragraph(current, '조회 실패: ', `${statusLabels[code] ?? '규정 조회를 완료하지 못했습니다.'} (${code})`);
      current.append(node('p', '이 요청의 규정 근거를 확보하지 못했습니다. 원문과 조회 범위를 확인하세요.', 'd-hwp-rules__limit'));
      continue;
    }
    const applied = record(rule.applied);
    const enforcement = record(rule.enforcement);
    paragraph(current, '규정 번호: ', rule.lawId);
    paragraph(current, '개정본 번호: ', rule.historyId ?? applied.historyId);
    paragraph(current, '개정일: ', rule.revisedAt ?? applied.revisedAt);
    paragraph(current, '요청 기준일: ', rule.targetDate);
    paragraph(current, '개정본 선택 기준: ', rule.basis);
    paragraph(current, '조회 상태: ', statusLabel(rule.evidenceStatus ?? rule.status ?? (entry.requested ? 'retrieved' : undefined)));
    if (rule.applicability) paragraph(current, '적용 판단: ', statusLabel(rule.applicability));
    const dates = entries(enforcement.dates).map(text).filter(Boolean);
    if (dates.length) paragraph(current, '부칙의 명시 시행일: ', dates.join(', '));
    if (enforcement.afterTarget === true) current.append(node('p', '확인된 시행일이 요청 기준일 이후입니다. 직전 개정본과 경과조치를 함께 확인하세요.', 'd-hwp-rules__limit'));
    paragraph(current, '시점 확인 한계: ', rule.caveat);
    limits(current, rule);
    const articles = entries(rule.articles);
    if (articles.length) {
      for (const value of articles.slice(0, 30)) {
        const article = record(value);
        paragraph(current, '조문: ', article.article);
        if (article.supplementary === true) paragraph(current, '', '부칙 조문 · 개정일과 원문 위치 확인 필요');
        body(current, article.content);
      }
      if (articles.length > 30) current.append(node('p', '화면에는 조문 30건까지만 표시합니다. 전체 원문을 확인하세요.', 'd-hwp-rules__limit'));
    } else body(current, typeof rule.excerpt === 'string' ? rule.excerpt : record(rule.excerpt).text ?? rule.text ?? rule.contentMarkdown);
    sourceLink(current, rule.sourceUrl ?? record(rule.source).url, source.url);
    paragraph(current, '원본 응답 시점: ', record(rule.source).returnedAt);
  }
  if (rules.length > 30) container.append(node('p', '화면에는 규정 30건까지만 표시합니다. 범위를 나누어 확인하세요.', 'd-hwp-rules__limit'));
  const candidates = entries(data.candidates);
  if (candidates.length) container.append(node('p', '규정 후보가 여러 개입니다. 제목과 규정 번호를 확인한 뒤 번호를 입력하여 다시 조회하세요.', 'd-hwp-rules__limit'));
  for (const candidate of candidates.slice(0, 30)) {
    const item = record(candidate);
    const current = card(text(item.title) || text(item.name));
    paragraph(current, '규정 번호: ', item.lawId ?? item.law_id);
    paragraph(current, '개정일: ', item.revisedAt);
    sourceLink(current, item.sourceUrl ?? item.url, source.url);
  }
  if (reply.operation === 'lookup' && !rules.length && !candidates.length) container.append(node('p', '규정 본문을 확보하지 못했습니다. 질문·규정명과 조회 상태를 확인하세요.', 'd-hwp-rules__limit'));

  const questions = [...entries(context.questions), ...entries(context.missing_facts), ...entries(review.questions)]
    .map(item => ({ key: text(record(item).key), label: text(record(item).label) }))
    .filter((question, index, all) => question.label && all.findIndex(other => other.key === question.key && other.label === question.label) === index);
  if (reply.operation === 'finance') {
    paragraph(container, '', context.notice);
    paragraph(container, '검토 상태: ', statusLabel(review.status));
    const findings = entries(review.findings).map(text).filter(Boolean);
    for (const finding of findings) container.append(node('p', finding, 'd-hwp-rules__finding'));
    if (questions.length) container.append(node('h5', '추가 확인 질문'));
    for (const question of questions) container.append(node('p', question.label, 'd-hwp-rules__question'));
    if (typeof context.remaining_question_count === 'number' && context.remaining_question_count > 0) paragraph(container, '추가 확인 항목 수: ', context.remaining_question_count);
    for (const [key, label] of [['rule_coverage', '교내 규정'], ['legal', '한국법령'], ['handbook', '해설서'], ['practice', '실무 자료']] as const) {
      const group = record(data[key]);
      paragraph(container, `${label} 조회: `, statusLabel(group.status));
    }
    const legal = record(data.legal);
    for (const entry of entries(legal.results).slice(0, 30)) {
      const result = record(entry);
      const request = record(result.request);
      const law = record(result.law);
      const current = card(`${text(request.law_name) || text(law.name) || '법령명 미확인'} ${text(request.article) || text(request.annex)}`);
      paragraph(current, '조회 상태: ', statusLabel(result.status));
      const targets = [...entries(result.articles), ...entries(result.annexes)];
      if (!targets.length) body(current, undefined);
      for (const value of targets.slice(0, 12)) {
        const target = record(value);
        const provenance = record(target.source);
        paragraph(current, '대상: ', target.selector);
        paragraph(current, '법령 번호: ', provenance.lawId ?? law.lawId);
        paragraph(current, '개정본 번호: ', provenance.mst);
        paragraph(current, '시행일: ', provenance.effectiveAt);
        paragraph(current, '요청 기준일: ', provenance.baseDate ?? legal.baseDate);
        paragraph(current, '시점 확인: ', target.dateStatus);
        paragraph(current, '조회 상태: ', statusLabel(target.status));
        if (target.referenceOnly) current.append(node('p', '참고용 근거 · 요청 기준일 적용 여부 미확정', 'd-hwp-rules__limit'));
        limits(current, target);
        body(current, target.text);
        sourceLink(current, provenance.url);
      }
    }
  }

  // Keep the complete returned data, with provenance and limitations, or exclude it entirely.
  // No silent shortening is allowed for evidence used by a later AI request.
  const evidence = JSON.stringify({ tool: reply.tool, checkedAt: reply.checkedAt, status, approval: '업무 승인·지급 가능 판정 아님', data });
  if (evidence.length > MAX_EVIDENCE_CHARS) {
    container.append(node('p', `근거가 ${MAX_EVIDENCE_CHARS.toLocaleString('ko-KR')}자를 초과해 요청문에 포함할 수 없습니다. 조회 범위를 줄여 다시 확인하세요.`, 'd-hwp-rules__limit'));
    return { questions };
  }
  return { evidence, questions };
}
