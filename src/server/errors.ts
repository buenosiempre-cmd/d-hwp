export class UserError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function denied(): never {
  throw new UserError('access_denied', '문서 접근 권한을 확인할 수 없습니다. 앱과 요청자가 참여한 허용 채널의 파일인지 확인하세요.');
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied();
  return value as Record<string, unknown>;
}
export function userMessage(error: unknown): string {
  const messages:Record<string,string>={
    conversion_page_selection:'선택한 쪽이 문서 범위를 벗어났거나 올바르지 않습니다. 실제 문서의 1~200쪽 중 최대 10쪽을 선택해 주세요.',
    conversion_text_limit:'추출한 TXT가 2 MiB 제한을 초과했습니다. 원본 또는 PDF에서 필요한 내용을 확인해 주세요.',
    conversion_text_empty:'추출할 텍스트가 없습니다. 그림 속 글자는 OCR하지 않으므로 원본 또는 PDF를 확인해 주세요.',
    conversion_zip_limit:'PNG ZIP이 26 MiB 제한을 초과했습니다. 선택한 쪽 수를 줄여 다시 요청해 주세요.',
  };
  try{const code=(error as {code?:unknown}|undefined)?.code;if(typeof code==='string'&&Object.hasOwn(messages,code))return messages[code];}catch{/* Do not inspect hostile exception properties further. */}
  return error instanceof UserError ? error.message : '요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.';
}
