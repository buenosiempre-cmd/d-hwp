// Repeatable public-fixture gate. No Kordoc dependency, user documents or credentials.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {convertMarkdownPackage,closeConversionRuntime} from '../src/conversion/convert.mjs';
import {readArchive} from '../src/conversion/archive.mjs';

const MAX_FIXTURE_BYTES=1024*1024,MAX_CORPUS_BYTES=4*1024*1024;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
class CorpusError extends Error {constructor(code){super(code);this.code=code;}}
const fail=code=>{throw new CorpusError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validateRegistry(registry){
 if(!object(registry)||registry.schemaVersion!==1||!Array.isArray(registry.documents)||!registry.documents.length||registry.documents.length>16)fail('registry_invalid');
 const ids=new Set();let total=0;
 for(const item of registry.documents){
  if(!object(item)||!/^[-a-z0-9]{1,80}$/.test(item.id)||ids.has(item.id)||!['hwp','hwpx'].includes(item.format)||!['edwardkim/rhwp','chrisryugj/kordoc'].includes(item.repository)||!/^[a-f0-9]{40}$/.test(item.commit)||!/^[a-f0-9]{64}$/.test(item.sha256))fail('registry_invalid');
  if(typeof item.path!=='string'||item.path.startsWith('/')||item.path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\u0000-\u001f?#]/.test(item.path)||!item.path.endsWith('.'+item.format))fail('registry_invalid');
  let url;try{url=new URL(item.url);}catch{fail('registry_invalid');}
  let pathname;try{pathname=decodeURIComponent(url.pathname);}catch{fail('registry_invalid');}
  if(url.origin!=='https://raw.githubusercontent.com'||url.username||url.password||url.search||url.hash||pathname!=='/'+item.repository+'/'+item.commit+'/'+item.path)fail('registry_invalid');
  if(!Number.isSafeInteger(item.bytes)||item.bytes<8||item.bytes>MAX_FIXTURE_BYTES||(total+=item.bytes)>MAX_CORPUS_BYTES||item.license?.spdx!=='MIT'||item.license.url!==`https://github.com/${item.repository}/blob/${item.commit}/LICENSE`)fail('registry_invalid');
  const expected=item.expected;
  if(!object(expected)||!Array.isArray(expected.text)||!expected.text.length||expected.text.length>200||expected.text.some(value=>typeof value!=='string'||!value.length||value.length>4096)||!object(expected.counts)||!Object.keys(expected.counts).length)fail('registry_invalid');
  for(const[key,value]of Object.entries(expected.counts))if(!['sections','paragraphs','tables','cells','images','footnotes','endnotes','headers','footers','equations','textBoxes','fields'].includes(key)||!Number.isSafeInteger(value)||value<0||value>200000)fail('registry_invalid');
  if(expected.pageCount!==undefined&&(!Number.isSafeInteger(expected.pageCount)||expected.pageCount<1||expected.pageCount>200))fail('registry_invalid');
  if(expected.minimumRasterAssets!==undefined&&(!Number.isSafeInteger(expected.minimumRasterAssets)||expected.minimumRasterAssets<0||expected.minimumRasterAssets>100))fail('registry_invalid');
  if(expected.cellText!==undefined&&(!Array.isArray(expected.cellText)||expected.cellText.length>100||expected.cellText.some(cell=>!object(cell)||['table','row','column'].some(key=>!Number.isSafeInteger(cell[key])||cell[key]<1||cell[key]>10000)||typeof cell.text!=='string'||!cell.text.length||cell.text.length>4096)))fail('registry_invalid');
  if(expected.requiredIssueCodes!==undefined&&(!Array.isArray(expected.requiredIssueCodes)||expected.requiredIssueCodes.length>20||expected.requiredIssueCodes.some(code=>typeof code!=='string'||!/^[a-z_]{1,80}$/.test(code))))fail('registry_invalid');
  ids.add(item.id);
 }
 return registry.documents;
}

function verifySource(bytes,item){if(bytes.length!==item.bytes)fail('source_size_mismatch');if(digest(bytes)!==item.sha256)fail('source_hash_mismatch');return bytes;}
export async function obtainFixture(item,{cacheDir,offline=false,fetcher=fetch}={}){
 const folder=resolve(cacheDir,item.id),path=resolve(folder,'source.'+item.format);
 try{const info=await stat(path);if(!info.isFile()||info.size!==item.bytes)fail('source_size_mismatch');return verifySource(await readFile(path),item);}
 catch(error){if(error.code!=='ENOENT')throw error;if(offline)fail('offline_fixture_missing');}
 const response=await fetcher(item.url,{redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok||!response.body)fail('source_fetch_failed');
 if(response.url&&response.url!==item.url) {await response.body.cancel();fail('source_redirect_rejected');}
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>item.bytes){await reader.cancel();fail('source_size_mismatch');}chunks.push(part.value);}}
 finally{reader.releaseLock();}
 const bytes=verifySource(Buffer.concat(chunks,length),item);await mkdir(folder,{recursive:true});await writeFile(path,bytes);return bytes;
}

