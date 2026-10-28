import {SaxesParser} from 'saxes';
import {ConversionFailure} from './failures.mjs';

const MAX_BYTES=16*1024*1024,MAX_DEPTH=128,MAX_NODES=200_000,MAX_ATTRIBUTE_BYTES=8*1024*1024;
const fail=()=>{throw new ConversionFailure('xml_input');};

/** Strict, namespace-aware XML. DTDs/entities never resolve files or networks. */
export function parseXml(input){
  try{
    if(!(input instanceof Uint8Array)&&typeof input!=='string')fail();
    if((typeof input==='string'?Buffer.byteLength(input):input.byteLength)>MAX_BYTES)fail();
    const text=typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true}).decode(input);
    if(!text.isWellFormed())fail();
    const parser=new SaxesParser({xmlns:true}),stack=[];let root,nodes=0,textBytes=0,attributeBytes=0;
    parser.on('error',fail);parser.on('doctype',fail);
    parser.on('xmldecl',decl=>{if(decl.encoding&&!/^utf-?8$/i.test(decl.encoding))fail();});
    parser.on('opentag',tag=>{
      if(++nodes>MAX_NODES||stack.length>=MAX_DEPTH||tag.name.length>256||tag.uri.length>2048)fail();
      const attrs=Object.create(null),attributes=Object.values(tag.attributes);
      if(attributes.length>128)fail();
      for(const attribute of attributes){
        if(attribute.name.length>256||attribute.value.length>65_536)fail();
        attributeBytes+=Buffer.byteLength(attribute.name)+Buffer.byteLength(attribute.value);
        if(attributeBytes>MAX_ATTRIBUTE_BYTES)fail();attrs[attribute.name]=attribute.value;
      }
      const node={name:tag.local,qname:tag.name,uri:tag.uri,attrs,children:[]};
      if(stack.length)stack.at(-1).children.push(node);else{if(root)fail();root=node;}
      stack.push(node);
    });
    const append=value=>{
      textBytes+=Buffer.byteLength(value);if(textBytes>MAX_BYTES)fail();
      if(!stack.length){if(value.trim())fail();return;}
      const children=stack.at(-1).children;
      if(typeof children.at(-1)==='string')children[children.length-1]+=value;
      else{if(++nodes>MAX_NODES)fail();children.push(value);}
    };
    parser.on('text',append);parser.on('cdata',append);parser.on('closetag',()=>{if(!stack.length)fail();stack.pop();});
    parser.write(text).close();if(!root||stack.length)fail();return root;
  }catch{fail();}
}

export function childElements(node,name){return node.children.filter(child=>typeof child!=='string'&&(name===undefined||child.name===name));}
export function textContent(node){
  const parts=[],stack=[node];
  while(stack.length){const item=stack.pop();if(typeof item==='string')parts.push(item);else for(let i=item.children.length-1;i>=0;i--)stack.push(item.children[i]);}
  return parts.join('');
}
export function attr(node,name){
  if(Object.hasOwn(node.attrs,name))return node.attrs[name];
  const candidates=Object.keys(node.attrs).filter(key=>key.split(':').at(-1)===name);
  return candidates.length===1?node.attrs[candidates[0]]:undefined;
}
