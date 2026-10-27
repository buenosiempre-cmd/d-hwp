import { createStudio, type RhwpEditor, type RhwpDocumentStateV1 } from '@rhwp/editor';
import { validateInput, MAX_PAGES, MAX_FILE_BYTES } from '../shared/errors';
import {attachSave} from './save';
import {Startup} from './startup';
import {EditorApiError,reconnectEditor,deliverReconnect,sameIdentity,type EditorIdentity} from './reconnect';
import {mountAssistant} from '../assistant/panel';
import './style.css';

const status = document.querySelector<HTMLElement>('#status')!;
const input = document.querySelector<HTMLInputElement>('#file')!;
const local = document.querySelector<HTMLElement>('#local')!;
const devtools = __LOCAL_FILES__ && new URLSearchParams(location.search).get('devtools') === '1';
const ticket = __LOCAL_FILES__ ? new URLSearchParams(location.hash.slice(1)).get('document') : null;
const editorTicket = new URLSearchParams(location.hash.slice(1)).get('ticket');
const reconnectNonce = new URLSearchParams(location.hash.slice(1)).get('reconnect');
const workspace = new URLSearchParams(location.hash.slice(1)).get('workspace');
// Remove credentials from the URL before any child frame is created.
history.replaceState(null, '', location.pathname + location.search);
// Deployment-owned HTML chooses the API; URL parameters and document data never do.
const configuredApi=document.querySelector<HTMLMetaElement>('meta[name="rhwp-api-origin"]')?.content;
const apiOrigin=configuredApi?new URL(configuredApi).origin:location.origin;
let bearer: string | undefined;
let startup:Startup|undefined;
const mark=(step:string)=>performance.mark('rhwp:'+step);
mark('host-start');
async function api(path: string, init: RequestInit = {},token=bearer): Promise<Response> {
  if(['exchange','document','source'].includes(path))mark(path+'-start');
  const response = await fetch(apiOrigin+'/api/editor/' + path, {...init, credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', signal:AbortSignal.any([AbortSignal.timeout(90_000),...(startup?[startup.signal]:[])]), headers:{...init.headers, ...(workspace?{'X-Rhwp-Workspace':workspace}:{}), ...(token?{Authorization:'Bearer '+token}:{})}});
  if (!response.ok) {const error=await response.json().catch(()=>({}));throw new EditorApiError(error.error || 'Slack 연결을 확인해 주세요.',error.code);}
  if(['exchange','document','source'].includes(path))mark(path+'-headers');
  return response;
}
let studio: RhwpEditor;
let busy = false;
let documentName = '';
let assistantSnapshot:RhwpDocumentStateV1|undefined;
const assistantPanel=document.querySelector<HTMLElement>('#dhwp-assistant')!;
const assistantToggle=document.querySelector<HTMLButtonElement>('#dhwp-toggle')!;
const assistant=mountAssistant(document.querySelector<HTMLElement>('#dhwp-assistant-body')!,{
  readDocument:async()=>{
    if(busy||!studio||!documentName||document.body.dataset.state!=='ready')throw new Error('문서를 먼저 열어 주세요.');
    const name=documentName;
    const before=await studio.getDocumentState();
    const text=await studio.hwpctrl.call('GetTextFile',['TEXT','']);
    const after=await studio.getDocumentState();
    if(name!==documentName||busy||before.documentEpoch!==after.documentEpoch||before.changeSeq!==after.changeSeq||before.documentSha256!==after.documentSha256)throw new Error('가져오는 동안 문서가 변경되었습니다. 다시 가져와 주세요.');
    if(typeof text!=='string')throw new Error('문서 텍스트를 가져오지 못했습니다. 필요한 부분을 직접 붙여넣어 주세요.');
    assistantSnapshot=after;
    return {text,name};
  },
  isDocumentCurrent:async()=>{
    if(!assistantSnapshot||busy||!studio||document.body.dataset.state!=='ready')return false;
    const current=await studio.getDocumentState();
    return assistantSnapshot.documentEpoch===current.documentEpoch&&assistantSnapshot.changeSeq===current.changeSeq&&assistantSnapshot.documentSha256===current.documentSha256;
  },
});
function closeAssistant():void{
  assistantPanel.hidden=true;assistantToggle.setAttribute('aria-expanded','false');assistantToggle.focus();
}
assistantToggle.addEventListener('click',()=>{
  const open=assistantPanel.hidden;assistantPanel.hidden=!open;assistantToggle.setAttribute('aria-expanded',String(open));
  if(open)document.querySelector<HTMLButtonElement>('#dhwp-close')!.focus();
});
document.querySelector('#dhwp-close')!.addEventListener('click',closeAssistant);
assistantPanel.addEventListener('keydown',event=>{if(event.key==='Escape')closeAssistant();});

function setStatus(message: string, state: 'loading' | 'empty' | 'ready' | 'error'): void {
  status.textContent = message;
  document.body.dataset.state = state;
  local.hidden = !devtools || state === 'ready' || state === 'loading';
  assistantToggle.hidden=state!=='ready';
  if(state!=='ready'){assistantPanel.hidden=true;assistantToggle.setAttribute('aria-expanded','false');}
}
function showError(error: unknown): void {
  assistantSnapshot=undefined;
  assistant.clear();
  setStatus(error instanceof Error ? error.message : '문서를 열지 못했습니다.', 'error');
}
function setDirty(dirty: boolean): void {
  document.title = `${dirty ? '* ' : ''}${documentName} · D-HWP`;
  status.dataset.dirty = String(dirty);
  setStatus(dirty ? '저장하지 않은 변경 있음' : '변경 없음', 'ready');
}
async function load(bytes: Uint8Array, name: string): Promise<void> {
  if (busy) throw new Error('문서를 여는 중입니다.');
  validateInput(bytes);
  assistantSnapshot=undefined;
  assistant.clear();
  busy = true;
  input.disabled = true;
  mark('load-start');
  setStatus('문서를 여는 중입니다.', 'loading');
  try {
    const result = await (startup?startup.run(()=>studio.loadFile(bytes,name)):studio.loadFile(bytes,name));
    if (result.pageCount > MAX_PAGES) {
      studio.destroy();
      throw new Error('200페이지 이하 문서만 열 수 있습니다. 편집기를 다시 열어 주세요.');
    }
    documentName = name.normalize('NFC');
    studio.element.title = `${documentName} · rhwp-studio 문서 편집기`;
    setDirty(false);mark('document-ready');
  } finally {
    busy = false;
    input.disabled = false;
  }
}
async function initialize():Promise<void>{
  if(!editorTicket&&!__LOCAL_FILES__){
    setStatus('Slack에서 문서 열기를 선택하세요.','empty');
    document.querySelector<HTMLElement>('#reopen')!.hidden=false;return;
  }
  startup=new Startup();
  try {
  setStatus('Slack 문서 접근 권한을 확인하고 있습니다.','loading');
  if (editorTicket) bearer = (await (await api('exchange', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ticket:editorTicket})})).json()).token;
  setStatus('rhwp 편집기를 준비하고 있습니다.','loading');
  mark('studio-start');
  const studioReady = startup.run(()=>createStudio('#editor', {
    studioUrl: new URL(__STUDIO_BASE__+'?chrome=embed', location.origin).href,
    plugins: ['hwpctrl'], requestTimeoutMs: 60_000, handshakeTimeoutMs: 10_000,
  }),late=>late.destroy()).then(instance=>{studio=instance;studio.element.title='rhwp-studio 문서 편집기';mark('studio-ready');});
  // All rejections are observed immediately. Failure cancels requests and destroys even a late Studio.
  const documentReady = bearer ? Promise.all([
    api('document').then(async r=>{const value=await r.json();mark('metadata-ready');return value as {name:string;identity?:EditorIdentity};}),
    api('source').then(async r=>{const value=await r.arrayBuffer();mark('source-ready');return value;}),
  ]) : Promise.resolve(null);
  const [,sourceDocument]=await Promise.all([studioReady,documentReady]);
  if(!sourceDocument)setStatus(devtools ? '문서를 선택하세요' : 'Slack에서 문서 열기를 선택하세요.', 'empty');
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== studio.element.contentWindow ||
        event.data?.type !== 'rhwp-slack:dirty' || typeof event.data.dirty !== 'boolean' ||
        busy || !documentName || document.body.dataset.state !== 'ready') return;
    setDirty(event.data.dirty);
    if(event.data.dirty)assistant.notifyDocumentChanged();
  });
  if (sourceDocument) {
    const [meta,bytes]=sourceDocument;
    await load(new Uint8Array(bytes), meta.name);
    const reconnect=meta.identity&&workspace===meta.identity.teamId?()=>reconnectEditor(apiOrigin,meta.identity!,async(freshTicket,signal)=>{
      const candidate=(await(await api('exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:freshTicket})})).json()).token;
      const fresh=await(await api('document',{},candidate)).json();
      if(!sameIdentity(meta.identity!,fresh.identity))throw new Error('처음 편집한 워크스페이스와 사용자로 로그인해 주세요. 원래 편집 내용은 유지됩니다.');
      if(signal.aborted)throw new Error('로그인 확인이 취소되었습니다. 다시 시도해 주세요.');
      bearer=candidate;
    }):undefined;
    attachSave(studio, api,{reconnect,name:meta.name});mark('editor-ready');
  }
  if (__LOCAL_FILES__) {
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        showError(new Error('20 MiB 이하 문서만 열 수 있습니다.'));
        input.value = '';
        return;
      }
      void file.arrayBuffer().then(bytes => load(new Uint8Array(bytes), file.name))
        .catch(showError).finally(() => { input.value = ''; });
    });
    // Dev build only: actual SDK for integration tests, never a production file ingress.
    Object.assign(window, { __studio: studio, __loadDocument: load });
    if (ticket) {
      setStatus('문서를 여는 중입니다.', 'loading');
      const base = '/api/dev/documents/' + encodeURIComponent(ticket);
      const [meta, response] = await Promise.all([fetch(base), fetch(base + '/source')]);
      if (!meta.ok || !response.ok) throw new Error('문서가 만료되었습니다. Slack에서 문서 열기를 다시 선택하세요.');
      await load(new Uint8Array(await response.arrayBuffer()), (await meta.json()).name);
    }
  }
  startup.finish();startup=undefined;
  } catch (error) {
    const failure=startup?.signal.aborted?startup.signal.reason:error;
    startup?.cancel(failure);studio?.destroy();document.querySelector('#editor')!.replaceChildren();
    bearer=undefined;showError(failure);document.querySelector<HTMLElement>('#reopen')!.hidden=false;
  }
}
if(reconnectNonce){
  setStatus(deliverReconnect(editorTicket,workspace,reconnectNonce)?'로그인을 확인하고 있습니다. 원래 편집창으로 돌아가 주세요.':'편집창과 연결하지 못했습니다. 원래 창에서 다시 로그인해 주세요.','empty');
}else void initialize();