// Decode only the literal escaping the exporter uses. This is not a Markdown
// renderer or a claim that arbitrary formatting/semantics match the source.
const restoreLiteral=value=>value.replace(/\\([\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e])/g,'$1').replace(/&#(\d+);/g,(match,number)=>Number(number)<=0x10ffff?String.fromCodePoint(Number(number)):match).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export function verifyPackage(item,source,result){
 const entries=readArchive(result.zip),report=JSON.parse(entries.get('report.json')?.toString('utf8')??'null');
 if(!Buffer.isBuffer(result.markdown)||!entries.get('document.md')?.equals(result.markdown)||JSON.stringify(report)!==JSON.stringify(result.report)||report?.schemaVersion!==1)fail('package_report_mismatch');
 if(!entries.get('source/original.'+item.format)?.equals(source)||report.source?.sha256!==item.sha256||report.source?.bytes!==item.bytes||report.source?.format!==item.format)fail('package_source_mismatch');
 if(item.format==='hwp'&&!entries.has('source/structure.hwpx'))fail('package_structure_missing');
 const markdown=result.markdown.toString('utf8'),section=markdown.indexOf('\n## 구역 1\n');
 if(section<0)fail('document_sections_missing');
 const appendix=markdown.indexOf('\n## 이름·설명·링크 등 부가 속성\n',section);
 // A marker appearing only in package metadata must not hide missing body content.
 const text=restoreLiteral(markdown.slice(section,appendix<0?undefined:appendix));
 if(item.expected.text.some(value=>!text.includes(value)))fail('expected_text_missing');
 for(const cell of item.expected.cellText??[]){
  const match=new RegExp('\\*\\*table-'+cell.table+'-r'+cell.row+'c'+cell.column+' [^\\n]+\\*\\*\\n\\n([^\\n]+)').exec(text);
  if(!match||match[1]!==cell.text)fail('expected_cell_text_mismatch');
 }
 if(Object.entries(item.expected.counts).some(([key,value])=>report.counts?.[key]!==value))fail('expected_structure_mismatch');
 if(item.expected.pageCount!==undefined&&report.pageCount!==item.expected.pageCount)fail('expected_page_count_mismatch');
 if(!Array.isArray(report.assets))fail('package_asset_inventory_missing');
 for(const asset of report.assets){const bytes=entries.get(asset.name);if(!bytes||bytes.length!==asset.bytes||digest(bytes)!==asset.sha256)fail('package_asset_mismatch');}
 if(item.expected.minimumRasterAssets!==undefined&&report.assets.filter(asset=>/^image\/(png|jpeg|gif|webp)$/.test(asset.mime)).length<item.expected.minimumRasterAssets)fail('expected_images_missing');
 const coverage=report.coverage;
 if(!coverage||coverage.unaccountedTextNodes!==0||coverage.xmlTextNodes!==coverage.renderedTextNodes||coverage.xmlTextCharacters!==coverage.renderedTextCharacters)fail('xml_coverage_mismatch');
 if(!Array.isArray(report.issues)||(item.expected.requiredIssueCodes??[]).some(code=>!report.issues.some(issue=>issue.code===code)))fail('expected_review_warning_missing');
 return {passed:true,sourceSha256:item.sha256,sourceBytes:source.length,markerCount:item.expected.text.length,counts:report.counts,pageCount:report.pageCount,assetRecords:report.assets.length,markdownBytes:result.markdown.length,packageBytes:result.zip.length,status:report.status,issueCodes:[...new Set(report.issues.map(issue=>issue.code))]};
}

async function main(){
 let offline=false,cacheDir='.cache/public-documents',output;
 const args=process.argv.slice(2);
 for(let i=0;i<args.length;i++){if(args[i]==='--offline')offline=true;else if(args[i]==='--cache-dir'&&args[i+1])cacheDir=args[++i];else if(args[i]==='--output'&&args[i+1])output=args[++i];else fail('arguments_invalid');}
 const registry=JSON.parse(await readFile('tests/corpus/public-documents.json','utf8')),documents=validateRegistry(registry),results=[];
 try{for(const item of documents){try{const source=await obtainFixture(item,{cacheDir,offline}),result=await convertMarkdownPackage(source,{timeoutMs:120000});results.push({id:item.id,...verifyPackage(item,source,result)});}catch(error){results.push({id:item.id,passed:false,error:error instanceof CorpusError?error.code:typeof error?.code==='string'&&/^conversion_[a-z_]+$/.test(error.code)?error.code:'verification_failed'});}}}
 finally{await closeConversionRuntime();}
 const summary={schemaVersion:1,scope:registry.scope,offline,total:results.length,passed:results.filter(item=>item.passed).length,failed:results.filter(item=>!item.passed).length,results};
 const reportPath=resolve(output??resolve(cacheDir,'report.json'));await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify(summary));if(summary.failed)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error(JSON.stringify({passed:false,error:'public_corpus_setup_failed'}));process.exitCode=1;});
