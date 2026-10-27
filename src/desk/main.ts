import {createStudio, type RhwpEditor, type RhwpDocumentStateV1} from '@rhwp/editor';
import {mountAssistant} from '../assistant/panel';
import {captureSaveSnapshot} from '../editor/save-snapshot';
import {MAX_FILE_BYTES, MAX_PAGES, validateInput} from '../shared/errors';
import './style.css';

const get = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const input = get<HTMLInputElement>('#file');
const editorContainer = get('#desk-editor');
const status = get('#desk-status');
const downloadButton = get<HTMLButtonElement>('#download-document');
const closeButton = get<HTMLButtonElement>('#close-document');
let studio: RhwpEditor | undefined;
let documentName = '';
let dirty = false;
let generation = 0;
let actionSequence = 0;
let downloading = false;
let state: 'empty' | 'loading' | 'ready' | 'error' = 'empty';
let importedSnapshot: RhwpDocumentStateV1 | undefined;
const sameSnapshot = (a: RhwpDocumentStateV1, b: RhwpDocumentStateV1): boolean =>
  a.documentEpoch === b.documentEpoch && a.changeSeq === b.changeSeq && a.documentSha256 === b.documentSha256;

const assistant = mountAssistant(get('#assistant'), {
  async readDocument() {
    const current = studio;
    const version = generation;
    const name = documentName;
    if (!current || state !== 'ready' || !name) throw new Error('먼저 한글 문서를 열어 주세요. 텍스트를 직접 붙여넣어도 됩니다.');
    const before = await current.getDocumentState();
    const text: unknown = await current.hwpctrl.call('GetTextFile', ['TEXT', '']);
    const after = await current.getDocumentState();
    if (version !== generation || current !== studio || state !== 'ready') throw new Error('문서가 바뀌었습니다. 현재 문서에서 다시 가져와 주세요.');
    if (typeof text !== 'string') throw new Error('문서 텍스트를 가져오지 못했습니다. 필요한 부분을 직접 붙여넣어 주세요.');
    if (!sameSnapshot(before, after)) throw new Error('내용을 가져오는 동안 문서가 변경되었습니다. 다시 가져와 주세요.');
    importedSnapshot = after;
    return {text, name};
  },
  async isDocumentCurrent() {
    const current = studio;
    const snapshot = importedSnapshot;
    const version = generation;
    if (!current || !snapshot || state !== 'ready') return false;
    try {
      const now = await current.getDocumentState();
      return version === generation && current === studio && state === 'ready' && sameSnapshot(snapshot, now);
    } catch { return false; }
  },
});

function render(message: string, next = state): void {
  state = next;
  document.body.dataset.state = state;
  document.body.dataset.dirty = String(dirty);
  status.textContent = message;
  get('#document-name').textContent = documentName || '열린 문서 없음';
  get('#empty-document').hidden = state === 'loading' || state === 'ready';
  get('#loading-document').hidden = state !== 'loading';
  editorContainer.hidden = state !== 'ready' && state !== 'loading';
  editorContainer.setAttribute('aria-busy', String(state === 'loading'));
  downloadButton.disabled = state !== 'ready' || downloading;
  closeButton.disabled = state === 'empty';
  document.title = `${dirty ? '* ' : ''}${documentName ? documentName + ' · ' : ''}D-HWP · 동국 한글문서 도우미`;
}

function clearDocument(): void {
  studio?.destroy();
  studio = undefined;
  editorContainer.replaceChildren();
  documentName = '';
  dirty = false;
  downloading = false;
  importedSnapshot = undefined;
  get('#page-count').textContent = '';
  assistant.clear();
}

async function mayDiscard(): Promise<boolean> {
  const current = studio;
  if (!current || state !== 'ready') return true;
  // Read the engine as well as the event flag so an edit immediately before a click is protected.
  let hasChanges = dirty;
  try { hasChanges ||= (await current.getDocumentState()).dirty; }
  catch { hasChanges = true; }
  return !hasChanges || window.confirm('현재 문서에 저장하지 않은 변경이 있습니다. 편집본을 다운로드했는지 확인해 주세요. 현재 편집 내용을 닫고 계속할까요?');
}

