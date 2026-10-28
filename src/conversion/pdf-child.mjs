// One fresh thread per document inside a credential-free conversion process.
import init, { HwpDocument } from '@rhwp/core';
import { chromium } from '@playwright/test';
import {workerData,parentPort} from 'node:worker_threads';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {ConversionFailure} from './failures.mjs';
import {extractStructuredMarkdown} from './structured-markdown.mjs';
import {readArchive,writeArchive} from './archive.mjs';
import {MAX_MARKDOWN_BYTES,MAX_MARKDOWN_REPORT_BYTES,MAX_MARKDOWN_PACKAGE_BYTES} from './frames.mjs';
import {textFromUnicode} from './text.mjs';
import {normalizeSelectedPages} from './selection.mjs';
import { resolve } from 'node:path';
import {routeFont} from './font-routes.mjs';
import { validateInput, MAX_PAGES } from '../shared/errors.ts';
import { createPrintPage } from '../../.cache/studio-source/rhwp-studio/src/command/print-pages.ts';
console.log=console.info=console.warn=()=>{};
let pageNumber,pageCount,svgBytes=0,operation,failureReason;
let browser,context,doc,stage='input',started=performance.now();
function metric(phase){try{parentPort.postMessage({stage,phase,...(phase==='failed'?{failureReason,pageNumber,pageCount,svgBytes}:{}),...(phase==='start'?{}:{durationMs:Math.round(performance.now()-started),rssBytes:process.memoryUsage().rss})});}catch{}}
function begin(next){metric('finish');stage=next;started=performance.now();metric('start');}
metric('start');
async function output(bytes){if(!process.stdout.write(bytes))await once(process.stdout,'drain');}
async function frame(info,bytes){
  const json=Buffer.from(JSON.stringify(info)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);
  await output(length);await output(json);if(bytes)await output(bytes);
}
const {mode,start,end,module,fontManifest,fontBytes,print,browserWs}=workerData;
if(!['pdf','preview','images','selected','markdown','markdown-package','text'].includes(mode)||(['preview','images'].includes(mode)&&(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end>10)))throw new Error('range');
try {
  const selectedPages=mode==='selected'?normalizeSelectedPages(workerData.selectedPages):undefined;
  const bytes=workerData.bytes;validateInput(bytes);
  const isMarkdown=mode==='markdown'||mode==='markdown-package';
  const sourceFormat=bytes[0]===0x50?'hwpx':'hwp';
  // Bound a ZIP container before passing it to the document engine.
  if(isMarkdown&&sourceFormat==='hwpx')readArchive(bytes);
  begin('wasm_init');
  await init({module_or_path:module});
  begin('parse');
  doc=new HwpDocument(bytes);
  const count=doc.pageCount();pageCount=count;if(count<1||count>MAX_PAGES)throw new ConversionFailure('page_count');
  if(selectedPages?.some(page=>page>count))throw new ConversionFailure('page_selection');
  if(isMarkdown) {
    begin('markdown');
    let hwpx=bytes,engineLoss;
    if(sourceFormat==='hwp'){
      const exported=doc.exportHwpxWithReport();
      try{
        if(!exported.hasBytes())throw new ConversionFailure('markdown_structure');
        engineLoss=JSON.parse(exported.contentLoss());hwpx=exported.takeBytes();
      }finally{exported.free();}
    }
    const extracted=extractStructuredMarkdown({hwpx,sourceFormat,pageCount:count,engineLoss,unicode:JSON.parse(doc.getTextFileUnicode()),controls:JSON.parse(doc.getControls())});
    const suffix=`\n\n## 함께 확인할 파일\n\n- [원본 문서](source/original.${sourceFormat})\n- [추출 대조 보고서](report.json)\n${sourceFormat==='hwp'?'- [엔진이 해석한 HWPX 구조](source/structure.hwpx)\n':''}\n이 Markdown의 이미지와 위 파일은 함께 제공된 ZIP 안에 있습니다. 그림 속 글자와 시각적 의미는 자동 판독하지 않았습니다.\n`;
    const markdown=Buffer.concat([extracted.markdown,Buffer.from(suffix)]);
    if(markdown.length>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');
    const report={...extracted.report,schemaVersion:1,packageVersion:2,source:{format:sourceFormat,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}};
    const reportBytes=Buffer.from(JSON.stringify(report,null,2));
    if(reportBytes.length>MAX_MARKDOWN_REPORT_BYTES)throw new ConversionFailure('markdown_package_size');
    begin('output');await frame({type:'document',pageCount:count});
    await frame({type:'markdown',bytes:markdown.length},markdown);
    if(mode==='markdown-package'){
      const zip=writeArchive([{name:'document.md',bytes:markdown},{name:'report.json',bytes:reportBytes},{name:`source/original.${sourceFormat}`,bytes},...(sourceFormat==='hwp'?[{name:'source/structure.hwpx',bytes:hwpx}]:[]),...extracted.assets.map(({name,bytes})=>({name,bytes}))],{maxBytes:MAX_MARKDOWN_PACKAGE_BYTES});
      await frame({type:'report',bytes:reportBytes.length},reportBytes);
      await frame({type:'archive',bytes:zip.length},zip);
    }
  } else if(mode==='text') {
    begin('text');
    const text=textFromUnicode(doc.getTextFileUnicode());
    begin('output');
    await frame({type:'document',pageCount:count});
    await frame({type:mode,bytes:text.length},text);
  } else {
  begin('svg_render');
  const imageOnly=mode==='images'||mode==='selected';
  const selected=selectedPages?new Set(selectedPages):undefined;
  const last=selectedPages?.at(-1)??Math.min(end,count);
  const pages=[];
  for(let i=0;i<(imageOnly?last:count);i++) {
    // Preserve the preceding paper geometry for identical screenshot rounding on range retries.
    // Its document content need not be rendered again.
    pageNumber=i+1;operation='render_error';
    const blank=mode==='selected'?!selected.has(i+1):mode==='images'&&i<start-1;
    const svg=blank?'<svg xmlns="http://www.w3.org/2000/svg"/>':doc.renderPageSvgWithProfile(i,'print');svgBytes+=Buffer.byteLength(svg);
    if(svgBytes>100*1024*1024)throw new ConversionFailure('svg_size');
    operation='page_info_error';
    const info=JSON.parse(doc.getPageInfo(i));
    if(!Number.isFinite(info.width)||!Number.isFinite(info.height)||info.width<=0||info.height<=0||info.width>10000||info.height>10000)throw new ConversionFailure('page_size');
    pages.push(createPrintPage(svg,info,i));
  }
  operation=undefined;pageNumber=undefined;
  begin('fonts_prepare');
  const {css:fonts,files:fontFiles}=fontManifest;
  begin('browser_render');
  if(!browserWs)throw new Error('Missing conversion supervisor');
  browser=await chromium.connect(browserWs);
  context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>routeFont(route,fontFiles,resolve('.cache/conversion/fonts'),fontBytes));
  const page=await context.newPage();
  begin('dom_prepare');
  await page.setContent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data: https://rhwp-fonts.invalid; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'"></head><body></body></html>`);
  // Trusted pinned helper code via DevTools; document SVG never becomes script source.
  await page.evaluate(print+';window.RhwpPrint=RhwpPrint;');
  begin('page_attach');
  await page.evaluate(({pages,fonts})=>{
    const style=document.createElement('style');style.textContent=fonts;document.head.append(style);
    window.RhwpPrint.appendPrintStyle(document,pages);
    for(const printPage of pages) {
      const xml=new DOMParser().parseFromString(printPage.svg,'image/svg+xml');
      if(xml.querySelector('parsererror'))throw new Error('Invalid SVG');
      for(const el of xml.querySelectorAll('script,foreignObject,iframe,object,embed,style,animate,animateTransform,set'))el.remove();
      for(const el of xml.querySelectorAll('*'))for(const attr of [...el.attributes]) {
        if(/^on/i.test(attr.name))el.removeAttribute(attr.name);
        if(/href$/i.test(attr.name)&&!attr.value.startsWith('#')&&!/^data:image\/(png|jpeg|gif|webp);base64,/i.test(attr.value))el.removeAttribute(attr.name);
      }
      const svg=new XMLSerializer().serializeToString(xml.documentElement);
      window.RhwpPrint.appendSvgPage(document,document.body,{...printPage,svg});
    }
  },{pages,fonts});
  await page.emulateMedia({media:'print'});
  begin('fonts_ready');
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.decode().catch(()=>{})));});
  begin('pdf');
  const pdf=imageOnly?Buffer.alloc(0):await page.pdf({preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
  if(pdf.length>50*1024*1024)throw new ConversionFailure('pdf_size');
  await frame({type:'document',pageCount:count});
  if(!imageOnly)await frame({type:'pdf',bytes:pdf.length},pdf);
  if(mode!=='pdf') {
    begin('png');
    let total=0;
    for(let number=1;number<=last;number++){
      pageNumber=number;
      const element=page.locator('.page').nth(number-1);
      await element.evaluate(el=>{const rect=el.getBoundingClientRect();el.style.zoom=String(Math.min(1,800/rect.width,1200/rect.height));});
      if(selected?!selected.has(number):number<start)continue;
      const png=await element.screenshot({type:'png',timeout:10_000});total+=png.length;
      if(png.length>5*1024*1024||total>25*1024*1024)throw new ConversionFailure('preview_size');
      await frame({type:'png',page:number,bytes:png.length},png);
    }
    begin('output');
    // The supervisor sends end after this thread has exited.
  }
  }
  metric('finish');
} catch(error) { failureReason=error instanceof ConversionFailure?error.reason:operation??'conversion_error';metric('failed');process.exitCode=1; }
finally {try{doc?.free();}finally{await context?.close();await browser?.close();}}
