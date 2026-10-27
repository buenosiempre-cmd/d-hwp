import { RULES_FACT_KEYS, RULES_MAX_FACT_CHARS, RULES_MAX_QUERY_CHARS, RULES_MAX_TEXT_CHARS, validateRulesRequest, type RulesCampus, type RulesClient, type RulesRequest } from '../shared/rules';
import { record, renderRulesReply, type RuleQuestion } from './rules-view';

export interface RulesPanel {
  invalidate(): void;
  refresh(): void;
  clear(): void;
  destroy(): void;
  getEvidence(): string | undefined;
}
interface RulesPanelOptions {
  client: RulesClient;
  getSource(): string;
  /** Verifies the editor snapshot and parent generation both before and after requests. */
  ensureCurrent(): Promise<boolean>;
  /** Invalidates an already generated prompt, without invalidating this panel recursively. */
  onChange(): void;
}
const FACT_LABELS: Record<typeof RULES_FACT_KEYS[number], string> = {
  base_date: '거래·검토 기준일', campus: '업무 캠퍼스', accounting_unit: '회계 구분',
  purpose: '지급·거래 목적', payment_route: '지급 경로', payment_status: '지급 상태',
  evidence_type: '증빙 종류', evidence_status: '증빙 접수·확인 상태', fund_source: '예산 재원',
  account_code: '계정과목', employee_role: '적용 직군', travel_scope: '국내·국외 출장',
  employment_relationship: '학교와 강사의 고용관계', tax_residency: '거주자·비거주자 여부',
  service_pattern: '강연의 일시·반복 여부', service_location: '강연 제공 장소', internal_rule_name: '확인한 교내 지급 기준명',
};
const modeTitles = { citations: '문서 인용 점검', lookup: '관련 규정 찾기', finance: '재무 검토 질문·근거' };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

