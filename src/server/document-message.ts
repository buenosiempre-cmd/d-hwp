import {isPermanentConversionFailure} from '../conversion/failures.mjs';
import type {Card} from './documents';
export function documentMetadata(card:Card,origin:string,previewUrl?:string):Record<string,unknown> {
    return {url:`${origin}/documents/${card.id}`,external_ref:{id:card.id,type:'document'},entity_type:'slack#/entities/file',entity_payload:{
      attributes:{title:{text:card.name},display_type:'문서 편집 (RHWP) · 변환 결과는 스레드에서 확인',product_name:'D-HWP',full_size_preview:{is_supported:true,mime_type:'application/vnd.slack-embed',...(previewUrl?{preview_url:previewUrl}:{})}},
      slack_file:{id:card.fileId,type:/\.hwpx$/i.test(card.name)?'hwpx':'hwp'},fields:{},
      custom_fields:previewUrl?[]:[
        ...(card.pdfFileId?[{key:'pdf_file',label:'PDF 파일',type:'slack#/types/file',slack_file:{id:card.pdfFileId}}]:[]),
      ],display_order:[]}};
  }
function documentText(card:Card):string{return card.name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
export function documentGallery(card:Card){
    // Slack appends file_ids; keep a contiguous prefix so a failed upload cannot reorder pages.
    const sorted=[...(card.images??[])].sort((a,b)=>a.page-b.page);
    const gap=sorted.findIndex((image,index)=>image.page!==index+1);
    return gap<0?sorted:sorted.slice(0,gap);
  }
// Browser beta has no Work Objects metadata to share private PDF/revision uploads.
export function documentFileIds(card:Card,editorMode:'embed'|'browser'='embed'):string[]{
    return [...new Set([...(editorMode==='browser'?[...(card.parentId?[card.fileId]:[]),...(card.pdfFileId?[card.pdfFileId]:[])]:[]),...documentGallery(card).map(image=>image.fileId)])];
  }
export function documentMessage(card:Card,origin:string,editorMode:'embed'|'browser'='embed'):Record<string,unknown>{
    const images=documentGallery(card),fileIds=documentFileIds(card,editorMode);
    const detail=card.pageCount?card.pageCount+'페이지':'페이지 확인 중';
    const pdf=card.pdf==='ready'&&card.pdfUrl?' · <'+card.pdfUrl+'|PDF로 보기>':card.pdf==='failed'?' · PDF 준비 실패':' · PDF 준비 중';
    const blocks:Record<string,unknown>[]=[{type:'section',text:{type:'mrkdwn',text:'*'+documentText(card)+'* · '+detail+pdf}}];
    const outputs:Record<string,unknown>[]=[];
    if(card.pdf==='ready'&&card.pdfUrl)outputs.push({type:'button',action_id:'rhwp_view_pdf',text:{type:'plain_text',text:'PDF 열기'},url:card.pdfUrl});
    outputs.push({type:'button',action_id:'rhwp_export_markdown',value:card.id,text:{type:'plain_text',text:card.exports?.['markdown-v2']?.url?'문서 Markdown 다시 받기':'문서 Markdown (ZIP)'}});
    outputs.push({type:'button',action_id:'rhwp_export_options',value:card.id,text:{type:'plain_text',text:'형식·쪽 선택'}});
    blocks.push({type:'actions',elements:outputs});
    if(card.recovery?.state==='running')blocks.push({type:'context',elements:[{type:'plain_text',text:card.recovery.attempt===0?'미리보기 요청을 접수했습니다. PDF·이미지를 준비할 차례를 기다리고 있습니다.':'PDF·이미지를 다시 준비하고 있습니다.'}]});
    if(card.recovery?.state==='retrying')blocks.push({type:'context',elements:[{type:'plain_text',text:`PDF·이미지 준비에 실패해 자동으로 다시 시도합니다. (${card.recovery.attempt}/${card.recovery.maxAttempts}회 시도)`}]});
    const failure=card.recovery?.state==='failed'?card.recovery.errorCode:undefined;
    const limitMessages:Record<string,string>={
      conversion_svg_limit:'문서의 그림·페이지를 처리하는 데 필요한 데이터가 변환 한도를 넘었습니다. 문서를 나누거나 그림 용량을 줄여 새 파일로 올려 주세요.',
      conversion_page_limit:'지원하는 페이지 수 범위(1~200페이지)를 벗어났습니다. 문서를 나누어 새 파일로 올려 주세요.',
      conversion_page_geometry:'페이지 크기를 처리할 수 없습니다. 문서의 용지 설정을 확인하고 다시 저장한 파일을 올려 주세요.',
      conversion_pdf_limit:'생성된 PDF가 변환 용량 한도를 넘었습니다. 문서를 나누거나 그림 용량을 줄여 새 파일로 올려 주세요.',
      conversion_preview_limit:'페이지 이미지가 변환 용량 한도를 넘었습니다. 그림 용량을 줄인 파일을 올려 주세요.',
    };
    if(failure&&isPermanentConversionFailure(failure))blocks.push({type:'context',elements:[{type:'plain_text',text:limitMessages[failure]}]});
    else if(failure)blocks.push({type:'context',elements:[{type:'plain_text',text:'PDF·이미지 준비를 완료하지 못했습니다. 다시 시도해도 실패하면 지원팀에 발생 시각을 알려 주세요.'}]});
    if(card.pdf==='failed'&&card.recovery?.state==='failed'&&!isPermanentConversionFailure(failure))blocks.push({type:'actions',elements:[{type:'button',action_id:'rhwp_retry_preview',value:card.id,text:{type:'plain_text',text:'문서 미리보기 다시 준비'}}]});
    if(card.imageState==='pending')blocks.push({type:'context',elements:[{type:'plain_text',text:'페이지 이미지를 준비하고 있습니다.'}]});
    else if(!isPermanentConversionFailure(failure)&&card.pdf==='ready'&&card.pageCount&&(images.length<Math.min(10,card.pageCount)||card.imageState==='failed')){
      blocks.push({type:'actions',elements:[{type:'button',action_id:'rhwp_more_pages',value:card.id,text:{type:'plain_text',text:card.imageState==='failed'?'PNG 이미지 다시 준비':'PNG 이미지 (앞 10쪽)'}}]});
    }
    if(card.pageCount&&card.pageCount>10&&images.length===10)blocks.push({type:'context',elements:[{type:'plain_text',text:'앞 10페이지를 표시했습니다. 전체 문서는 PDF로 볼 수 있습니다.'}]});
    blocks.push({type:'context',elements:[{type:'plain_text',text:'D-HWP · 변환 파일은 이 스레드에 공유됩니다. 형식·쪽 선택에서 원문 TXT 또는 선택 쪽 PNG ZIP을 받을 수 있습니다. Markdown ZIP에 본문·표·주석·수식 원문·그림·원본을 함께 담습니다. 그림 속 글자 OCR과 시각적 의미는 확인이 필요합니다.'}]});
    if(editorMode==='browser')blocks.push({type:'actions',elements:[{type:'button',action_id:'rhwp_browser_edit',text:{type:'plain_text',text:'문서 편집 (RHWP)'},url:browserEditorUrl(card,origin)}]});
    return {channel:card.actor.channelId,...(fileIds.length?{file_ids:fileIds}:{}),text:documentText(card)+' · '+detail,blocks,parse:'none',unfurl_links:false,unfurl_media:false,...(editorMode==='embed'?{metadata:{entities:[documentMetadata(card,origin)]}}:{})};
  }

export function browserEditorUrl(card:Card,origin:string):string{return origin+'/browser/open?'+new URLSearchParams({workspace:card.actor.teamId,document:card.id}).toString();}
