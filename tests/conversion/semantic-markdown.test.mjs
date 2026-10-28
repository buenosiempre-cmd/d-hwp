import test from 'node:test';
import assert from 'node:assert/strict';
import {extractStructuredMarkdown} from '../../src/conversion/structured-markdown.mjs';
import {structuralDocument,paragraph} from '../helpers/semantic-hwpx.mjs';

const extract=(body,options={})=>extractStructuredMarkdown({hwpx:structuralDocument(body,options),sourceFormat:'hwpx',pageCount:12});
const literal=text=>text.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g,'$1').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');

test('switch branches preserve both representations with explicit alternative relationships',()=>{
  const caption='<hp:caption><hp:subList>'+paragraph('동일 캡션 150만원')+'</hp:subList></hp:caption>';
  const result=extract('<hp:p><hp:run><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"><hp:chart id="1">'+caption+'</hp:chart></hp:case><hp:default><hp:ole id="1">'+caption+'</hp:ole></hp:default></hp:switch></hp:run></hp:p>');
  const text=literal(result.markdown.toString());
  assert.equal(text.split('동일 캡션 150만원').length-1,2,'neither source representation is silently discarded');
  assert.ok(text.includes('대체 표현 묶음 1'));assert.ok(text.includes('조건부 표현 1'));assert.ok(text.includes('호환용 대체 표현 2'));
  assert.ok(text.indexOf('조건부 표현 1')<text.indexOf('동일 캡션 150만원'));
  assert.ok(text.indexOf('호환용 대체 표현 2')<text.lastIndexOf('동일 캡션 150만원'));
  assert.equal(result.report.counts.alternativeGroups,1);
  assert.equal(result.report.alternatives[0].selection,'not_resolved');
  assert.deepEqual(result.report.alternatives[0].branches.map(branch=>branch.kind),['case','default']);
  assert.ok(result.report.issues.some(issue=>issue.code==='alternative_representations'));
  assert.equal(result.report.coverage.xmlTextNodes,result.report.coverage.renderedTextNodes);
});

test('outline numbering keeps format, start and definition references while disclosing unresolved counters',()=>{
  const header='<head><paraPr id="1"><heading type="OUTLINE" idRef="1" level="0"/></paraPr><numbering id="1" start="4"><paraHead level="1" numFormat="ROMAN_CAPITAL">^1.</paraHead></numbering></head>';
  const result=extract('<hp:p paraPrIDRef="1"><hp:run><hp:t>첫 절</hp:t></hp:run></hp:p><hp:p paraPrIDRef="1"><hp:run><hp:t>둘째 절</hp:t></hp:run></hp:p>',{extra:{'Contents/header.xml':header}});
  const text=literal(result.markdown.toString());
  for(const value of ['OUTLINE','idRef=1','ROMAN_CAPITAL','/@start: 4','^1.','첫 절','둘째 절'])assert.ok(text.includes(value),value);
  assert.equal(result.report.issues.filter(issue=>issue.code==='numbering_requires_review').length,2);
  assert.equal(result.report.status,'needs_review');
});

test('tracked deletions and insertions have explicit historical boundaries across paragraphs',()=>{
  const result=extract('<hp:p><hp:run><hp:t>확정 금액: </hp:t><hp:ctrl><hp:deleteBegin id="2"/></hp:ctrl><hp:t>100만원</hp:t></hp:run></hp:p><hp:p><hp:run><hp:ctrl><hp:deleteEnd id="2"/><hp:insertBegin id="3"/></hp:ctrl><hp:t>150만원</hp:t><hp:ctrl><hp:insertEnd id="3"/></hp:ctrl></hp:run></hp:p>');
  const text=literal(result.markdown.toString());
  const start=text.indexOf('삭제된 내용 시작'),old=text.indexOf('100만원'),end=text.indexOf('삭제된 내용 끝');
  assert.ok(start<old&&old<end);
  assert.ok(text.indexOf('삽입된 내용 시작')<text.indexOf('150만원'));assert.ok(text.indexOf('150만원')<text.indexOf('삽입된 내용 끝'));
  assert.equal(result.report.counts.trackedDeletions,1);assert.equal(result.report.counts.trackedInsertions,1);
  assert.deepEqual(result.report.changes.map(change=>change.kind),['delete','insert']);
  assert.ok(result.report.changes.every(change=>change.endPath));
  assert.ok(result.report.issues.some(issue=>issue.code==='tracked_changes_present'));
  assert.equal(result.report.issues.some(issue=>issue.code==='unbalanced_change_markers'),false);
});

