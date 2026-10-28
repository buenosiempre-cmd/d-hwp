import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {HwpDocument} from '@rhwp/core';
import {makeComplexDocument} from '../helpers/structured-document.mjs';
import {convertMarkdown,convertMarkdownPackage,closeConversionRuntime,MAX_MARKDOWN_BYTES,MAX_MARKDOWN_PACKAGE_BYTES} from '../../src/conversion/convert.mjs';
import {readArchive} from '../../src/conversion/archive.mjs';

let fixturePromise;
const fixture=()=>fixturePromise??=makeComplexDocument();
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const restoreLiteral=markdown=>markdown
  .replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g,'$1')
  .replace(/&#(?:32|x20);/gi,' ').replace(/&#(?:9|x9);/gi,'\t')
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
const omittedByOldExtraction=['header','footer','footnote','endnote','equation','fieldMemo','fieldName','imageDescription','linkUri'];

function assertStructuredContent(markdown,expected){
  const visible=restoreLiteral(markdown);
  for(const key of ['bodyStart','bodyEnd','header','footer','footnote','endnote','footnoteAnchor','endnoteAnchor','equation','textbox','fieldGuide','fieldMemo','fieldName','imageDescription','linkText','linkUri','outerCell','hostile']){
    assert.ok(visible.includes(expected[key]),`missing ${key}: ${expected[key]}`);
  }
  for(const value of [...expected.mergedCells,...expected.nestedCells])assert.ok(visible.includes(value),`missing cell: ${value}`);
  assert.ok(visible.indexOf(expected.bodyStart)<visible.indexOf(expected.bodyEnd),'body order');
  assert.ok(visible.indexOf(expected.outerCell)<visible.indexOf(expected.nestedCells[0]),'nested table follows its parent cell text');
  assert.doesNotMatch(markdown,/<script\b|<img\b|<iframe\b/i,'source HTML must remain literal text');
  assert.doesNotMatch(markdown,/!\[[^\]]*\]\(https?:/i,'source text cannot load remote tracking images');
  assert.doesNotMatch(markdown,/\]\(javascript:/i,'source text cannot generate executable links');
}

for(const format of ['hwp','hwpx']){
  test(`synthetic ${format} proves Unicode-only extraction loses separately stored document content`,async()=>{
    const f=await fixture(),doc=new HwpDocument(f[format]);
    try{
      const unicode=JSON.parse(doc.getTextFileUnicode());
      assert.ok(unicode.includes(f.expected.bodyStart));
      for(const key of omittedByOldExtraction)assert.equal(unicode.includes(f.expected[key]),false,key);
      const controls=JSON.parse(doc.getControls());
      for(const type of ['head','foot','fn','en','eqed'])assert.ok(controls.some(control=>control.ctrlId===type),type);
      assert.ok(controls.some(control=>control.ctrlId==='tbl'&&control.list!==0),'nested table must survive source serialization');
    }finally{doc.free();}
  });

  test(`real ${format} structured Markdown retains every independent content marker and source order`,async()=>{
    const f=await fixture(),events=[];
    const markdown=await convertMarkdown(f[format],{timeoutMs:120_000,onPdf:()=>events.push('pdf'),onPage:()=>events.push('page')});
    assert.ok(markdown.length<=MAX_MARKDOWN_BYTES);
    assertStructuredContent(markdown.toString('utf8'),f.expected);
    assert.deepEqual(events,[],'document-content conversion does not publish intermediate visual artifacts');
  });

  test(`real ${format} Markdown package includes exact original, image bytes, merged/nested cells and auditable coverage`,async()=>{
    const f=await fixture(),result=await convertMarkdownPackage(f[format],{timeoutMs:120_000,onPage:()=>assert.fail('package must not publish partial PNGs')});
    assert.ok(result.zip.length<=MAX_MARKDOWN_PACKAGE_BYTES);
    const entries=readArchive(result.zip),sourceName=`source/original.${format}`;
    assert.match(entries.get('README.md').toString(),/문서 읽기와 대조 안내/);
    assert.deepEqual(entries.get('document.md'),result.markdown);
    assert.deepEqual(entries.get(sourceName),f[format],'the original is preserved byte for byte');
    const report=JSON.parse(entries.get('report.json').toString('utf8'));
    assert.deepEqual(report,result.report);
    assert.equal(report.schemaVersion,1);assert.equal(report.packageVersion,3);
    assert.deepEqual(report.source,{format,bytes:f[format].length,sha256:sha256(f[format])},'the audit report identifies the exact source bytes');
    assert.equal(report.coverage.unaccountedTextNodes,0);
    assert.equal(report.coverage.xmlTextNodes,report.coverage.renderedTextNodes);
    assert.equal(report.coverage.xmlTextCharacters,report.coverage.renderedTextCharacters);
    assert.ok(report.coverage.xmlTextNodes>0);
    for(const type of ['tables','cells','images','footnotes','endnotes','headers','footers','equations','textBoxes','fields'])assert.ok(report.counts[type]>0,`missing count ${type}`);
    assert.ok(report.counts.tables>=3,'merged + outer + real nested tables');
    const merged=report.tables.find(table=>table.rows===3&&table.columns===3);
    assert.ok(merged,'the 3 by 3 source table is identified');
    assert.equal(merged.cells.length,7,'two merges retain seven source cells');
    assert.ok(merged.cells.some(cell=>cell.row===1&&cell.column===1&&cell.colSpan===2&&cell.rowSpan===1),'horizontal merge keeps its source coordinates');
    assert.ok(merged.cells.some(cell=>cell.row===2&&cell.column===3&&cell.rowSpan===2&&cell.colSpan===1),'vertical merge keeps its source coordinates');
    assert.ok(report.tables.every(table=>table.cells.every(cell=>cell.row>=1&&cell.column>=1&&cell.rowSpan>=1&&cell.colSpan>=1)));
    const asset=report.assets.find(item=>item.sha256===f.expected.imageSha256);
    assert.ok(asset,'original picture bytes appear in the asset inventory');
    assert.match(asset.name,/^assets\/[a-f0-9]{64}\.png$/);
    assert.deepEqual(entries.get(asset.name),f.expected.image);
    assert.equal(sha256(entries.get(asset.name)),asset.sha256);
    assert.equal(entries.get(asset.name).length,asset.bytes);
    assert.ok(result.markdown.toString().includes(asset.name),'Markdown uses a local packaged image reference');
    assert.equal(report.status,'needs_review','preserved image bytes are not an OCR or visual-understanding guarantee');
    assert.ok(report.issues.some(issue=>/ocr|image|visual/i.test(issue.code)),'uninterpreted visual content must be disclosed');
    assertStructuredContent(result.markdown.toString('utf8'),f.expected);
  });
}

after(async()=>{await closeConversionRuntime();});
