import {ID} from './config';
import {UserError} from './errors';
export type Mode = 'open' | 'pdf' | 'png' | 'markdown';
export type Command = {kind:'help'} | {kind:'prepare'; mode:Mode; fileId:string};
export const HELP = [
  'D-HWP · 동국 한글문서 도우미',
  'HWP/HWPX 파일을 채널에 올린 뒤, 같은 스레드의 PDF·PNG·문서 Markdown 버튼을 선택하세요.',
  '기존 파일은 메시지 메뉴의 동국 한글문서 변환으로 요청할 수 있습니다.',
  '/dhwp pdf <Slack 파일 링크> — PDF로 변환',
  '/dhwp png <Slack 파일 링크> — 앞 10쪽까지 PNG 이미지로 변환',
  '/dhwp md <Slack 파일 링크> — 문서 Markdown·그림·원본·대조 보고서 ZIP (markdown도 사용 가능)',
  '/dhwp open <Slack 파일 링크> — 변환 카드 준비와 문서 편집 (edit도 사용 가능)',
  '/dhwp 또는 /dhwp help — 사용법',
  '/dhwp settings — 관리자용 채널 설정',
  '자동 변환 채널에서는 PDF와 첫 3쪽 PNG를 준비합니다. PNG 버튼으로 앞 10쪽까지 확인하고, 문서 Markdown은 버튼을 눌러 만듭니다. 멘션 모드에서는 파일이 있는 스레드에서 D-HWP를 멘션하세요.',
  '카드의 형식·쪽 선택에서 원문 TXT 또는 선택 쪽 PNG ZIP을 받으세요. ZIP은 1~200쪽 중 최대 10쪽을 1,3-5,12처럼 선택할 수 있습니다. 실제 문서에 없는 쪽은 처리하지 않습니다.',
  'TXT는 원문 전체의 추출 가능한 글자만 담으며 이미지 속 글자(OCR)·수식·표 배치 복원은 지원하지 않습니다.',
  '변환 결과는 원본 메시지의 스레드에 공유합니다. Markdown ZIP의 document.md를 읽고 report.json의 검토 항목을 확인하세요. 이미지 속 글자는 OCR하지 않습니다.',
  '수정이 필요하면 문서 편집 (RHWP)을 선택하세요. 편집본은 새 파일로 저장합니다.',
].join('\n');
export function parseFileLink(raw: string, workspaceHost: string): string {
  let value=raw.trim();
  if (value.startsWith('<')) {
    const match=/^<([^<>|\s]+)(?:\|[^<>]+)?>$/.exec(value);
    if (!match) throw new UserError('invalid_link','Slack 파일 링크 하나를 입력하세요.');
    value=match[1];
  }
  if (/[\s\\]/.test(value)) throw new UserError('invalid_link','지원되지 않는 Slack 파일 링크입니다.');
  let url: URL;
  try {url=new URL(value);} catch {throw new UserError('invalid_link','Slack 파일 URL을 입력하세요. 붙여넣기 후 파일명으로 바뀌면 한 번 실행 취소해 URL로 되돌리거나 메시지 메뉴의 동국 한글문서 변환을 사용하세요.');}
  if (!value.startsWith(`https://${workspaceHost}/files/`)) throw new UserError('invalid_link','현재 워크스페이스의 Slack 파일 링크를 입력하세요.');
  const rawPath=value.slice(`https://${workspaceHost}`.length);
  const match=/^\/files\/([UW][A-Z0-9]+)\/(F[A-Z0-9]+)(?:\/[^/]+)?\/?$/.exec(rawPath);
  if (url.protocol!=='https:' || url.hostname!==workspaceHost || url.port || url.username || url.password || url.search || url.hash || !match || !ID.file.test(match[2])) {
    throw new UserError('invalid_link','현재 워크스페이스의 Slack 파일 링크만 지원합니다. 메시지 링크와 외부 주소는 사용할 수 없습니다.');
  }
  if (match) {
    try {
      const filename=decodeURIComponent(rawPath.split('/')[4]??'');
      if (filename==='.' || filename==='..' || /[\\/\u0000-\u001f]/.test(filename)) throw new Error();
    } catch {throw new UserError('invalid_link','파일 링크의 이름 인코딩이 올바르지 않습니다.');}
  }
  return match[2];
}
export function parseCommand(text: string, host: string): Command {
  if (text.length>4096) throw new UserError('invalid_command','명령이 너무 깁니다.');
  const value=text.trim();
  if (!value || value==='help') return {kind:'help'};
  const match=/^(\S+)(?:\s+([\s\S]+))?$/.exec(value)!;
  if (['thumbnail','zip'].includes(match[1])) throw new UserError('not_supported','이미지는 /dhwp png <Slack 파일 링크>로 앞 10쪽까지 받을 수 있습니다. 선택 쪽 PNG ZIP은 문서 카드의 형식·쪽 선택에서 요청하세요.');
  if (!['open','edit','pdf','png','md','markdown'].includes(match[1]) || !match[2]) throw new UserError('invalid_command','/dhwp pdf <Slack 파일 링크>, /dhwp png <Slack 파일 링크>, /dhwp md <Slack 파일 링크> 또는 /dhwp help를 사용하세요.');
  const mode:Mode=match[1]==='pdf'?'pdf':match[1]==='png'?'png':['md','markdown'].includes(match[1])?'markdown':'open';
  return {kind:'prepare',mode,fileId:parseFileLink(match[2],host)};
}
