import {createHash} from 'node:crypto';
import {posix} from 'node:path';
import {readArchive} from './archive.mjs';
import {parseXml,childElements,textContent,attr} from './xml.mjs';
import {MAX_MARKDOWN_BYTES} from './frames.mjs';
import {ConversionFailure} from './failures.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw new ConversionFailure('markdown_structure');};
const punctuation=/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g;
const escaped=value=>String(value).replace(punctuation,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]??'\\'+c)).replace(/(^|\n)([ \t]+)/g,(_m,start,spaces)=>start+[...spaces].map(c=>c==='\t'?'&#9;':'&#32;').join(''));
const meaningful=value=>typeof value==='string'&&value.trim().length>0;
const nodes=node=>childElements(node);
const all=(node,name)=>{const result=[];const visit=n=>{if(n.name===name)result.push(n);for(const c of nodes(n))visit(c);};visit(node);return result;};
const first=(node,name)=>nodes(node).find(c=>c.name===name);
const integer=(value,fallback=0,max=10000)=>{if(value===undefined||value==='')return fallback;if(!/^\d+$/.test(String(value)))fail();const n=Number(value);if(!Number.isSafeInteger(n)||n<0||n>max)fail();return n;};
const raster=bytes=>bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?['png','image/png']:bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?['jpg','image/jpeg']:['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString())?['gif','image/gif']:bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?['webp','image/webp']:['bin','application/octet-stream'];
const simpleWrappers=new Set(['sec','run','ctrl','subList','t','parameters','switch','case','default','caption','drawText','stringParam','script','shapeComment','link','hyperlink']);
const layout=new Set(['linesegarray','lineseg','secPr','grid','startNum','visibility','lineNumberShape','pagePr','margin','footNotePr','endNotePr','autoNumFormat','noteLine','noteSpacing','numbering','placement','pageBorderFill','offset','colPr','sz','pos','outMargin','inMargin','cellAddr','cellSpan','cellSz','cellMargin','orgSz','curSz','flip','rotationInfo','renderingInfo','transMatrix','scaMatrix','rotMatrix','lineShape','fillBrush','winBrush','gradation','imgBrush','imgRect','imgClip','imgDim','effects','textMargin','pt0','pt1','pt2','pt3','lineSeg','instid','connectLine','shadow','effectsShadow','effectsGlow','effectsSoftEdge','effectsReflection','color','alpha','img','tr','tc']);
const shapes=new Set(['rect','ellipse','arc','polygon','curve','line','container','ole','textart','video','chart','connectLine']);
// These metadata elements describe presentation, not document prose. Unknown metadata
// is retained below, including attributes that can carry comments or revision text.
const metadataLayout=new Set(('head beginNum refList fontfaces fontface font typeInfo borderFills borderFill slash backSlash leftBorder rightBorder topBorder bottomBorder diagonal fillBrush winBrush charProperties charPr fontRef ratio spacing relSz offset underline strikeout outline shadow tabProperties tabPr numberings numbering bullets bullet paraHead paraProperties paraPr align heading breakSetting autoSpacing switch case margin intent left right prev next lineSpacing default border styles style compatibleDocument layoutCompatibility docOption linkinfo trackchageConfig package metadata title language meta manifest item spine itemref HWPApplicationSetting CaretPosition bold italic emboss engrave supscript subscript').split(' '));
const standardNamespace=uri=>!uri||/^http:\/\/www\.hancom\.co\.kr\/hwpml\//.test(uri)||uri==='http://www.idpf.org/2007/opf/'||uri==='http://www.idpf.org/2007/opf'||uri==='http://purl.org/dc/elements/1.1/';
const layoutAttributes=new Set(('aboveLine affectLSpacing allowOverlap alpha angle applyPageType baseLine baseUnit baseline beginIDRef belowLine beneathText betweenNotes binaryItemIDRef border borderFillIDRef bottom bright cellSpacing centerX centerY charGrid charPrIDRef cnt colAddr colCnt colCount colSpan color columnBreak contrast countBy dimheight dimwidth dirty distance dropcapstyle e1 e2 e3 e4 e5 e6 editable effect endCap equation faceColor fill fillArea flags flowWithText font footer footerInside groupLevel gutter gutterType hasMargin hasNumRef hasTextRef hatchColor headStyle headSz header headerInside headfill height heightRelTo hideFirstEmptyLine hideFirstFooter hideFirstHeader hideFirstMasterPage hideFirstPageNum holdAnchorAndSO horizontal horzAlign horzOffset horzRelTo horzpos horzsize id instId instid landscape lastWidth layout left length lineGrid lineMode lineWrap linkListIDRef linkListNextIDRef lock masterPageCnt memoShapeIDRef merged newNum noAdjust num numType number numberingType outlineShapeIDRef outlineStyle page pageBreak pageStartsOn paraPrIDRef pic place protect ratio repeatHeader restartType reverse right rotateimage rowAddr rowCnt rowSpan sameGap sameSz showLineNumber spaceColumns spacing startNumber style styleIDRef supscript tabStop tabStopUnit tabStopVal tailStyle tailSz tailfill tbl textBorder textColor textDirection textFlow textHeight textVerticalWidthHead textWidth textWrap textheight textpos top treatAsChar type version vertAlign vertOffset vertRelTo vertical vertpos vertsize width widthRelTo wonggojiFormat x y zOrder').split(' '));

/** Structure extraction, not an assertion that an arbitrary source has no semantic loss. */
export function extractStructuredMarkdown({hwpx,sourceFormat,pageCount,engineLoss,unicode,controls}={}){
  if(!['hwp','hwpx'].includes(sourceFormat)||!Number.isSafeInteger(pageCount)||pageCount<1||pageCount>200)fail();
  const entries=readArchive(hwpx),packageBytes=entries.get('Contents/content.hpf');if(!packageBytes)fail();
  const documents=new Map(),paths=new WeakMap(),textRecords=[],textByParent=new WeakMap();let nodeCount=0,pathBytes=0,textBytes=0,tableGridCells=0;
  const report={schemaVersion:1,sourceFormat,pageCount,status:'extracted',coverage:{xmlTextNodes:0,renderedTextNodes:0,unaccountedTextNodes:0,xmlTextCharacters:0,renderedTextCharacters:0,scope:'All non-whitespace XML text nodes in parsed package parts; this does not prove visual, binary, attribute, OCR or HWP import completeness.'},counts:{sections:0,paragraphs:0,tables:0,cells:0,images:0,footnotes:0,endnotes:0,headers:0,footers:0,equations:0,textBoxes:0,fields:0,unknownElements:0},tables:[],assets:[],issues:[]};
  const issue=(code,path,message)=>{if(report.issues.length>=5000)fail();report.issues.push({code,sourcePath:path,message});};
  const register=(node,path)=>{
    pathBytes+=Buffer.byteLength(path);if(++nodeCount>200000||pathBytes>32*1024*1024)throw new ConversionFailure('markdown_package_size');
    paths.set(node,path);const children=node.children??[],records=new Map();let index=0;
    for(let i=0;i<children.length;i++){const child=children[i];if(typeof child==='string'){textBytes+=Buffer.byteLength(child);if(textBytes>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');if(meaningful(child)){const record={path:path+'/text()['+(i+1)+']',value:child,consumed:false};textRecords.push(record);records.set(i,record);}}else register(child,path+'/'+child.qname+'['+(++index)+']');}textByParent.set(node,records);
  };
  for(const [name,bytes]of entries){if(/\.(?:xml|hpf|rdf)$/i.test(name)){const document=parseXml(bytes);documents.set(name,document);register(document,name+'/'+document.qname);}}
  const pkg=documents.get('Contents/content.hpf');if(!pkg||pkg.name!=='package')fail();
  const resolvePart=(href,base='Contents/content.hpf')=>{
    if(typeof href!=='string'||!href||/[\\\u0000-\u001f?#]/.test(href)||/^[/]|^[a-z][a-z0-9+.-]*:/i.test(href))return;
    let decoded;try{decoded=decodeURIComponent(href);}catch{return;}
    if(/[\\\u0000-\u001f?#]/.test(decoded)||decoded.startsWith('/'))return;
    for(const value of [decoded,posix.normalize(posix.join(posix.dirname(base),decoded))])if(!value.split('/').includes('..')&&entries.has(value))return value;
  };
  const manifest=new Map();for(const item of all(first(pkg,'manifest')??pkg,'item')){const id=attr(item,'id'),href=attr(item,'href');if(!id||manifest.has(id))fail();const path=resolvePart(href);manifest.set(id,{path,href,mime:attr(item,'media-type'),node:item});if(!path)issue('unresolved_manifest_item',paths.get(item),'A manifest resource is missing or external; it was not fetched.');}
  const spine=first(pkg,'spine');if(!spine)fail();
  const sections=[],seenSections=new Set();for(const itemref of nodes(spine)){if(itemref.name!=='itemref')continue;const item=manifest.get(attr(itemref,'idref'));if(!item?.path){issue('missing_package_part',paths.get(itemref),'A spine item is unresolved.');continue;}const node=documents.get(item.path);if(node?.name==='sec'){if(seenSections.has(item.path))fail();sections.push([item.path,node]);seenSections.add(item.path);}}
  for(const [path,node]of documents)if(node.name==='sec'&&!seenSections.has(path)){sections.push([path,node]);seenSections.add(path);issue('unlisted_section',path,'A section outside the spine was retained after the ordered sections.');}
  if(!sections.length)fail();
  const assets=[],assetByPath=new Map();let totalAssetBytes=0;
  const preserveAsset=path=>{if(assetByPath.has(path))return assetByPath.get(path);const bytes=entries.get(path);if(!bytes)return;totalAssetBytes+=bytes.length;if(totalAssetBytes>25*1024*1024)throw new ConversionFailure('markdown_package_size');const [extension,mime]=raster(bytes),digest=sha(bytes),name=`assets/${digest}.${extension}`;if(!assets.some(asset=>asset.name===name))assets.push({name,bytes:Buffer.from(bytes),mime});const record={name,mime,sha256:digest,bytes:bytes.length,sourcePath:path,referenced:false};report.assets.push(record);assetByPath.set(path,record);return record;};
  // Preserve every embedded binary, including OLE/unknown objects, not only images we can show.
  for(const [path]of entries)if(/^BinData\//i.test(path))preserveAsset(path);
  for(const [path]of entries)if(!documents.has(path)&&!/^Preview\//i.test(path)&&path!=='mimetype')preserveAsset(path);
  const headers=documents.get('Contents/header.xml'),charProperties=new Map(),paraProperties=new Map(),styles=new Map();
  if(headers){for(const n of all(headers,'charPr'))charProperties.set(attr(n,'id'),n);for(const n of all(headers,'paraPr'))paraProperties.set(attr(n,'id'),n);for(const n of all(headers,'style'))styles.set(attr(n,'id'),n);}
  const notes=[],semanticAttributes=[],claimedAttributes=new WeakMap();
  const claimAttribute=(node,key)=>{
    const candidates=Object.keys(node.attrs??{}).filter(candidate=>candidate.split(':').at(-1)===key);
    const selected=Object.hasOwn(node.attrs,key)?key:candidates.length===1?candidates[0]:undefined;
    if(selected!==undefined){let set=claimedAttributes.get(node);if(!set){set=new Set();claimedAttributes.set(node,set);}set.add(selected);return node.attrs[selected];}
  };
  const props=(node,keys)=>keys.map(key=>{const value=claimAttribute(node,key);return value===undefined||value===''?'':`${escaped(key)}=${escaped(value)}`;}).filter(Boolean).join(', ');
  const renderText=(node,index,value)=>{
    const record=textByParent.get(node)?.get(index);if(record)record.consumed=true;
    const text=escaped(value);
    // Paragraph assembly trims generated separators, so protect authored edge
    // whitespace rather than allowing that trimming to remove source characters.
    return record||['t','script','stringParam','shapeComment'].includes(node.name)?text.replace(/^\s+|\s+$/gu,space=>[...space].map(c=>'&#'+c.codePointAt(0)+';').join('')):text;
  };
  const renderChildren=(node,context={})=>(node.children??[]).map((child,index)=>typeof child==='string'?renderText(node,index,child):render(child,context)).join('');
  const plainChildren=node=>{const consume=n=>(n.children??[]).map((child,index)=>typeof child==='string'?renderText(n,index,child):consume(child)).join('');return consume(node);};
  const render=(node,context={})=>{
    const path=paths.get(node),name=node.name;
    if(!standardNamespace(node.uri)){
      report.counts.unknownElements++;issue('unknown_namespace',path,'A foreign XML namespace is interpreted conservatively by local name; its text and attributes are retained.');
      for(const[key,value]of Object.entries(node.attrs??{}))if(!key.startsWith('xmlns')){claimAttribute(node,key);semanticAttributes.push({sourcePath:path+'/@'+key,value});}
    }
    if(name==='p'){
      report.counts.paragraphs++;const body=renderChildren(node,context).trim();
      const para=paraProperties.get(attr(node,'paraPrIDRef')),heading=para&&first(para,'heading'),kind=heading&&attr(heading,'type'),level=heading&&integer(attr(heading,'level'),0,20),style=styles.get(attr(node,'styleIDRef'));
      const prefix=kind==='OUTLINE'?'#'.repeat(Math.min(6,2+(level??0)))+' ':kind==='NUMBER'||kind==='BULLET'?`- [${kind==='NUMBER'?'번호':'글머리표'} 단계 ${(level??0)+1}] `:'';
      const styleName=style&&attr(style,'name');
      let metadata='';if(kind==='NUMBER'||kind==='BULLET'){metadata=`\n\n> 문단 번호 정의: ${props(heading,['type','idRef','level'])}${styleName?' · 스타일 '+escaped(styleName):''}`;issue('numbering_requires_review',path,'Numbering/bullet definitions are retained, but the displayed counter or glyph is not reconstructed.');}
      return '\n\n'+(body?prefix+body:'> [빈 문단]')+metadata+'\n\n';
    }
    if(name==='run'){
      let body=renderChildren(node,context);const format=charProperties.get(attr(node,'charPrIDRef'));
      if(format){const present=n=>nodes(format).some(child=>child.name===n);if(present('supscript'))body=`〔위첨자: ${body}〕`;if(present('subscript'))body=`〔아래첨자: ${body}〕`;if(present('strikeout')&&attr(first(format,'strikeout'),'shape')!=='NONE')body=`〔취소선: ${body}〕`;if(present('bold'))body=`**${body}**`;if(present('italic'))body=`*${body}*`;const underline=first(format,'underline');if(underline&&attr(underline,'type')!=='NONE')body=`〔밑줄: ${body}〕`;}
      return body;
    }
    if(name==='header'||name==='footer'){
      report.counts[name==='header'?'headers':'footers']++;return `\n\n### ${name==='header'?'머리말':'꼬리말'} (${props(node,['id','applyPageType'])})\n\n${renderChildren(node,context)}\n\n`;
    }
    if(name==='footNote'||name==='endNote'){
      const kind=name==='footNote'?'각주':'미주',key=name==='footNote'?'footnotes':'endnotes',number=++report.counts[key],id=(name==='footNote'?'fn':'en')+number;
      const content=renderChildren(node,context).trim(),meta=props(node,['number','suffixChar']);notes.push(`[^${id}]: **${kind} ${number}**${meta?' ('+meta+')':''}\n\n`+content.split('\n').map(line=>'    '+line).join('\n'));return `[^${id}]`;
    }
    if(name==='equation'){
      report.counts.equations++;return `\n\n**수식 ${report.counts.equations} · 한글 수식 원문**\n\n${renderChildren(node,context)}\n\n`;
    }
    if(name==='script')return '\n\n'+plainChildren(node)+'\n\n';
    if(name==='tbl'){
      const number=++report.counts.tables,id='table-'+number,rows=integer(attr(node,'rowCnt'),0,10000),columns=integer(attr(node,'colCnt'),0,10000);if(!rows||!columns||rows*columns>100000)fail();
      tableGridCells+=rows*columns;if(tableGridCells>100000)throw new ConversionFailure('markdown_package_size');
      const table={id,sourcePath:path,rows,columns,cells:[]};report.tables.push(table);const grid=Array.from({length:rows},()=>Array(columns).fill('—')),details=[];
      for(const rowNode of nodes(node).filter(n=>n.name==='tr'))for(const cell of nodes(rowNode).filter(n=>n.name==='tc')){
        const addr=first(cell,'cellAddr'),span=first(cell,'cellSpan');if(!addr)fail();const row=integer(attr(addr,'rowAddr'),0,rows-1),column=integer(attr(addr,'colAddr'),0,columns-1),rowSpan=integer(span&&attr(span,'rowSpan'),1,rows),colSpan=integer(span&&attr(span,'colSpan'),1,columns);if(!rowSpan||!colSpan||row+rowSpan>rows||column+colSpan>columns)fail();
        const cellId=`${id}-r${row+1}c${column+1}`;for(let r=row;r<row+rowSpan;r++)for(let c=column;c<column+colSpan;c++){if(grid[r][c]!=='—')fail();grid[r][c]=r===row&&c===column?`R${row+1}C${column+1}`:`↖ R${row+1}C${column+1}`;}
        table.cells.push({row:row+1,column:column+1,rowSpan,colSpan});report.counts.cells++;
        const content=renderChildren(cell,{...context,parentTable:id}).trim();details.push(`**${cellId} · 행 ${row+1}, 열 ${column+1} · rowSpan=${rowSpan}, colSpan=${colSpan}**\n\n${content||'[빈 셀]'}\n`);
      }
      // Render non-row content too (e.g. captions), never erase it with a table-only path.
      const extra=(node.children??[]).map((child,index)=>typeof child==='string'?renderText(node,index,child):child.name==='tr'?'':render(child,context)).join('');
      return `\n\n### 표 ${number} (${id}) · ${rows}행 × ${columns}열${context.parentTable?' · 부모 표 '+context.parentTable:''}\n\n`+'| 행 / 열 | '+Array.from({length:columns},(_,i)=>String(i+1)).join(' | ')+' |\n| --- | '+Array(columns).fill('---').join(' | ')+' |\n'+grid.map((row,i)=>'| '+(i+1)+' | '+row.join(' | ')+' |').join('\n')+'\n\n'+details.join('\n')+extra+'\n\n';
    }
    if(name==='pic'){
      const number=++report.counts.images;let result=`\n\n**그림 ${number}**\n\n`,refs=all(node,'img');
      for(const ref of refs){const id=claimAttribute(ref,'binaryItemIDRef'),item=manifest.get(id),asset=item?.path&&preserveAsset(item.path);if(asset){asset.referenced=true;result+=(asset.mime.startsWith('image/')?`![그림 ${number}](${asset.name})`:`[그림 ${number}의 원본 개체](${asset.name})`)+'\n\n';issue('image_ocr_not_performed',path,'Embedded image bytes are retained; text and visual meaning inside the image were not OCRed.');}else issue('unresolved_image',path,'An image reference could not be resolved.');}
      if(!refs.length)issue('unresolved_image',path,'A picture has no supported embedded image reference.');
      const href=claimAttribute(node,'href');if(href){result+='그림 연결 정보: '+escaped(href)+'\n\n';issue('external_reference',path,'A link or external resource is recorded without fetching it.');}
      result+=renderChildren(node,context);return result+'\n\n';
    }
    if(name==='fieldBegin'){
      report.counts.fields++;let target='';
      if(attr(node,'type')==='HYPERLINK'){
        const command=all(node,'stringParam').find(n=>attr(n,'name')==='Command');
        if(command){const uri=textContent(command).split(/(?<!\\);/)[0].replace(/\\([:\\;])/g,'$1');target='링크 대상: '+escaped(uri)+'\n\n';}
      }
      return `\n\n**필드 ${report.counts.fields} 시작** (${props(node,['id','type','name','editable'])})\n\n${target}${renderChildren(node,context)}\n\n`;
    }
    if(name==='fieldEnd')return `〔필드 끝: ${props(node,['beginIDRef'])}〕`;
    if(name==='bookmark')return `〔책갈피: ${props(node,['name'])}〕`+renderChildren(node,context);
    if(name==='autoNum'||name==='newNum'||name==='pageNum')return `〔자동 번호: ${props(node,['num','numType','newNum','number','type'])}〕`+renderChildren(node,context);
    if(name==='lineBreak')return '  \n';if(name==='tab')return '&#9;';if(name==='nbSpace')return '\u00a0';if(name==='fwSpace')return '\u3000';if(name==='hyphen')return '\\-';
    if(shapes.has(name)){
      const draw=all(node,'drawText').length>0;if(draw)report.counts.textBoxes++;else issue('visual_object_not_interpreted',path,'A non-text visual object requires the source document for interpretation.');
      return `\n\n**${draw?'글상자':'개체'} (${escaped(node.qname)})** ${props(node,['id','href','type','name'])}\n\n${renderChildren(node,context)}\n\n`;
    }
    if(simpleWrappers.has(name)||layout.has(name))return renderChildren(node,context);
    report.counts.unknownElements++;issue('unknown_element',path,'An unsupported XML element was retained as escaped text and attributes.');
    return `\n\n〔미지원 구조: ${escaped(node.qname)}${Object.keys(node.attrs??{}).length?' · '+props(node,Object.keys(node.attrs)):''}〕\n`+renderChildren(node,context)+'\n';
  };
  const body=[];
  for(const [path,section]of sections){report.counts.sections++;body.push(`\n\n## 구역 ${report.counts.sections}\n\n`+render(section));}
  if(notes.length)body.push('\n\n## 각주·미주\n\n'+notes.join('\n\n'));
  // Metadata such as field names and comments may live in attributes instead of text nodes.
  const semantic=new Set(['name','description','alt','title','value','href','uri','author','date','label','text','content','subject','prefixChar','suffixChar','userChar','startNumber']);
  for(const [path,document]of documents){const scan=node=>{
    const unknownMetadata=!seenSections.has(path)&&(!metadataLayout.has(node.name)||!standardNamespace(node.uri));
    if(unknownMetadata){report.counts.unknownElements++;issue('unknown_metadata',paths.get(node),'Unsupported auxiliary metadata is retained as text and attributes; its semantics require review.');}
    let unknownAttribute=false;
    for(const [key,value]of Object.entries(node.attrs??{})){
      const local=key.split(':').at(-1),qualifiedUnknown=key.includes(':')&&!key.startsWith('xml:')&&!key.startsWith('xmlns'),uninterpreted=seenSections.has(path)&&!layoutAttributes.has(local)&&!semantic.has(local);
      if(!key.startsWith('xmlns')&&(semantic.has(local)||unknownMetadata||uninterpreted||qualifiedUnknown)&&meaningful(value)&&!claimedAttributes.get(node)?.has(key)){semanticAttributes.push({sourcePath:paths.get(node)+'/@'+key,value});if(uninterpreted||qualifiedUnknown)unknownAttribute=true;}
    }
    if(unknownAttribute)issue('unknown_attributes',paths.get(node),'Unrecognized attributes are retained verbatim; their effect on document meaning requires review.');
    for(const child of nodes(node))scan(child);
  };scan(document);}
  if(semanticAttributes.length)body.push('\n\n## 이름·설명·링크 등 부가 속성\n\n'+semanticAttributes.map(record=>`- ${escaped(record.sourcePath)}: ${escaped(record.value)}`).join('\n'));
  const remaining=textRecords.filter(record=>!record.consumed);
  if(remaining.length){body.push('\n\n## 부가 구조의 원문 텍스트\n\n'+remaining.map(record=>{record.consumed=true;return `- ${escaped(record.path)}: ${escaped(record.value)}`;}).join('\n'));issue('supplementary_xml_text',remaining[0].path,'Text outside the body rendering path is retained in the supplementary section; its visual ordering requires review.');}
  for(const asset of report.assets)if(!asset.referenced){body.push(`\n\n- [추가 포함 개체](${asset.name}) · 원본 위치: ${escaped(asset.sourcePath)}\n`);issue('unreferenced_embedded_object',asset.sourcePath,'An embedded binary outside a supported picture reference was retained without interpreting it.');}
  if(sourceFormat==='hwp')issue('hwp_import_scope','source/original.hwp','HWP content is exposed through the engine import/export model; unrecognized binary content cannot be proven complete.');
  if(engineLoss!==undefined){let encoded;try{encoded=JSON.stringify(engineLoss);}catch{fail();}if(typeof encoded!=='string')fail();if(Buffer.byteLength(encoded)>256*1024)throw new ConversionFailure('markdown_package_size');report.engineLoss=JSON.parse(encoded);if(!engineLoss||typeof engineLoss!=='object'||!Number.isSafeInteger(engineLoss.count)||engineLoss.count!==0)issue('engine_reported_loss','source/original.hwp','The engine export reports loss or an unknown loss report.');}
  if(typeof unicode==='string'){
    if(Buffer.byteLength(unicode)>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');
    const compact=value=>value.replace(/\s+/gu,''),segments=[],stack=[];
    const flush=()=>{const paragraph=stack.at(-1);if(paragraph?.text){const value=compact(paragraph.text);if(value)segments.push(value);paragraph.text='';}};
    const paragraphText=node=>{
      if(node.name==='p'){flush();stack.push({text:''});}
      for(const child of node.children??[])if(typeof child==='string'){if(stack.length)stack.at(-1).text+=child;}else paragraphText(child);
      if(node.name==='p'){flush();stack.pop();}
    };
    for(const[,section]of sections)paragraphText(section);
    const missing=[];let segmentIndex=0,offset=0,searchedCharacters=0,uncertain=false;
    for(const fragment of unicode.split(/[\r\n\t]+/).filter(meaningful)){
      const value=compact(fragment);let matched=false;
      for(let index=segmentIndex;index<segments.length;index++){
        const from=index===segmentIndex?offset:0;searchedCharacters+=segments[index].length-from;
        if(searchedCharacters>32*1024*1024){uncertain=true;break;}
        const position=segments[index].indexOf(value,from);
        if(position>=0){segmentIndex=index;offset=position+value.length;matched=true;break;}
      }
      if(uncertain)break;if(!matched)missing.push(fragment);
    }
    report.engineText={characters:[...unicode].length,sha256:sha(Buffer.from(unicode)),comparison:uncertain?'bounded_full_fallback':'ordered_paragraph_fragments',unmatchedFragments:uncertain?null:missing.length};
    if(uncertain){body.push('\n\n## 대조 한도로 별도 보존한 엔진 본문 전체\n\n'+escaped(unicode));issue('engine_text_comparison_incomplete','engine/unicode','Bounded comparison could not finish; the entire independent engine text is retained for review.');}
    else if(missing.length){body.push('\n\n## 엔진 본문 대조에서 추가로 발견된 텍스트\n\n'+missing.map(line=>'- '+escaped(line)).join('\n'));issue('engine_text_not_in_xml','engine/unicode','Text fragments not matched in paragraph order and occurrence count were retained separately, including repetitions; their position and interpretation require review.');}
  }
  if(Array.isArray(controls))report.engineControlCount=controls.length;
  report.coverage.xmlTextNodes=textRecords.length;report.coverage.renderedTextNodes=textRecords.filter(record=>record.consumed).length;report.coverage.unaccountedTextNodes=textRecords.filter(record=>!record.consumed).length;report.coverage.xmlTextCharacters=textRecords.reduce((sum,record)=>sum+[...record.value].length,0);report.coverage.renderedTextCharacters=textRecords.filter(record=>record.consumed).reduce((sum,record)=>sum+[...record.value].length,0);
  report.status=report.issues.length?'needs_review':'extracted';
  const intro='# 문서 구조 Markdown\n\n> 이 문서는 구조 XML의 내용을 Markdown으로 옮긴 결과입니다. 원문과 그림은 같은 패키지에 보존합니다. 추출된 텍스트의 대응 검사는 모든 시각 정보나 이미지 속 글자의 완전한 이해를 뜻하지 않습니다.\n\n'
    +`- 원본 형식: ${sourceFormat.toUpperCase()} · 엔진 쪽 수: ${pageCount} · 구역: ${report.counts.sections}\n- XML 텍스트 대응: ${report.coverage.renderedTextNodes}/${report.coverage.xmlTextNodes} · 미대응: ${report.coverage.unaccountedTextNodes}\n- 검토 항목: ${report.issues.length} · 그림 속 글자 OCR: 수행하지 않음\n\n`
    +(report.issues.length?'## 확인이 필요한 내용\n\n'+report.issues.map(item=>`- ${escaped(item.code)} · ${escaped(item.sourcePath)}: ${escaped(item.message)}`).join('\n')+'\n\n':'');
  const markdown=Buffer.from(intro+body.join('\n')+'\n','utf8');if(markdown.length>MAX_MARKDOWN_BYTES)throw new ConversionFailure('markdown_size');
  if(Buffer.byteLength(JSON.stringify(report))>2*1024*1024)throw new ConversionFailure('markdown_package_size');
  return {markdown,assets,report};
}
