import {randomUUID} from 'node:crypto';
import {ID} from './config';
import type {Actor} from './access';
import {UserError} from './errors';
export interface Candidate {id:string; name:string;}
interface Selection {actor:Actor; candidates:Candidate[]; expiresAt:number;}
export class Selections {
  private items=new Map<string,Selection>();
  constructor(private now=Date.now, private ttlMs=5*60_000) {}
  sweep():void {for (const [id,item] of this.items) if(item.expiresAt<=this.now()) this.items.delete(id);}
  create(actor:Actor, candidates:Candidate[]):string {
    this.sweep();if(this.items.size>=1000)throw new UserError('selection_full','문서 선택 요청이 많습니다. 잠시 후 다시 시도하세요.');
    const id=randomUUID();this.items.set(id,{actor:{...actor},candidates:candidates.map(c=>({...c})),expiresAt:this.now()+this.ttlMs});return id;
  }
  get(id:string,teamId:string,userId:string,fileId:string):Actor {
    this.sweep();const item=this.items.get(id);
    if (!item || item.actor.teamId!==teamId || item.actor.userId!==userId || !item.candidates.some(c=>c.id===fileId)) {
      throw new UserError('invalid_selection','문서 선택이 만료되었거나 올바르지 않습니다. 메시지 메뉴에서 다시 선택하세요.');
    }
    return {...item.actor};
  }
  delete(id:string):void {this.items.delete(id);}
}
export function candidatesFrom(value:unknown):Candidate[] {
  if (!Array.isArray(value)) throw new UserError('no_files','이 메시지에 지원되는 HWP/HWPX 파일이 없습니다.');
  const result=new Map<string,Candidate>();
  for (const item of value) {
    if (item && typeof item.id==='string' && ID.file.test(item.id) && typeof item.name==='string' && /\.(hwp|hwpx)$/i.test(item.name)) {
      result.set(item.id,{id:item.id,name:item.name.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,70)});
    }
  }
  if (!result.size) throw new UserError('no_files','이 메시지에 지원되는 HWP/HWPX 파일이 없습니다.');
  if (result.size>100) throw new UserError('too_many_files','파일이 너무 많습니다. /dhwp open에 파일 링크 하나를 입력하세요.');
  return [...result.values()];
}
export function selectionView(id:string,candidates:Candidate[]) {
  return {type:'modal',callback_id:'rhwp_select_document',private_metadata:id,
    title:{type:'plain_text',text:'동국 한글문서 변환'},submit:{type:'plain_text',text:'변환 준비'},close:{type:'plain_text',text:'취소'},
    blocks:[{type:'input',block_id:'document',label:{type:'plain_text',text:'변환할 한글 문서'},element:{type:'static_select',action_id:'file',
      options:candidates.map(file=>({text:{type:'plain_text',text:file.name},value:file.id})),
    }}],
  };
}