test('change markers in a note cannot close a deletion in its host body',()=>{
  const result=extract('<hp:p><hp:run><hp:ctrl><hp:deleteBegin id="outer"/><hp:footNote><hp:subList><hp:p><hp:run><hp:deleteEnd id="foreign"/><hp:t>각주</hp:t></hp:run></hp:p></hp:subList></hp:footNote><hp:deleteEnd id="outer"/></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>');
  assert.equal(result.report.changes.length,1);assert.ok(result.report.changes[0].endPath);
  assert.equal(result.report.issues.filter(issue=>issue.code==='unbalanced_change_markers').length,1);
  const open=extract('<hp:p><hp:run><hp:deleteBegin id="unclosed"/><hp:t>끝나지 않은 삭제</hp:t></hp:run></hp:p>');
  assert.equal(open.report.changes[0].endPath,null);
  assert.ok(open.report.issues.some(issue=>issue.code==='unbalanced_change_markers'));
});

test('text boxes have independent tracked-change boundaries',()=>{
  const result=extract('<hp:p><hp:run><hp:ctrl><hp:deleteBegin id="body"/></hp:ctrl><hp:rect><hp:drawText><hp:subList><hp:p><hp:run><hp:deleteEnd id="box"/><hp:t>글상자</hp:t></hp:run></hp:p></hp:subList></hp:drawText></hp:rect><hp:ctrl><hp:deleteEnd id="body"/></hp:ctrl></hp:run></hp:p>');
  assert.equal(result.report.changes.length,1);assert.ok(result.report.changes[0].endPath);
  assert.equal(result.report.issues.filter(issue=>issue.code==='unbalanced_change_markers').length,1);
});

test('PAGE and TOTAL_PAGE control values cannot masquerade as resolved displayed numbers',()=>{
  const result=extract('<hp:p><hp:run><hp:ctrl><hp:autoNum num="1" numType="PAGE"/><hp:autoNum num="1" numType="TOTAL_PAGE"/></hp:ctrl></hp:run></hp:p>');
  const text=literal(result.markdown.toString());
  assert.ok(text.includes('동적 쪽 번호: 실제 표시값 확인 필요'));assert.ok(text.includes('동적 전체 쪽 수: 실제 표시값 확인 필요'));
  assert.ok(text.includes('원본 제어값 num=1, numType=PAGE'));assert.ok(text.includes('원본 제어값 num=1, numType=TOTAL_PAGE'));
  assert.equal(result.report.counts.dynamicNumbers,2);
  assert.equal(result.report.issues.filter(issue=>issue.code==='dynamic_page_number_requires_review').length,2);
});

test('adjacent bold runs retain AB without producing authored-looking Markdown stars',()=>{
  const result=extract('<hp:p><hp:run charPrIDRef="1"><hp:t>A</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>B</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>C</hp:t></hp:run><hp:run charPrIDRef="3"><hp:t>D</hp:t></hp:run></hp:p>',{extra:{'Contents/header.xml':'<head><charPr id="1"><bold/></charPr><charPr id="2"><italic/></charPr><charPr id="3"><bold/><italic/></charPr></head>'}});
  const text=result.markdown.toString();
  assert.ok(text.includes('〔굵게: AB〕'));assert.ok(text.includes('〔기울임: C〕'));assert.ok(text.includes('〔기울임: 〔굵게: D〕〕'));
  assert.doesNotMatch(text,/\*\*A|A\*{2,}B|\*C\*/);
  assert.equal(result.report.coverage.xmlTextCharacters,4);
});

test('literal Markdown and HTML inside formatted or alternative text stay inert',()=>{
  const hostile='![외부](https://example.invalid/x) <script>alert(1)</script> **원문**';
  const result=extract('<hp:p><hp:run charPrIDRef="1"><hp:t>'+hostile.replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</hp:t></hp:run></hp:p>',{extra:{'Contents/header.xml':'<head><charPr id="1"><bold/></charPr></head>'}});
  const text=result.markdown.toString();assert.ok(literal(text).includes(hostile));
  assert.doesNotMatch(text,/<script|!\[[^\]]*\]\(https?:|\*\*원문\*\*/);
});

test('repeated review issues are summarized without losing detailed records or metadata',()=>{
  const result=extract(Array.from({length:48},(_,index)=>`<hp:p vendorValue="추가속성${index}"><hp:run><hp:t>본문${index}</hp:t></hp:run></hp:p>`).join(''));
  const text=literal(result.markdown.toString()),intro=text.slice(0,text.indexOf('## 구역'));
  assert.ok(intro.includes('추가 속성 확인 48건'));
  assert.equal(intro.split('unknown_attributes').length-1,1,'the front matter gives one summary per category');
  assert.equal(result.report.issues.filter(issue=>issue.code==='unknown_attributes').length,48);
  assert.equal(new Set(result.report.issues.map(issue=>issue.sourcePath)).size,48);
  for(let index=0;index<48;index++)assert.ok(text.includes('추가속성'+index));
  assert.ok(result.report.issues.every(issue=>issue.message&&issue.sourcePath));
});