export function mountRulesPanel(container: HTMLElement, prefix: string, options: RulesPanelOptions): RulesPanel {
  const listeners = new AbortController();
  const root = node('section', 'd-hwp-rules');
  root.setAttribute('aria-labelledby', `${prefix}-rules-heading`);
  const heading = node('h3', 'd-hwp-assistant__section-title', '규정·법령 근거 확인');
  heading.id = `${prefix}-rules-heading`;
  const intro = node('p', 'd-hwp-assistant__help', '확인한 전송 범위만 연결된 규정 MCP에 전달합니다. 개인정보·계좌·인증정보는 제외하세요.');
  const connect = button('규정 MCP 연결 확인');
  const status = node('p', 'd-hwp-rules__status', '연결 확인은 문서 내용을 보내지 않습니다.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  root.append(heading, intro, connect, status);

  function button(text: string): HTMLButtonElement {
    const control = node('button', 'd-hwp-assistant__button', text);
    control.type = 'button';
    return control;
  }
  function label(control: HTMLElement, text: string, id: string): HTMLLabelElement {
    control.id = `${prefix}-rules-${id}`;
    const result = node('label', 'd-hwp-assistant__label', text);
    result.htmlFor = control.id;
    return result;
  }
  function checkbox(text: string, id: string): { input: HTMLInputElement; label: HTMLLabelElement } {
    const input = node('input');
    input.type = 'checkbox';
    const title = label(input, '', id);
    title.className = 'd-hwp-rules__checkbox';
    title.append(input, node('span', undefined, text));
    return { input, label: title };
  }

  const mode = node('select', 'd-hwp-assistant__select');
  for (const [id, title] of Object.entries(modeTitles)) {
    const option = node('option', undefined, title);
    option.value = id;
    mode.append(option);
  }
  const modeHelp = node('p', 'd-hwp-assistant__help');
  root.append(label(mode, '규정 검토 방식', 'mode'), mode, modeHelp);
  const queryGroup = node('div');
  const query = node('textarea', 'd-hwp-assistant__textarea d-hwp-assistant__textarea--context');
  query.rows = 3;
  query.placeholder = '예: 직원의 국내 출장 숙박비와 필요한 증빙을 확인하고 싶습니다.';
  query.autocomplete = 'off';
  queryGroup.append(label(query, '규정 검색·검토 질문', 'query'), query, node('p', 'd-hwp-assistant__help', '질문은 2,000자 이하로 입력하세요.'));
  root.append(queryGroup);
  const campusGroup = node('div');
  const campus = node('select', 'd-hwp-assistant__select');
  for (const [value, title] of [['all', '전체 · 적용 범위 미확인'], ['seoul', '서울캠퍼스'], ['wise', 'WISE캠퍼스']]) {
    const option = node('option', undefined, title);
    option.value = value;
    campus.append(option);
  }
  campusGroup.append(label(campus, '적용 캠퍼스', 'campus'), campus, node('p', 'd-hwp-assistant__help', '캠퍼스는 검토 맥락입니다. 공식 규정 목록에 캠퍼스 필터가 없어 적용 범위를 별도로 확인해야 합니다.'));
  root.append(campusGroup);
  const lawGroup = node('div');
  const lawId = node('input', 'd-hwp-assistant__input');
  lawId.type = 'text';
  lawId.inputMode = 'numeric';
  lawId.autocomplete = 'off';
  lawGroup.append(label(lawId, '규정 번호 (선택)', 'law-id'), lawId, node('p', 'd-hwp-assistant__help', '여러 후보가 나오면 확인한 규정 번호를 입력해 다시 조회하세요.'));
  root.append(lawGroup);

  const finance = node('div', 'd-hwp-rules__finance');
  finance.append(node('p', 'd-hwp-assistant__help', '확인한 사실만 입력하세요. 각 항목은 120자 이하이며, 모르는 항목은 비워 두면 추가 질문을 확인할 수 있습니다.'));
  const primaryFacts = node('div');
  const moreFacts = node('details', 'd-hwp-rules__facts-more');
  moreFacts.append(node('summary', undefined, '추가 업무 조건'));
  const factControls = new Map<string, { input: HTMLInputElement; label: HTMLLabelElement; help: HTMLElement }>();
  for (const key of RULES_FACT_KEYS) {
    const input = node('input', 'd-hwp-assistant__input');
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = key === 'base_date' ? 'YYYY-MM-DD' : key === 'campus' ? '서울 또는 WISE' : key === 'accounting_unit' ? '교비회계, 법인회계 등' : '확인한 사실';
    const title = label(input, FACT_LABELS[key], `fact-${key}`);
    const help = node('p', 'd-hwp-assistant__help');
    help.id = `${prefix}-rules-fact-help-${key}`;
    input.setAttribute('aria-describedby', help.id);
    factControls.set(key, { input, label: title, help });
    (['base_date', 'campus', 'accounting_unit'].includes(key) ? primaryFacts : moreFacts).append(title, input, help);
  }
  const includeText = checkbox('문서 내용도 함께 전송', 'include-source');
  finance.append(primaryFacts, moreFacts, includeText.label);
  root.append(finance);

  const transmission = node('textarea', 'd-hwp-assistant__textarea d-hwp-rules__transmission');
  transmission.readOnly = true;
  transmission.rows = 5;
  transmission.spellcheck = false;
  const validation = node('p', 'd-hwp-rules__validation');
  const consent = checkbox('위 내용을 규정 MCP로 전송하는 데 동의합니다', 'consent');
  const execute = button('규정 검토 실행');
  execute.classList.add('d-hwp-assistant__button--primary');
  const results = node('div', 'd-hwp-rules__results');
  const includeEvidence = checkbox('이 근거를 요청문에 포함', 'include-evidence');
  includeEvidence.label.hidden = true;
  root.append(label(transmission, '전송할 내용 확인', 'transmission'), transmission, validation, consent.label, execute, results, includeEvidence.label);
  container.append(root);

  let revision = 0;
  let pending: AbortController | undefined;
  let busy = false;
  let destroyed = false;
  let evidence: string | undefined;
  let financeEnabled: boolean | undefined;

  function announce(message: string, error = false): void {
    status.textContent = message;
    status.dataset.tone = error ? 'error' : 'normal';
  }
  function request(): RulesRequest {
    const source = options.getSource();
    const operation = mode.value;
    if (operation === 'citations' || operation === 'finance' && includeText.input.checked) {
      if (!source.trim()) throw new Error('위의 문서 내용에 검토할 텍스트를 입력하세요.');
      if (source.length > RULES_MAX_TEXT_CHARS) throw new Error(`전송할 문서가 ${RULES_MAX_TEXT_CHARS.toLocaleString('ko-KR')}자를 초과합니다. 문서 내용에서 필요한 범위만 직접 남겨 주세요. 자동으로 자르지 않습니다.`);
    }
    if (operation === 'citations') return { operation, text: source, campus: campus.value as RulesCampus };
    if (!query.value.trim()) throw new Error('규정 검색·검토 질문을 입력하세요.');
    if (query.value.length > RULES_MAX_QUERY_CHARS) throw new Error('규정 검색·검토 질문을 2,000자 이하로 줄여 주세요.');
    if (operation === 'lookup') {
      if (lawId.value && (!/^\d+$/.test(lawId.value) || !Number.isSafeInteger(Number(lawId.value)) || Number(lawId.value) <= 0)) throw new Error('규정 번호에는 확인한 양의 정수를 입력하세요.');
      return { operation, query: query.value, campus: campus.value as RulesCampus, ...(lawId.value ? { lawId: Number(lawId.value) } : {}) };
    }
    if (operation !== 'finance') throw new Error('규정 검토 방식을 선택하세요.');
    if (financeEnabled === false) throw new Error('재무 검토 연결이 꺼져 있습니다. 운영자가 재무 연동을 설정한 뒤 사용할 수 있습니다.');
    const facts: Record<string, string> = {};
    for (const [key, { input }] of factControls) {
      if (input.value.length > RULES_MAX_FACT_CHARS) throw new Error(`${FACT_LABELS[key as keyof typeof FACT_LABELS]} 항목을 120자 이하로 줄여 주세요.`);
      if (input.value.trim()) facts[key] = input.value;
    }
    return { operation, query: query.value, ...(Object.keys(facts).length ? { facts } : {}), ...(includeText.input.checked ? { text: source } : {}) };
  }

  function refresh(): void {
    if (destroyed) return;
    const selected = mode.value as keyof typeof modeTitles;
    queryGroup.hidden = selected === 'citations';
    campusGroup.hidden = selected === 'finance';
    lawGroup.hidden = selected !== 'lookup';
    finance.hidden = selected !== 'finance';
    modeHelp.textContent = selected === 'citations' ? '현재 문서 내용에서 인용을 찾아 최신 개정본과 대조합니다. 과거 적용 기준 확인은 별도입니다.'
      : selected === 'lookup' ? '입력한 질문과 캠퍼스 맥락만 전송합니다. 문서 내용은 보내지 않습니다.'
      : '질문과 입력한 업무 조건을 전송합니다. 문서 내용 전송은 별도로 선택할 수 있습니다.';
    const campusTitle = campus.selectedOptions[0]?.textContent ?? '';
    const lines = [`검토 방식: ${modeTitles[selected] ?? '미선택'}`];
    if (selected !== 'citations') lines.push(`질문: ${query.value}`);
    if (selected !== 'finance') lines.push(`캠퍼스 맥락: ${campusTitle}`);
    if (selected === 'lookup' && lawId.value) lines.push(`규정 번호: ${lawId.value}`);
    if (selected === 'finance') for (const [key, { input }] of factControls) if (input.value.trim()) lines.push(`${FACT_LABELS[key as keyof typeof FACT_LABELS]}: ${input.value}`);
    if (selected === 'citations' || selected === 'finance' && includeText.input.checked) lines.push(`문서 내용 (${options.getSource().length.toLocaleString('ko-KR')}자):`, options.getSource());
    else lines.push('문서 내용: 전송하지 않음');
    transmission.value = lines.join('\n');
    let valid = true;
    try { validateRulesRequest(request()); validation.textContent = ''; }
    catch (error) { valid = false; validation.textContent = error instanceof Error ? error.message : '전송 범위를 확인하세요.'; }
    execute.disabled = busy || !valid || !consent.input.checked;
    execute.textContent = busy ? '규정을 확인하는 중…' : '규정 검토 실행';
    connect.disabled = busy;
    includeEvidence.input.disabled = !evidence || busy;
    root.setAttribute('aria-busy', String(busy));
  }

  function invalidate(): void {
    if (destroyed) return;
    revision += 1;
    pending?.abort();
    pending = undefined;
    busy = false;
    evidence = undefined;
    results.replaceChildren();
    includeEvidence.input.checked = false;
    includeEvidence.label.hidden = true;
    consent.input.checked = false;
    announce('검토 범위가 바뀌었습니다. 전송할 내용을 다시 확인하세요.');
    refresh();
  }
  function changed(): void {
    invalidate();
    options.onChange();
  }
  for (const input of [query, lawId, ...Array.from(factControls.values(), field => field.input)]) input.addEventListener('input', changed, { signal: listeners.signal });
  for (const input of [mode, campus, includeText.input]) input.addEventListener('change', changed, { signal: listeners.signal });
  consent.input.addEventListener('change', refresh, { signal: listeners.signal });
  includeEvidence.input.addEventListener('change', () => { options.onChange(); }, { signal: listeners.signal });

  function showQuestions(questions: RuleQuestion[]): void {
    for (const question of questions) {
      const field = factControls.get(question.key);
      if (field) {
        field.help.textContent = question.label;
        // Keep the stable input and its accessible label, including after edits.
        if (moreFacts.contains(field.input)) moreFacts.open = true;
      } else {
        const note = node('p', 'd-hwp-rules__limit', `추가 확인: ${question.label} 이 항목은 전송 가능한 업무 조건에 없으므로 질문 내용을 직접 보완해 주세요.`);
        results.append(note);
      }
    }
  }

  async function run(payload: RulesRequest): Promise<void> {
    invalidate();
    options.onChange();
    const token = revision;
    const controller = new AbortController();
    pending = controller;
    busy = true;
    announce(payload.operation === 'status' ? '규정 MCP 연결을 확인하고 있습니다.' : '문서 상태와 규정 근거를 확인하고 있습니다.');
    refresh();
    try {
      if (payload.operation !== 'status' && !await options.ensureCurrent()) {
        if (token === revision && !destroyed) announce('문서 상태를 확인하지 못했습니다. 문서를 다시 가져오거나 검토할 내용을 직접 수정하세요.', true);
        return;
      }
      if (destroyed || token !== revision || controller.signal.aborted) return;
      const reply = await options.client(payload, controller.signal);
      if (destroyed || token !== revision || controller.signal.aborted) return;
      if (payload.operation !== 'status' && !await options.ensureCurrent()) {
        if (token === revision && !destroyed) announce('조회 중 문서가 바뀌어 결과를 폐기했습니다. 검토 범위를 다시 확인하세요.', true);
        return;
      }
      if (destroyed || token !== revision || controller.signal.aborted) return;
      if (!reply.ok) {
        announce(reply.error.code === 'NOT_FOUND' ? `인용 또는 규정 근거를 찾지 못했습니다. 검사 범위를 확인하세요. ${reply.error.message}` : reply.error.message || '규정 조회를 완료하지 못했습니다.', true);
        return;
      }
      if (reply.operation !== payload.operation) { announce('요청과 다른 종류의 응답이 도착했습니다. 다시 조회하세요.', true); return; }
      if (payload.operation === 'status') {
        const configured = record(reply.data.dhwp).financeEnabled;
        if (typeof configured === 'boolean') financeEnabled = configured;
        announce(`규정 MCP 연결을 확인했습니다.${financeEnabled === false ? ' 재무 검토 연동은 꺼져 있습니다.' : ''} 문서 전송은 전송 범위를 확인한 뒤 별도로 실행하세요.`);
      } else {
        const view = renderRulesReply(results, reply);
        evidence = view.evidence;
        includeEvidence.label.hidden = false;
        includeEvidence.input.checked = false;
        showQuestions(view.questions);
        announce('규정 조회 결과를 받았습니다. 부분 조회·누락·적용 미확정 상태와 출처를 확인하세요.');
      }
    } catch {
      if (destroyed || token !== revision || controller.signal.aborted) return;
      announce('규정 MCP에 연결하지 못했습니다. 연결 설정을 확인한 뒤 다시 실행하세요.', true);
    } finally {
      if (!destroyed && token === revision) { busy = false; pending = undefined; refresh(); }
    }
  }
  connect.addEventListener('click', () => { if (!busy && !destroyed) void run({ operation: 'status' }); }, { signal: listeners.signal });
  execute.addEventListener('click', () => {
    if (busy || destroyed || !consent.input.checked) return;
    try { void run(validateRulesRequest(request())); }
    catch (error) { announce(error instanceof Error ? error.message : '전송 범위를 확인하세요.', true); }
  }, { signal: listeners.signal });

  function clear(): void {
    if (destroyed) return;
    invalidate();
    query.value = '';
    lawId.value = '';
    mode.value = 'citations';
    campus.value = 'all';
    includeText.input.checked = false;
    moreFacts.open = false;
    for (const { input, help } of factControls.values()) { input.value = ''; help.textContent = ''; }
    refresh();
    announce('규정 검토 입력과 근거를 지웠습니다.');
  }
  refresh();
  return {
    invalidate, refresh, clear,
    getEvidence: () => includeEvidence.input.checked ? evidence : undefined,
    destroy() { if (destroyed) return; clear(); destroyed = true; listeners.abort(); root.remove(); },
  };
}
