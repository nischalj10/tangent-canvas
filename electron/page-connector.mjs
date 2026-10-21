import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { CodexClient } from './codex.mjs';
import { canonicalPageUrl } from './pages.mjs';

const SERVER='codex_apps';
const MAX_MEDIA_BYTES=10*1024*1024;
const MAX_TEXT_BYTES=512*1024;
const referencePattern=/^(?:library-file|project-file|visualize):[A-Za-z0-9_+:-]{1,500}$/;
const clone=value=>structuredClone(value);
function pageIdentity(value){
  if(typeof value!=='string')throw Error('Choose a linked ChatGPT Page.');
  const url=value.startsWith('https:')?canonicalPageUrl(value):canonicalPageUrl(`https://chatgpt.com/space/${value}`);
  return{pageId:url.split('/').at(-1),url};
}
function structured(result){
  if(result?.structuredContent&&typeof result.structuredContent==='object')return result.structuredContent;
  for(const item of result?.content||[])if(item.type==='text')try{return JSON.parse(item.text)}catch{}
  return null;
}
function toolError(result,name){
  const data=structured(result),detail=data?.error?.message||data?.message||(result?.content||[]).find(item=>item.type==='text')?.text;
  const error=new Error(`${name}: ${String(detail||'The connected Page tool could not complete this request.').slice(0,1200)}`);
  error.code=data?.error?.code||data?.code||'PAGE_CONNECTOR_ERROR';error.commitStatus=data?.error?.commit_status;error.details=data?.error?.details;return error;
}
export function observedPageReferences(content,declared=[]){
  const refs=new Map();
  const add=(reference,extra={})=>{if(referencePattern.test(reference)&&!refs.has(reference))refs.set(reference,{reference,...extra})};
  for(const ref of declared)if(ref&&typeof ref.reference==='string')add(ref.reference,clone(ref));
  for(const block of content?.blocks||[]){
    // Markdown may escape the colon. The opaque ID is copied, never guessed.
    for(const match of String(block.markdown||'').matchAll(/(library-file|project-file|visualize)\\?:([A-Za-z0-9_+:-]+)/g))add(`${match[1]}:${match[2]}`);
    const image=block.metadata?.image;
    if(typeof image?.file_id==='string')add(/^[a-z-]+:/.test(image.file_id)?image.file_id:`library-file:${image.file_id}`,image.mime_type?{mime_type:image.mime_type}:{});
  }
  return [...refs.values()];
}
export function normalizePageSnapshot(result,identity){
  if(result?.isError)throw toolError(result,'Read Page');
  const data=structured(result),content=data?.content,metadata=data?.metadata;
  if(!content||!Array.isArray(content.blocks)||metadata?.page_id!==identity.pageId)throw Error('The connected Page returned no complete canonical block snapshot.');
  if(content.blocks.some(block=>typeof block.id!=='string'||typeof block.hash!=='string'||typeof block.markdown!=='string'))throw Error('The Page snapshot is missing canonical block IDs, hashes or Markdown.');
  return{...identity,title:content.title??metadata.title??'ChatGPT Page',titleHash:content.title_hash??null,blocks:clone(content.blocks),
    // Display metadata sequences are not mutation guards. Only use a supplied content guard.
    throughSequence:Number.isInteger(content.through_sequence)?content.through_sequence:null,
    displaySequence:metadata.current_sequence??metadata.projection_through_sequence??null,
    references:observedPageReferences(content,data.references||[]),syncedAt:Date.now(),canWrite:metadata.access?.can_write===true};
}
export class PageConnector extends EventEmitter{
  constructor({runtime,directory=process.cwd(),onRequest,requestTimeoutMs=120000,binary}={}){
    super();this.directory=directory;this.ownsRuntime=!runtime;this.runtime=runtime||new CodexClient({cwd:directory,requestTimeoutMs,...(binary?{binary}:{})});this.onRequest=onRequest;
    this.snapshots=new Map();this.edits=new Map();this.operations=new Set();this.requests=new Set();this.callTail=Promise.resolve();this.closed=false;
    const resetConnection=()=>{this.threadId=null;this.starting=null;this.requests.clear()};
    this.exitListener=()=>{resetConnection();this.emit('connectionError',{message:'The authenticated Page connection stopped. Refresh to reconnect.'})};
    this.errorListener=error=>{resetConnection();this.emit('connectionError',{message:error.message})};
    this.runtime.on('exit',this.exitListener);this.runtime.on('error',this.errorListener);
    this.notificationListener=({method,params})=>{const key=String(params?.requestId);if(method==='serverRequest/resolved'&&this.requests.delete(key))this.emit('requestResolved',{requestId:params.requestId})};
    this.runtime.on('notification',this.notificationListener);
    this.requestListener=request=>{
      if(request.params?.threadId!==this.threadId){if(this.ownsRuntime)this.runtime.reject(request.id,'The Page connector does not support this interactive request.');return}
      const pageId=request.params?._meta?.tool_params?.page_id;
      const operation=[...this.operations].find(op=>op.pageId===pageId)||([...this.operations].length===1?[...this.operations][0]:null);
      this.requests.add(String(request.id));
      const envelope={request,context:operation?{pageId:operation.pageId,operation:operation.operation,...(operation.contextId?{contextId:operation.contextId}:{})}:null};
      if(this.onRequest){Promise.resolve().then(()=>this.onRequest(envelope)).then(result=>{if(result!==undefined)this.respond(request.id,result)}).catch(()=>{try{this.reject(request.id,'The connected Page approval could not be completed.')}catch{}})}
      else if(this.listenerCount('serverRequest'))this.emit('serverRequest',envelope);
      else this.reject(request.id,'This connected Page action requires approval. Open its approval controls and try again.');
    };
    this.runtime.on('serverRequest',this.requestListener);
  }
  respond(id,result){this.requests.delete(String(id));return this.runtime.respond(id,result)}
  reject(id,message){this.requests.delete(String(id));return this.runtime.reject(id,message)}
  async start(){
    if(this.closed)throw Error('The Page connector is closed.');
    if(this.starting)return this.starting;
    this.starting=(async()=>{
      if(!this.runtime.connection?.connected)await this.runtime.start();
      const result=await this.runtime.request('thread/start',{ephemeral:true,cwd:this.directory,sandbox:'read-only',approvalPolicy:'on-request'});
      if(!result.thread?.id)throw Error('Codex did not create the internal Page connection.');this.threadId=result.thread.id;return this.threadId;
    })();
    try{return await this.starting}catch(error){this.starting=null;throw error}
  }
  call(pageId,tool,args,{contextId}={}){
    const operation=this.callTail.catch(()=>{}).then(async()=>{
      const threadId=await this.start(),current={pageId,operation:tool,...(contextId?{contextId}:{})};this.operations.add(current);
      try{
        const result=await this.runtime.request('mcpServer/tool/call',{threadId,server:SERVER,tool:`chatgpt_space.${tool}`,arguments:args});
        if(result?.isError)throw toolError(result,tool);return result;
      }finally{this.operations.delete(current)}
    });
    this.callTail=operation;return operation;
  }
  snapshotKey(pageId,contextId){return contextId?`${pageId}|${contextId}`:pageId}
  async read(value,{contextId}={}){
    const identity=pageIdentity(value);
    const result=await this.call(identity.pageId,'read_page',{page_id:identity.pageId,view:'editing',include_content:true},{contextId});
    const snapshot=normalizePageSnapshot(result,identity);
    try{
      const comments=structured(await this.call(identity.pageId,'list_page_comments',{page_id:identity.pageId,limit:100},{contextId}));
      if(Array.isArray(comments?.threads)){snapshot.comments=clone(comments.threads);snapshot.commentsTruncated=comments.truncated===true}
      else snapshot.commentsError='The connected tool returned no comment threads.';
    }catch(error){snapshot.commentsError=error.message}
    this.snapshots.set(this.snapshotKey(identity.pageId,contextId),clone(snapshot));return snapshot;
  }
  async readReference(value,reference,{contextId}={}){
    const {pageId}=pageIdentity(value);
    if(typeof reference!=='string'||!referencePattern.test(reference))throw Error('Use an exact image or visualization reference from this Page.');
    const snapshot=this.snapshots.get(this.snapshotKey(pageId,contextId))||await this.read(pageId,{contextId});
    if(!snapshot.references.some(ref=>ref.reference===reference))throw Error('That reference has not been observed on this Page. Refresh the Page first.');
    const result=await this.call(pageId,'read_page_reference',{page_id:pageId,reference},{contextId}),data=structured(result);
    if(data?.page_id!==pageId||data.reference!==reference)throw Error('The connected Page returned a different reference.');
    const mime=data.mime_type;
    let bytes,text;
    if(data.kind==='image'){
      const image=(result.content||[]).find(item=>item.type==='image');
      if(!image||typeof image.data!=='string'||!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)||image.mimeType!==mime)throw Error('The Page did not return supported image pixels.');
      if(image.data.length>Math.ceil(MAX_MEDIA_BYTES/3)*4+4)throw Error('The Page image exceeds the supported size.');
      bytes=Buffer.from(image.data,'base64');
    }else if(data.kind==='text'&&typeof data.text==='string'){
      text=data.text;bytes=Buffer.from(text,'utf8');if(bytes.length>MAX_TEXT_BYTES)throw Error('The Page visualization exceeds the supported size.');
    }else throw Error('The connected Page reference is not readable image or text content.');
    if(bytes.length>MAX_MEDIA_BYTES||bytes.length!==data.byte_size)throw Error('The Page reference size did not match its receipt.');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(data.sha256&&sha256!==data.sha256)throw Error('The Page reference bytes did not match their SHA-256 receipt.');
    return{reference,mime,sha256,...(text!==undefined?{text}:{bytes})};
  }
  async editBlock(value,input){
    const {pageId}=pageIdentity(value),previous=this.edits.get(pageId)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this._editBlock(pageId,input));this.edits.set(pageId,operation);
    try{return await operation}finally{if(this.edits.get(pageId)===operation)this.edits.delete(pageId)}
  }
  async editBlocks(value,{blocks,contextId}={}){
    const{pageId}=pageIdentity(value),previous=this.edits.get(pageId)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this._editBlocks(pageId,blocks,contextId));this.edits.set(pageId,operation);
    try{return await operation}finally{if(this.edits.get(pageId)===operation)this.edits.delete(pageId)}
  }
  async initializeEmpty(value,{contextId}={}){
    const{pageId}=pageIdentity(value),previous=this.edits.get(pageId)||Promise.resolve();
    const operation=previous.catch(()=>{}).then(async()=>{
      const current=await this.read(pageId,{contextId});
      if(current.blocks.length)return{...current,initialized:false};
      if(!current.canWrite)throw Object.assign(Error('This Page is read only.'),{mutationAttempted:false});
      // Both canonical neighbors are null only for an empty document. The
      // native location guard rejects an intervening external insertion.
      const args={page_id:pageId,stream_kind:'content',operations:[{op:'insert_markdown',block_units:[{kind:'markdown',markdown:''}],at:{kind:'between_blocks',preceding_block_id:null,following_block_id:null}}],...(current.throughSequence!=null?{base_sequence:current.throughSequence}:{})};
      let receipt;
      try{receipt=structured(await this.call(pageId,'edit_page',args,{contextId}))}
      catch(error){error.mutationAttempted=true;try{error.snapshot=await this.read(pageId,{contextId})}catch{}throw error}
      let refreshed;
      try{refreshed=await this.read(pageId,{contextId})}catch(error){error.code='PAGE_EDIT_UNCERTAIN';error.mutationAttempted=true;throw error}
      const results=receipt?.operation_results,result=results?.[0],block=refreshed.blocks[0],created=result?.created_block_ids,affected=result?.affected_blocks;
      if(!Array.isArray(results)||results.length!==1||result.operation_index!==0||result.status==='rejected'||result.ignored_reason||!Array.isArray(created)||created.length!==1||!Array.isArray(affected)||affected.length!==1||refreshed.blocks.length!==1||block?.id!==created[0]||block.markdown!==''||affected[0].block_id!==block.id||affected[0].hash!==block.hash)throw Object.assign(Error('The first paragraph save could not be verified. Refresh the Page before trying again.'),{code:'PAGE_EDIT_UNCERTAIN',snapshot:refreshed,receipt,mutationAttempted:true});
      return{...refreshed,initialized:true,editReceipt:receipt};
    });
    this.edits.set(pageId,operation);
    try{return await operation}finally{if(this.edits.get(pageId)===operation)this.edits.delete(pageId)}
  }
  async _editBlocks(pageId,blocks,contextId){
    const invalid=message=>Object.assign(Error(message),{mutationAttempted:false});
    if(!Array.isArray(blocks)||!blocks.length||blocks.length>100||new Set(blocks.map(b=>b.blockId)).size!==blocks.length||blocks.some(b=>typeof b.blockId!=='string'||typeof b.expectedHash!=='string'||!b.expectedHash||typeof b.markdown!=='string')||blocks.reduce((n,b)=>n+Buffer.byteLength(b.markdown),0)>262144)throw invalid('Supply guarded Page blocks within the supported save size.');
    let current;
    try{current=await this.read(pageId,{contextId})}catch(error){error.mutationAttempted=false;throw error}
    const operations=[],plans=[],claimed=new Set();
    const conflict=()=>Object.assign(Error('This Page changed before saving.'),{code:'PAGE_CONFLICT',snapshot:current,mutationAttempted:false});
    for(const input of blocks){
      if(input.blockId==='__title__'){
        if(current.titleHash!==input.expectedHash)throw conflict();
        plans.push({input,index:operations.length,targets:[],deletes:[]});operations.push({op:'set_title',title:input.markdown,expected_title_hash:input.expectedHash});continue;
      }
      const targets=input.targets||[{id:input.blockId,hash:input.expectedHash}];
      if(!Array.isArray(targets)||!targets.length||targets[0].id!==input.blockId||targets.some(target=>typeof target.id!=='string'||typeof target.hash!=='string'||claimed.has(target.id)))throw invalid('Supply an exact, non-overlapping source-block span.');
      const positions=targets.map(target=>current.blocks.findIndex(block=>block.id===target.id));
      if(positions.some((position,index)=>position<0||current.blocks[position].hash!==targets[index].hash||index>0&&position!==positions[index-1]+1))throw conflict();
      for(const target of targets)claimed.add(target.id);
      const plan={input,index:operations.length,targets,deletes:[]};plans.push(plan);
      operations.push({op:'replace_block_markdown',block_id:input.blockId,expected_hash:input.expectedHash,block_units:[{kind:'markdown',markdown:input.markdown}]});
      for(const target of targets.slice(1)){plan.deletes.push(operations.length);operations.push({op:'delete_block',block_id:target.id,expected_hash:target.hash})}
    }
    if(operations.length>100)throw invalid('This save contains too many source-block operations.');
    let receipt;
    try{receipt=structured(await this.call(pageId,'edit_page',{page_id:pageId,stream_kind:'content',operations,...(current.throughSequence!=null?{base_sequence:current.throughSequence}:{})},{contextId}))}
    catch(error){error.mutationAttempted=true;throw error}
    let refreshed;
    try{refreshed=await this.read(pageId,{contextId})}catch(error){error.code='PAGE_EDIT_UNCERTAIN';error.mutationAttempted=true;throw error}
    const results=receipt?.operation_results,mappings={};
    const resultAt=index=>Array.isArray(results)&&results.find(item=>item.operation_index===index);
    const applied=result=>result&&result.status!=='rejected'&&!result.ignored_reason;
    const verified=Array.isArray(results)&&results.length===operations.length&&plans.every(plan=>{
      const{input}=plan,result=resultAt(plan.index);
      if(!applied(result))return false;
      if(input.blockId==='__title__')return refreshed.title===input.markdown&&typeof refreshed.titleHash==='string'&&!!refreshed.titleHash;
      const affected=result.affected_blocks||[],ids=new Set([input.blockId,...(result.created_block_ids||[])]);
      const blocks=refreshed.blocks.filter(block=>ids.has(block.id)),positions=blocks.map(block=>refreshed.blocks.indexOf(block));
      if(blocks.length!==ids.size||blocks[0]?.id!==input.blockId||positions.some((position,index)=>index>0&&position!==positions[index-1]+1)||blocks.map(block=>block.markdown).join('\n\n')!==input.markdown||!affected.length||!affected.every(item=>ids.has(item.block_id)&&blocks.some(block=>block.id===item.block_id&&block.hash===item.hash))||!blocks.every(block=>affected.some(item=>item.block_id===block.id&&item.hash===block.hash)))return false;
      if(!plan.deletes.every(index=>applied(resultAt(index))&&!refreshed.blocks.some(block=>block.id===operations[index].block_id)))return false;
      mappings[input.blockId]={blocks:clone(blocks),markdown:input.markdown};return true;
    });
    if(!verified)throw Object.assign(Error('The Page save returned, but its exact guarded blocks could not be verified.'),{code:'PAGE_EDIT_UNCERTAIN',snapshot:refreshed,receipt,mutationAttempted:true});
    return{...refreshed,editReceipt:receipt,editMappings:mappings};
  }
  async _editBlock(pageId,{blockId,expectedHash,markdown,throughSequence,contextId}={}){
    if(typeof blockId!=='string'||typeof expectedHash!=='string'||!expectedHash||typeof markdown!=='string'||markdown.length>262144)throw Error('Supply the observed block ID and hash with its replacement Markdown.');
    const current=await this.read(pageId,{contextId}),block=current.blocks.find(item=>item.id===blockId);
    if(!block||block.hash!==expectedHash||throughSequence!=null&&throughSequence!==current.throughSequence){
      const error=new Error('This Page changed while you were editing. Refresh it before saving.');error.code='PAGE_CONFLICT';error.snapshot=current;throw error;
    }
    const args={page_id:pageId,stream_kind:'content',operations:[{op:'replace_block_markdown',block_id:blockId,expected_hash:expectedHash,markdown}],...(current.throughSequence!=null?{base_sequence:current.throughSequence}:{})};
    const receipt=structured(await this.call(pageId,'edit_page',args,{contextId}));
    // Never replay a mutation, including after a missing or uncertain acknowledgement.
    const refreshed=await this.read(pageId,{contextId}),expected=markdown.replace(/\r\n/g,'\n').trim();
    const result=receipt?.operation_results?.find(item=>item.operation_index===0);
    const affected=result?.affected_blocks||[],ids=new Set([blockId,...(result?.created_block_ids||[]),...affected.map(item=>item.block_id)]);
    const actual=refreshed.blocks.filter(item=>ids.has(item.id)).map(item=>item.markdown.replace(/\r\n/g,'\n').trim()).filter(Boolean).join('\n\n');
    const receiptMatches=Boolean(result)&&affected.every(item=>refreshed.blocks.some(block=>block.id===item.block_id&&block.hash===item.hash));
    if(!receiptMatches||actual!==expected){
      const error=new Error('The Page edit returned, but its exact replacement could not be verified. Review the refreshed Page before editing again.');error.code='PAGE_EDIT_UNCERTAIN';error.snapshot=refreshed;error.receipt=receipt;throw error;
    }
    return{...refreshed,editReceipt:receipt};
  }
  async close(){
    if(this.closed)return;this.closed=true;this.runtime.off('serverRequest',this.requestListener);this.runtime.off('exit',this.exitListener);this.runtime.off('error',this.errorListener);this.runtime.off('notification',this.notificationListener);
    if(this.ownsRuntime)await this.runtime.close();
    else if(this.threadId)try{await this.runtime.request('thread/unsubscribe',{threadId:this.threadId})}catch{}
    this.snapshots.clear();
  }
}