async function openDocument(file: File): Promise<void> {
  const action = ++actionSequence;
  if (!await mayDiscard() || action !== actionSequence) return;
  const version = ++generation;
  clearDocument();
  render('문서를 여는 중입니다. 파일은 이 창에서 처리됩니다.', 'loading');
  try {
    if (file.size > MAX_FILE_BYTES) throw new Error('20 MiB 이하 문서만 열 수 있습니다.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (version !== generation) return;
    validateInput(bytes);
    // A private mount per attempt prevents an older initialization from attaching to the next file.
    const mount = document.createElement('div');
    mount.className = 'studio-mount';
    editorContainer.append(mount);
    const candidate = await createStudio(mount, {
      studioUrl: new URL(__STUDIO_BASE__ + '?chrome=embed', location.origin).href,
      plugins: ['hwpctrl'], requestTimeoutMs: 60_000, handshakeTimeoutMs: 10_000,
    });
    if (version !== generation) { candidate.destroy(); return; }
    studio = candidate;
    candidate.element.title = '한글 문서 편집기';
    const result = await candidate.loadFile(bytes, file.name, {skipUnsavedGuard: true});
    if (version !== generation || candidate !== studio) { candidate.destroy(); return; }
    if (result.pageCount > MAX_PAGES) throw new Error('200페이지 이하 문서만 열 수 있습니다.');
    documentName = file.name.normalize('NFC');
    candidate.element.title = `${documentName} · 한글 문서 편집기`;
    get('#page-count').textContent = `${result.pageCount}페이지`;
    dirty = false;
    render('문서를 열었습니다. 원본 파일은 그대로 유지됩니다.', 'ready');
  } catch (error) {
    if (version !== generation) return;
    clearDocument();
    render(error instanceof Error ? error.message : '문서를 열지 못했습니다. 다른 HWP 또는 HWPX 파일을 선택해 주세요.', 'error');
  }
}

get('#open-file').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  const file = input.files?.[0];
  input.value = '';
  if (file) void openDocument(file);
});

closeButton.addEventListener('click', () => { void (async () => {
  const action = ++actionSequence;
  if (!await mayDiscard() || action !== actionSequence) return;
  generation++;
  clearDocument();
  render('문서와 업무 도우미의 내용을 지웠습니다. 새 문서를 열거나 텍스트를 붙여넣으세요.', 'empty');
})(); });

downloadButton.addEventListener('click', () => { void (async () => {
  const current = studio;
  if (!current || state !== 'ready' || downloading) return;
  const version = generation;
  const name = documentName;
  downloading = true;
  render('현재 편집본을 준비하고 있습니다.');
  try {
    const snapshot = await captureSaveSnapshot(current);
    if (version !== generation || current !== studio || state !== 'ready') return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(snapshot.bytes)], {type: 'application/octet-stream'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = name.replace(/\.(hwp|hwpx)$/i, '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_') + '_편집본.' + snapshot.state.format;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    // A browser download starts a handoff; it is not proof that the user saved the artifact.
    render('편집본 다운로드를 시작했습니다. 내려받은 파일을 확인한 뒤 문서를 닫으세요. 원본은 변경되지 않았습니다.');
  } catch (error) {
    if (version === generation) render(error instanceof Error ? error.message : '편집본을 다운로드하지 못했습니다.');
  } finally {
    if (version === generation) { downloading = false; downloadButton.disabled = state !== 'ready'; }
  }
})(); });

window.addEventListener('message', event => {
  if (event.origin !== location.origin || !studio || event.source !== studio.element.contentWindow ||
      event.data?.type !== 'rhwp-slack:dirty' || typeof event.data.dirty !== 'boolean' || state !== 'ready') return;
  dirty = event.data.dirty;
  assistant.notifyDocumentChanged();
  render(dirty ? '저장하지 않은 변경이 있습니다. 편집본을 내려받아 보관하세요.' : '변경 없음 · 원본 파일은 그대로 유지됩니다.');
});

window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});

const mobile = window.matchMedia('(max-width: 900px)');
let activePane: 'document' | 'assistant' = 'document';
function selectPane(pane: 'document' | 'assistant', focus = false): void {
  activePane = pane;
  for (const name of ['document', 'assistant'] as const) {
    const tab = get<HTMLButtonElement>(`#${name}-tab`);
    const selected = name === pane;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    get(`#${name}-pane`).hidden = mobile.matches && !selected;
    if (focus && selected) tab.focus();
  }
}
for (const name of ['document', 'assistant'] as const) {
  const tab = get(`#${name}-tab`);
  tab.addEventListener('click', () => selectPane(name));
  tab.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      selectPane(event.key === 'Home' ? 'document' : event.key === 'End' ? 'assistant' : activePane === 'document' ? 'assistant' : 'document', true);
    }
  });
}
mobile.addEventListener('change', () => selectPane(activePane));
get('#start-with-text').addEventListener('click', () => {
  selectPane('assistant');
  get<HTMLTextAreaElement>('#assistant textarea')?.focus();
});
selectPane(activePane);
