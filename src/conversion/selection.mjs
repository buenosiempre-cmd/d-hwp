export const MAX_SELECTED_PAGES=10;
export const MAX_DOCUMENT_PAGES=200;

/** Copy before queueing so callers cannot change the document selection in flight. */
export function normalizeSelectedPages(value){
  if(!Array.isArray(value)||!value.length||value.length>MAX_DOCUMENT_PAGES)throw new RangeError('페이지 선택이 올바르지 않습니다.');
  for(const page of value)if(!Number.isSafeInteger(page)||page<1||page>MAX_DOCUMENT_PAGES)throw new RangeError('페이지 선택이 올바르지 않습니다.');
  const pages=[...new Set(value)].sort((a,b)=>a-b);
  if(pages.length>MAX_SELECTED_PAGES)throw new RangeError('한 번에 최대 10쪽을 선택하세요.');
  return pages;
}
