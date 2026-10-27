import { buildPrompt, MAX_CONTEXT_CHARS, MAX_NAME_CHARS, MAX_SOURCE_CHARS, safeDownloadName, TASKS, type TaskId } from './workflows';
import './panel.css';

export interface AssistantOptions {
  readDocument?: () => Promise<{ text: string; name: string }>;
  /** Compare the editor state with the snapshot taken by readDocument. */
  isDocumentCurrent?: () => Promise<boolean>;
}

export interface AssistantPanel {
  clear(): void;
  notifyDocumentChanged(): void;
  destroy(): void;
}

let panelSequence = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Prepare prompts locally. Reading a document and exporting a prompt require explicit actions. */
export function mountAssistant(container: HTMLElement, options: AssistantOptions = {}): AssistantPanel {
  const prefix = `d-hwp-assistant-${++panelSequence}`;
  const listeners = new AbortController();
  const root = element('section', 'd-hwp-assistant');
  root.setAttribute('aria-labelledby', `${prefix}-title`);
  const heading = element('h2', 'd-hwp-assistant__title', 'AI 요청문 준비');
  heading.id = `${prefix}-title`;
  const header = element('header', 'd-hwp-assistant__header');
  header.append(element('p', 'd-hwp-assistant__eyebrow', '동국 한글문서 도우미'), heading,
    element('p', 'd-hwp-assistant__intro', '문서의 내용을 정리하고, 업무에 맞는 검토를 준비하세요.'));
  const privacy = element('p', 'd-hwp-assistant__privacy', '원문을 AI로 자동 전송하지 않습니다. 개인정보·민감정보를 확인하고 대학에서 허용한 AI에 요청문을 직접 입력하세요.');
  root.append(header, privacy);

  function section(number: string, title: string): HTMLElement {
    const sectionRoot = element('section', 'd-hwp-assistant__section');
    const sectionHeading = element('h3', 'd-hwp-assistant__section-title');
    const step = element('span', 'd-hwp-assistant__step', number);
    step.setAttribute('aria-hidden', 'true');
    sectionHeading.append(step, document.createTextNode(title));
    sectionRoot.append(sectionHeading);
    root.append(sectionRoot);
    return sectionRoot;
  }

  function labelFor(control: HTMLElement, labelText: string, suffix: string): HTMLLabelElement {
    control.id = `${prefix}-${suffix}`;
    const label = element('label', 'd-hwp-assistant__label', labelText);
    label.htmlFor = control.id;
    return label;
  }

  function button(label: string, variant = 'secondary'): HTMLButtonElement {
    const control = element('button', `d-hwp-assistant__button d-hwp-assistant__button--${variant}`, label);
    control.type = 'button';
    return control;
  }

  const sourceSection = section('01', '검토할 내용');
  const importButton = button('문서 전체 가져오기');
  importButton.disabled = !options.readDocument;
  const sourceHelp = element('p', 'd-hwp-assistant__help', options.readDocument
    ? '열린 문서의 텍스트를 가져오거나 필요한 부분만 붙여넣으세요. 표·이미지의 내용은 원문과 대조해야 합니다.'
    : '검토할 부분을 아래에 붙여넣으세요. 표·이미지의 내용은 원문과 대조해야 합니다.');
  sourceHelp.id = `${prefix}-source-help`;
  const source = element('textarea', 'd-hwp-assistant__textarea');
  source.rows = 8;
  source.placeholder = '검토할 문서 내용을 여기에 붙여넣으세요.';
  source.spellcheck = false;
  source.autocomplete = 'off';
  source.setAttribute('aria-describedby', `${sourceHelp.id} ${prefix}-source-count ${prefix}-source-state`);
  const sourceCount = element('span', 'd-hwp-assistant__count');
  sourceCount.id = `${prefix}-source-count`;
  const sourceState = element('span', 'd-hwp-assistant__source-state', '직접 입력');
  sourceState.id = `${prefix}-source-state`;
  const sourceMeta = element('div', 'd-hwp-assistant__meta');
  sourceMeta.append(sourceState, sourceCount);
  const name = element('input', 'd-hwp-assistant__input');
  name.type = 'text';
  name.autocomplete = 'off';
  name.placeholder = '예: 회의자료.hwpx';
  name.maxLength = MAX_NAME_CHARS;
  sourceSection.append(importButton, sourceHelp, labelFor(source, '문서 내용', 'source'), source, sourceMeta,
    labelFor(name, '문서명 (선택)', 'name'), name);

  const taskSection = section('02', '업무 선택');
  const task = element('select', 'd-hwp-assistant__select');
  for (const item of TASKS) {
    const option = element('option', undefined, item.title);
    option.value = item.id;
    task.append(option);
  }
  const taskDescription = element('p', 'd-hwp-assistant__task-description');
  taskDescription.id = `${prefix}-task-description`;
  task.setAttribute('aria-describedby', taskDescription.id);
  const checks = element('ul', 'd-hwp-assistant__checks');
  checks.setAttribute('aria-label', '검토 체크리스트');
  const context = element('textarea', 'd-hwp-assistant__textarea d-hwp-assistant__textarea--context');
  context.rows = 3;
  context.autocomplete = 'off';
  context.placeholder = '예: 부서 회의에서 보고할 수 있도록 핵심과 확인할 사항을 정리해 주세요.';
  const contextCount = element('p', 'd-hwp-assistant__count');
  contextCount.id = `${prefix}-context-count`;
  context.setAttribute('aria-describedby', contextCount.id);
  taskSection.append(labelFor(task, '검토 업무', 'task'), task, taskDescription, checks,
    labelFor(context, '업무 배경·추가 요청 (선택)', 'context'), context, contextCount);
  const generate = button('AI 요청문 만들기', 'primary');
  taskSection.append(generate);

  const outputSection = section('03', '요청문 확인');
  const outputHelp = element('p', 'd-hwp-assistant__help', '아래 내용은 AI의 답변이 아니라 AI에 전달할 요청문입니다. 공유할 내용과 범위를 확인하세요.');
  outputHelp.id = `${prefix}-output-help`;
  const preview = element('textarea', 'd-hwp-assistant__textarea d-hwp-assistant__preview');
  preview.readOnly = true;
  preview.rows = 8;
  preview.spellcheck = false;
  preview.placeholder = '요청문을 만들면 여기에 표시됩니다.';
  preview.setAttribute('aria-describedby', outputHelp.id);
  const copy = button('요청문 복사');
  const download = button('Markdown 저장');
  const outputActions = element('div', 'd-hwp-assistant__actions');
  outputActions.append(copy, download);
  outputSection.append(outputHelp, labelFor(preview, 'AI 요청문 미리보기', 'preview'), preview, outputActions);

  const footer = element('footer', 'd-hwp-assistant__footer');
  const status = element('p', 'd-hwp-assistant__status', '검토할 문서 내용을 준비하세요.');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const reset = button('전체 초기화', 'quiet');
  const resetHelp = element('p', 'd-hwp-assistant__help', '초기화하면 이 패널의 입력과 요청문이 지워집니다.');
  footer.append(status, reset, resetHelp);
  root.append(footer);
  container.append(root);

  let destroyed = false;
  let reading = false;
  let checking = false;
  let generation = 0;
  let imported = false;
  let stale = false;
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();

  function announce(message: string, error = false): void {
    status.textContent = message;
    status.dataset.tone = error ? 'error' : 'normal';
  }

  function renderTask(): void {
    const selected = TASKS.find(item => item.id === task.value) ?? TASKS[0];
    taskDescription.textContent = selected.description;
    checks.replaceChildren(...selected.checks.map(check => element('li', undefined, check)));
  }

  function updateControls(): void {
    sourceCount.textContent = `${source.value.length.toLocaleString('ko-KR')} / ${MAX_SOURCE_CHARS.toLocaleString('ko-KR')}자`;
    contextCount.textContent = `${context.value.length.toLocaleString('ko-KR')} / ${MAX_CONTEXT_CHARS.toLocaleString('ko-KR')}자`;
    const sourceTooLong = source.value.length > MAX_SOURCE_CHARS;
    const contextTooLong = context.value.length > MAX_CONTEXT_CHARS;
    source.setAttribute('aria-invalid', String(sourceTooLong));
    context.setAttribute('aria-invalid', String(contextTooLong));
    sourceCount.dataset.exceeded = String(sourceTooLong);
    contextCount.dataset.exceeded = String(contextTooLong);
    sourceState.textContent = stale ? '문서 변경됨 · 다시 가져오기 필요' : imported ? '문서에서 가져온 내용' : '직접 입력';
    sourceState.dataset.stale = String(stale);
    importButton.disabled = reading || !options.readDocument;
    importButton.textContent = reading ? '문서를 가져오는 중…' : '문서 전체 가져오기';
    sourceSection.setAttribute('aria-busy', String(reading));
    generate.disabled = reading || checking || stale || !source.value.trim() || sourceTooLong || contextTooLong;
    copy.disabled = checking || !preview.value;
    download.disabled = checking || !preview.value;
  }

  function invalidate(): boolean {
    const hadOutput = !!preview.value;
    preview.value = '';
    generation += 1;
    reading = false;
    checking = false;
    return hadOutput;
  }

  async function ensureCurrentDocument(token: number): Promise<boolean> {
    if (destroyed || token !== generation) return false;
    if (!imported || !options.isDocumentCurrent) return true;
    checking = true;
    updateControls();
    announce('가져온 내용이 현재 문서와 일치하는지 확인하고 있습니다.');
    try {
      const current = await options.isDocumentCurrent();
      if (destroyed || token !== generation) return false;
      if (!current) {
        invalidate();
        stale = true;
        updateControls();
        announce('편집기의 문서가 변경되었습니다. 문서 전체를 다시 가져오거나 검토할 텍스트를 직접 수정하세요.');
        return false;
      }
      return true;
    } catch {
      if (destroyed || token !== generation) return false;
      invalidate();
      stale = true;
      updateControls();
      announce('현재 문서와 내용을 대조하지 못했습니다. 문서 전체를 다시 가져오거나 검토할 텍스트를 직접 수정하세요.', true);
      return false;
    } finally {
      if (!destroyed && token === generation) {
        checking = false;
        updateControls();
      }
    }
  }

  function changed(event: Event): void {
    if (destroyed) return;
    const hadOutput = invalidate();
    if (event.target === source) {
      imported = false;
      stale = false;
    }
    if (event.target === task) renderTask();
    updateControls();
    if (source.value.length > MAX_SOURCE_CHARS) {
      announce(`문서 내용을 ${MAX_SOURCE_CHARS.toLocaleString('ko-KR')}자 이하로 줄여 주세요.`, true);
    } else if (context.value.length > MAX_CONTEXT_CHARS) {
      announce(`추가 요청을 ${MAX_CONTEXT_CHARS.toLocaleString('ko-KR')}자 이하로 줄여 주세요.`, true);
    } else if (stale) {
      announce('편집기의 문서가 변경되었습니다. 문서 전체를 다시 가져오거나 검토할 텍스트를 직접 수정하세요.');
    } else {
      announce(hadOutput ? '입력이 바뀌어 이전 요청문을 지웠습니다. 요청문을 다시 만들어 주세요.' : '검토할 내용과 업무를 확인한 뒤 요청문을 만드세요.');
    }
  }

  for (const control of [source, name, context]) control.addEventListener('input', changed, { signal: listeners.signal });
  task.addEventListener('change', changed, { signal: listeners.signal });

  importButton.addEventListener('click', () => {
    if (destroyed || reading || !options.readDocument) return;
    invalidate();
    const token = generation;
    reading = true;
    announce('열린 문서의 전체 텍스트를 가져오고 있습니다.');
    updateControls();
    void (async () => {
      try {
        const result = await options.readDocument!();
        if (destroyed || token !== generation) return;
        if (typeof result?.text !== 'string' || typeof result?.name !== 'string') throw new Error('문서 텍스트를 가져오지 못했습니다. 필요한 내용을 직접 붙여넣으세요.');
        if (!result.text.trim()) throw new Error('가져온 문서에 텍스트가 없습니다. 필요한 내용을 직접 붙여넣으세요.');
        if (result.text.length > MAX_SOURCE_CHARS) throw new Error(`문서가 ${MAX_SOURCE_CHARS.toLocaleString('ko-KR')}자를 초과합니다. 검토할 부분만 직접 붙여넣으세요.`);
        if (result.name.length > MAX_NAME_CHARS) throw new Error(`문서명이 ${MAX_NAME_CHARS.toLocaleString('ko-KR')}자를 초과합니다. 내용을 직접 붙여넣고 짧은 문서명을 입력하세요.`);
        source.value = result.text;
        name.value = result.name;
        imported = true;
        stale = false;
        announce('문서의 전체 텍스트를 가져왔습니다. 공유할 내용을 확인하고 필요한 부분만 남기세요.');
      } catch (error) {
        if (destroyed || token !== generation) return;
        // The host may have already advanced its snapshot before validation failed.
        // Never pair an old imported source with that newer snapshot.
        if (imported) stale = true;
        const message = error instanceof Error ? error.message : '문서 텍스트를 가져오지 못했습니다. 필요한 내용을 직접 붙여넣으세요.';
        announce(message + (imported ? ' 이전에 가져온 내용은 다시 가져오거나 직접 수정한 뒤 사용할 수 있습니다.' : ''), true);
      } finally {
        if (!destroyed && token === generation) {
          reading = false;
          updateControls();
        }
      }
    })();
  }, { signal: listeners.signal });

  generate.addEventListener('click', () => {
    if (destroyed || reading || checking || stale) return;
    invalidate();
    const token = generation;
    void (async () => {
      if (!await ensureCurrentDocument(token) || destroyed || token !== generation) return;
      try {
        preview.value = buildPrompt({ task: task.value as TaskId, source: source.value, documentName: name.value, context: context.value });
        announce('요청문을 만들었습니다. 내용을 확인한 뒤 복사하거나 Markdown 파일로 저장하세요.');
      } catch (error) {
        announce(error instanceof Error ? error.message : '입력 내용을 확인해 주세요.', true);
      }
      updateControls();
    })();
  }, { signal: listeners.signal });

  copy.addEventListener('click', () => {
    if (destroyed || checking || !preview.value) return;
    const token = generation;
    const prompt = preview.value;
    void (async () => {
      if (!await ensureCurrentDocument(token) || destroyed || token !== generation) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(prompt);
        if (!destroyed && token === generation) announce('요청문을 복사했습니다. 허용된 AI 서비스에 직접 입력하세요.');
      } catch {
        if (destroyed || token !== generation) return;
        preview.focus();
        preview.select();
        announce('자동 복사를 사용할 수 없어 요청문을 선택했습니다. Ctrl+C 또는 ⌘C로 복사하세요.');
      }
    })();
  }, { signal: listeners.signal });

  download.addEventListener('click', () => {
    if (destroyed || checking || !preview.value) return;
    const token = generation;
    void (async () => {
      if (!await ensureCurrentDocument(token) || destroyed || token !== generation) return;
      const url = URL.createObjectURL(new Blob([preview.value], { type: 'text/markdown;charset=utf-8' }));
      const link = element('a');
      link.href = url;
      link.download = safeDownloadName(name.value);
      link.hidden = true;
      root.append(link);
      link.click();
      link.remove();
      downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 1_000));
      announce('Markdown 파일 저장을 요청했습니다. 파일에도 문서 내용이 포함됩니다.');
    })();
  }, { signal: listeners.signal });

  function clear(): void {
    if (destroyed) return;
    invalidate();
    source.value = '';
    name.value = '';
    context.value = '';
    task.value = TASKS[0].id;
    imported = false;
    stale = false;
    for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.clear();
    renderTask();
    updateControls();
    announce('패널의 입력과 요청문을 모두 지웠습니다.');
  }

  reset.addEventListener('click', clear, { signal: listeners.signal });
  renderTask();
  updateControls();

  return {
    clear,
    notifyDocumentChanged() {
      if (destroyed) return;
      invalidate();
      if (imported) stale = true;
      updateControls();
      announce(imported
        ? '편집기의 문서가 변경되었습니다. 문서 전체를 다시 가져오거나 검토할 텍스트를 직접 수정하세요.'
        : '편집기의 문서가 변경되었습니다. 직접 입력한 내용은 유지됩니다. 검토할 내용이 맞는지 확인하세요.');
    },
    destroy() {
      if (destroyed) return;
      clear();
      destroyed = true;
      listeners.abort();
      root.remove();
    },
  };
}
