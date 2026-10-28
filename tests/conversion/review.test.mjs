import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewMarkdown} from '../../src/conversion/review.mjs';
import {readArchive,writeArchive} from '../../src/conversion/archive.mjs';

test('the short entry point groups repeated issues without losing the detailed report',()=>{
 const report={counts:{tables:2,cells:8},issues:Array.from({length:48},()=>({code:'unknown_attributes',sourcePath:'Contents/header.xml'})),source:{format:'hwp',bytes:123,sha256:'a'.repeat(64)}};
 const before=structuredClone(report),readme=reviewMarkdown(report);
 assert.match(readme.toString(),/48건/);assert.equal((readme.toString().match(/unknown/g)||[]).length,1);
 assert.match(readme.toString(),/OCR은 실행하지 않았습니다/);assert.match(readme.toString(),/완전성을 보장하지 않습니다/);
 assert.deepEqual(report,before);
 const archive=writeArchive([{name:'README.md',bytes:readme},{name:'report.json',bytes:Buffer.from(JSON.stringify(report))}]);
 assert.deepEqual(readArchive(archive).get('README.md'),readme);
});

test('OCR entry point distinguishes supplemental recognition from source text completeness',()=>{
 const output=reviewMarkdown({counts:{},issues:[{code:'ocr_requires_review'},{code:'unknown_<script>'}],ocr:{status:'needs_review'}}).toString();
 assert.match(output,/인식 오류/);assert.match(output,/날짜·금액/);assert.doesNotMatch(output,/<script>|완벽|100%/);
 assert.match(output,/&lt;script&gt;/);
});
