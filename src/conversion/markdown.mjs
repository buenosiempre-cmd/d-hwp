import {MAX_MARKDOWN_BYTES} from './frames.mjs';
import {ConversionFailure} from './failures.mjs';

const NOTICE = '# 문서 텍스트\n\n'
  + '> HWP/HWPX에서 추출한 텍스트 기반 Markdown입니다. 표의 셀 병합·열 구조, 글꼴·배치·쪽 나눔, 그림·수식의 시각적 표현은 보존하지 않습니다. 이미지 속 글자는 OCR하지 않았습니다. 원본 또는 PDF와 함께 확인하세요.\n\n';
const punctuation = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g;
const escapeLine = line => line.replace(punctuation, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[char] ?? '\\' + char))
  // An indented source line must not turn escaped text into a Markdown code block.
  .replace(/^[ \t]+/, prefix => [...prefix].map(char => char === '\t' ? '&#9;' : '&#32;').join(''));

/** RHWP returns a JSON string, not a document tree. Do not infer missing structure. */
export function markdownFromUnicode(serialized) {
  if (typeof serialized !== 'string') throw new ConversionFailure('conversion_error');
  // A JSON escape can occupy six characters for one source character.
  if (serialized.length > MAX_MARKDOWN_BYTES * 6 + 2) throw new ConversionFailure('markdown_size');
  let text;
  try { text = JSON.parse(serialized); } catch { throw new ConversionFailure('conversion_error'); }
  if (typeof text !== 'string') throw new ConversionFailure('conversion_error');
  if (Buffer.byteLength(text) > MAX_MARKDOWN_BYTES) throw new ConversionFailure('markdown_size');
  const parts = [NOTICE];
  if (!text.trim()) parts.push('> 추출된 텍스트가 없습니다. 그림으로 된 내용은 원본 또는 PDF에서 확인하세요.\n\n');
  let size = parts.reduce((total, part) => total + Buffer.byteLength(part), 0);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    // Escape every ASCII punctuation character, including URL/email separators,
    // so source text cannot introduce links, images, HTML, headings or fences.
    const part = escapeLine(lines[index]) + (index < lines.length - 1 ? '  \n' : '\n');
    size += Buffer.byteLength(part);
    if (size > MAX_MARKDOWN_BYTES) throw new ConversionFailure('markdown_size');
    parts.push(part);
  }
  return Buffer.from(parts.join(''), 'utf8');
}
