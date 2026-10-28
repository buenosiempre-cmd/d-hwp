import {randomUUID} from 'node:crypto';
import type {Actor} from './access';
import {ID} from './config';
import {object,UserError} from './errors';
import {normalizeExportRequest,parsePageSelection,type ExportRequest} from './document-exports';

export interface ExportSelection {actor:Actor;cardId:string;messageTs:string;expiresAt:number;}
export class ExportSelections {
  private items=new Map<string,ExportSelection>();
  constructor(private now=Date.now,private ttlMs=5*60_000){}
  sweep():void {for(const [id,item] of this.items)if(item.expiresAt<=this.now())this.items.delete(id);}
  create(actor:Actor,cardId:string,messageTs:string):string {
    this.sweep();
    if(!ID.team.test(actor.teamId)||!ID.user.test(actor.userId)||!ID.channel.test(actor.channelId)||!cardId||cardId.length>128||!/^\d+\.\d+$/.test(messageTs))throw new UserError('invalid_export_selection','문서 선택을 확인할 수 없습니다. 문서 카드에서 다시 선택하세요.');
    if(this.items.size>=1000)throw new UserError('export_selection_full','형식 선택 요청이 많습니다. 잠시 후 다시 시도하세요.');
    const id=randomUUID();this.items.set(id,{actor:{...actor},cardId,messageTs,expiresAt:this.now()+this.ttlMs});return id;
  }
  get(id:string,teamId:string,userId:string):ExportSelection {
    this.sweep();const item=this.items.get(id);
    if(!item||item.actor.teamId!==teamId||item.actor.userId!==userId)throw new UserError('invalid_export_selection','형식 선택이 만료되었거나 올바르지 않습니다. 문서 카드에서 다시 선택하세요.');
    return {...item,actor:{...item.actor}};
  }
  delete(id:string):void {this.items.delete(id);}
}

export function exportView(id:string,pageCount?:number){
  const count=typeof pageCount==='number'&&Number.isSafeInteger(pageCount)&&pageCount>=1&&pageCount<=200?pageCount:undefined;
  const last=Math.min(10,count??1),initial=last===1?'1':`1-${last}`;
  return {type:'modal',callback_id:'rhwp_export_document',private_metadata:id,
    title:{type:'plain_text',text:'형식·쪽 선택'},submit:{type:'plain_text',text:'파일 만들기'},close:{type:'plain_text',text:'취소'},
    blocks:[
      {type:'section',text:{type:'plain_text',text:`${count?`문서 전체 ${count}쪽. `:''}변환 파일은 원본 문서와 같은 스레드에 공유합니다.`}},
      {type:'input',block_id:'format',label:{type:'plain_text',text:'받을 형식'},element:{type:'static_select',action_id:'value',
        initial_option:{text:{type:'plain_text',text:'원문 텍스트 (.txt)'},value:'txt'},
        options:[{text:{type:'plain_text',text:'원문 텍스트 (.txt)'},value:'txt'},{text:{type:'plain_text',text:'선택 쪽 PNG 묶음 (.zip)'},value:'zip'}]}},
      {type:'input',block_id:'pages',optional:true,label:{type:'plain_text',text:'ZIP으로 받을 쪽'},hint:{type:'plain_text',text:'ZIP은 1~200쪽 중 최대 10쪽. 예: 1,3-5,12. TXT에는 쪽 선택을 적용하지 않습니다.'},
        element:{type:'plain_text_input',action_id:'value',initial_value:initial,max_length:120,placeholder:{type:'plain_text',text:'예: 1,3-5,12'}}},
      {type:'context',elements:[{type:'plain_text',text:'TXT는 원문 전체의 추출 가능한 글자만 담습니다. 그림 속 글자(OCR)·수식·표 배치 복원은 지원하지 않습니다. TXT 최대 2 MiB, ZIP 최대 26 MiB입니다.'}]},
    ]};
}

export function parseExportView(values:unknown):ExportRequest {
  const state=object(values),format=object(object(object(state.format).value).selected_option).value;
  if(format==='txt')return normalizeExportRequest({format:'txt'});
  if(format!=='zip')throw new UserError('invalid_export_format','원문 TXT 또는 선택 쪽 PNG ZIP을 선택하세요.');
  const raw=object(object(state.pages).value).value;
  if(typeof raw!=='string')throw new UserError('invalid_export_pages','ZIP으로 받을 쪽을 입력하세요. 예: 1,3-5,12');
  return normalizeExportRequest({format:'zip',pages:parsePageSelection(raw)});
}
