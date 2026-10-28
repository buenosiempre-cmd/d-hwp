// Independent reference check using synthetic documents only; no production dependency.
// node scripts/audit-markdown-kordoc.mjs --module /absolute/kordoc/dist/index.js --output .cache/task11/kordoc-audit.json
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {makeComplexDocument} from '../tests/helpers/structured-document.mjs';
import {convertMarkdownPackage,closeConversionRuntime} from '../src/conversion/convert.mjs';

const args=process.argv.slice(2);
if(args.length!==4||args[0]!=='--module'||!isAbsolute(args[1])||args[2]!=='--output')throw new Error('Specify an absolute installed Kordoc module and an output JSON path.');
const kordoc=await import(pathToFileURL(args[1]).href);
assert.equal(typeof kordoc.parse,'function');
const options={ocr:false,formulaOcr:false,removeHeaderFooter:false,scriptTags:true,plain:false,tableFormat:'gfm',keepTrailingEmptyCols:true,layoutTables:'keep',keepEmptyParagraphs:true,includeFieldPlaceholders:true,dedupeRunningHeaders:false};
const literal=value=>value.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g,'$1').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const f=await makeComplexDocument();
const checks=Object.fromEntries(Object.entries(f.expected).filter(([key,value])=>typeof value==='string'&&!['equation','hostile','imageSha256'].includes(key)));
checks.equationMarker='EQCHECK';
f.expected.mergedCells.forEach((value,i)=>checks['mergedCell'+(i+1)]=value);
f.expected.nestedCells.forEach((value,i)=>checks['nestedCell'+(i+1)]=value);
const audit={schemaVersion:1,reference:{engine:'kordoc',version:kordoc.VERSION??'unknown',options},scope:'Synthetic marker presence only; not a universal fidelity or OCR guarantee. Equation check is identifier presence, not mathematical equivalence.',formats:{}};
try{
 for(const format of ['hwp','hwpx']){
  const reference=await kordoc.parse(f[format],options);assert.equal(reference.success,true,'Kordoc reference parse');
  const actual=await convertMarkdownPackage(f[format],{timeoutMs:120_000});
  const compare=markdown=>Object.fromEntries(Object.entries(checks).map(([name,value])=>[name,literal(markdown).includes(value)]));
  const dHwp=compare(actual.markdown.toString()),referenceMarkers=compare(reference.markdown);
  const missing=Object.keys(dHwp).filter(key=>!dHwp[key]);
  audit.formats[format]={markerCount:Object.keys(checks).length,dHwp,reference:referenceMarkers,dHwpMissing:missing,referenceMissing:Object.keys(referenceMarkers).filter(key=>!referenceMarkers[key]),coverage:actual.report.coverage,counts:actual.report.counts,status:actual.report.status,issueCodes:[...new Set(actual.report.issues.map(issue=>issue.code))]};
  assert.deepEqual(missing,[],`${format}: D-HWP must retain every independent marker`);
 }
 await writeFile(resolve(args[3]),JSON.stringify(audit,null,2)+'\n');
 console.log(JSON.stringify({referenceVersion:audit.reference.version,formats:Object.fromEntries(Object.entries(audit.formats).map(([format,item])=>[format,{markers:item.markerCount,dHwpMissing:item.dHwpMissing,referenceMissing:item.referenceMissing,status:item.status}]))}));
}finally{await closeConversionRuntime();}
