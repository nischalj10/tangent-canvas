import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {PageConnector} from '../electron/page-connector.mjs';
const pageId='page_abcdefgh1234';
const image=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
class NativePeer extends EventEmitter{
 constructor(){super();this.connection={connected:true};this.calls=[];this.hash='hash-v1';this.markdown='Original paragraph';this.responses=[]}
 async request(method,args){
  this.calls.push({method,args:structuredClone(args)});
  if(method==='thread/start')return{thread:{id:'internal-ephemeral'}};
  if(method==='thread/unsubscribe')return{};
  assert.equal(method,'mcpServer/tool/call');assert.equal(args.server,'codex_apps');const input=args.arguments;
  if(args.tool==='chatgpt_space.read_page')return{structuredContent:{metadata:{page_id:input.page_id,title:'Exact Page',current_sequence:101,projection_through_sequence:100,access:{can_write:true}},content:{title:'Exact Page',title_hash:'title-hash',blocks:[{id:'block-1',hash:this.hash,kind:'markdown',markdown:this.markdown,metadata:{}},{id:'image-1',hash:'image-hash',kind:'markdown',markdown:'![Image](library-file\\:file_first)',metadata:{image:{file_id:'file_second'}}}]},references:[{reference:'visualize:file_chart',mime_type:'text/html'}]}};
  if(args.tool==='chatgpt_space.list_page_comments')return{structuredContent:{threads:[{id:'comment-thread',selectionContext:{start:{blockId:'block-1',offsetUtf16:2}},messages:[{body:'An exact comment'}]}],truncated:false}};
  if(args.tool==='chatgpt_space.read_page_reference'){
   const html=input.reference.startsWith('visualize:'),bytes=html?Buffer.from('<html><script>interactive()</script></html>'):image;
   return{structuredContent:{page_id:input.page_id,reference:input.reference,kind:html?'text':'image',mime_type:html?'text/html':'image/png',byte_size:bytes.length,sha256:this.badDigest?'incorrect':digest(bytes),text:html?bytes.toString():null},content:html?[]:[{type:'image',mimeType:'image/png',data:bytes.toString('base64')}]};
  }
  if(args.tool==='chatgpt_space.edit_page'){
   assert.equal(input.operations[0].expected_hash,this.hash);if(!this.skipMutation){this.hash='hash-v2';this.markdown=input.operations[0].markdown}
   return{structuredContent:{operation_results:[{operation_index:0,created_block_ids:[],affected_blocks:[{block_id:'block-1',hash:this.hash}]}]}};
  }
  throw Error('Unsupported native fixture method');
 }
 respond(id,result){this.responses.push({id,result})}
 reject(id,message){this.responses.push({id,error:message})}
}
function setup(t){const runtime=new NativePeer(),connector=new PageConnector({runtime,directory:'/tmp'});t.after(()=>connector.close());return{runtime,connector}}
test('Page sync uses one ephemeral native transport, preserves canonical blocks/comments and observes escaped media IDs',async t=>{
 const{runtime,connector}=setup(t);const [a,b]=await Promise.all([connector.read(pageId),connector.read(pageId)]);
 assert.equal(runtime.calls.filter(c=>c.method==='thread/start').length,1);assert.equal(runtime.calls[0].args.ephemeral,true);assert.equal(runtime.calls[0].args.sandbox,'read-only');assert.ok(runtime.calls.every(c=>!c.method.startsWith('turn/')));
 assert.equal(a.blocks[0].id,'block-1');assert.equal(a.blocks[0].hash,'hash-v1');assert.equal(a.throughSequence,null);assert.equal(a.displaySequence,101);assert.equal(a.titleHash,'title-hash');assert.equal(a.comments[0].selectionContext.start.offsetUtf16,2);assert.deepEqual(a.references.map(r=>r.reference),['visualize:file_chart','library-file:file_first','library-file:file_second']);a.blocks[0].markdown='Local mutation';assert.equal(b.blocks[0].markdown,'Original paragraph');assert.ok(!JSON.stringify(a).includes(image.toString('base64')));
});
test('reference sync returns authenticated image bytes and original interactive HTML with verified receipts',async t=>{
 const{connector}=setup(t);await connector.read(pageId);const png=await connector.readReference(pageId,'library-file:file_first'),html=await connector.readReference(pageId,'visualize:file_chart');
 assert.deepEqual(png.bytes,image);assert.equal(png.sha256,digest(image));assert.equal(png.mime,'image/png');assert.equal(html.mime,'text/html');assert.equal(html.text,'<html><script>interactive()</script></html>');assert.equal(html.bytes,undefined);
});
test('reference sync refuses guessed cross-Page media and mismatched source hashes',async t=>{
 const{runtime,connector}=setup(t);await connector.read(pageId);const count=runtime.calls.length;await assert.rejects(connector.readReference(pageId,'library-file:file_unknown'),/not been observed/);assert.equal(runtime.calls.length,count);runtime.badDigest=true;await assert.rejects(connector.readReference(pageId,'library-file:file_first'),/SHA-256/);await assert.rejects(connector.read('https://evil.test/space/page_abcdefgh1234'));
});
test('block edits freshly guard the exact block and read back the same Page without invented sequence guards',async t=>{
 const{runtime,connector}=setup(t);const refreshed=await connector.editBlock(pageId,{blockId:'block-1',expectedHash:'hash-v1',markdown:'Verified replacement'});
 const call=runtime.calls.find(c=>c.args.tool==='chatgpt_space.edit_page');assert.deepEqual(call.args.arguments,{page_id:pageId,stream_kind:'content',operations:[{op:'replace_block_markdown',block_id:'block-1',expected_hash:'hash-v1',markdown:'Verified replacement'}]});assert.equal(refreshed.blocks[0].markdown,'Verified replacement');assert.ok(refreshed.editReceipt);assert.equal(runtime.calls.filter(c=>c.args.tool==='chatgpt_space.edit_page').length,1);
});
test('a stale block edit never sends a cloud mutation',async t=>{
 const{runtime,connector}=setup(t);runtime.hash='a-newer-user-edit';await assert.rejects(connector.editBlock(pageId,{blockId:'block-1',expectedHash:'hash-v1',markdown:'Must not overwrite'}),error=>error.code==='PAGE_CONFLICT'&&error.snapshot.blocks[0].hash==='a-newer-user-edit');assert.equal(runtime.calls.filter(c=>c.args.tool==='chatgpt_space.edit_page').length,0);
});
test('native approvals are forwarded with Page context and are not automatically accepted',async t=>{
 const{runtime,connector}=setup(t);await connector.start();const operation={pageId,operation:'edit_page'};connector.operations.add(operation);
 let event;connector.on('serverRequest',value=>event=value);const request={id:'approval',method:'mcpServer/elicitation/request',params:{threadId:'internal-ephemeral',_meta:{tool_params:{page_id:pageId}}}};runtime.emit('serverRequest',request);assert.equal(event.request,request);assert.deepEqual(event.context,{pageId,operation:'edit_page'});assert.equal(runtime.responses.length,0);connector.respond('approval',{action:'decline',content:null,_meta:null});assert.equal(runtime.responses[0].result.action,'decline');connector.operations.delete(operation);
});
test('a replacement appearing elsewhere is not proof that the selected block changed',async t=>{
 const{runtime,connector}=setup(t);runtime.skipMutation=true;await assert.rejects(connector.editBlock(pageId,{blockId:'block-1',expectedHash:'hash-v1',markdown:'![Image](library-file\\:file_first)'}),error=>error.code==='PAGE_EDIT_UNCERTAIN'&&error.snapshot.blocks[0].markdown==='Original paragraph');assert.equal(runtime.calls.filter(c=>c.args.tool==='chatgpt_space.edit_page').length,1);
});
test('an empty replacement must be verified against the affected block, not automatically accepted',async t=>{
 const{runtime,connector}=setup(t);runtime.skipMutation=true;await assert.rejects(connector.editBlock(pageId,{blockId:'block-1',expectedHash:'hash-v1',markdown:''}),error=>error.code==='PAGE_EDIT_UNCERTAIN');runtime.skipMutation=false;const result=await connector.editBlock(pageId,{blockId:'block-1',expectedHash:'hash-v1',markdown:''});assert.equal(result.blocks[0].markdown,'');assert.ok(result.editReceipt.operation_results.length);
});
test('an internal transport error is contained and the next sync creates a new ephemeral connection',async t=>{
 const{runtime,connector}=setup(t);await connector.read(pageId);let error;connector.on('connectionError',event=>error=event.message);runtime.emit('error',new Error('Native transport stopped'));assert.equal(error,'Native transport stopped');await connector.read(pageId);assert.equal(runtime.calls.filter(c=>c.method==='thread/start').length,2);
});
test('same-Page calls serialize native approvals and preserve exact canvas context through nested reads and edits',async t=>{
 const{runtime,connector}=setup(t),native=runtime.request.bind(runtime),contexts=[];let active=0,peak=0;
 connector.on('serverRequest',({request,context})=>{contexts.push(context);connector.respond(request.id,{action:'accept',content:{},_meta:null})});
 runtime.request=async(method,args)=>{
  if(method!=='mcpServer/tool/call')return native(method,args);
  active++;peak=Math.max(peak,active);runtime.emit('serverRequest',{id:'approval-'+contexts.length,method:'mcpServer/elicitation/request',params:{threadId:'internal-ephemeral',_meta:{tool_params:{page_id:args.arguments.page_id}}}});
  await new Promise(resolve=>setImmediate(resolve));try{return await native(method,args)}finally{active--}
 };
 await Promise.all([connector.read(pageId,{contextId:'board-a:node-a'}),connector.read(pageId,{contextId:'board-b:node-b'})]);assert.equal(peak,1);assert.deepEqual(contexts.filter(c=>c.operation==='read_page').map(c=>c.contextId),['board-a:node-a','board-b:node-b']);
 await connector.readReference(pageId,'library-file:file_first',{contextId:'board-b:node-b'});assert.equal(contexts.at(-1).contextId,'board-b:node-b');
 const before=contexts.length;await connector.editBlock(pageId,{blockId:'block-1',expectedHash:'hash-v1',markdown:'A precise update',contextId:'board-a:node-a'});assert.ok(contexts.slice(before).every(context=>context.contextId==='board-a:node-a'));assert.equal(peak,1);
});
test('resolved native Page requests and transport exits invalidate only connector approvals',async t=>{
 const{runtime,connector}=setup(t);await connector.start();connector.on('serverRequest',()=>{});const resolved=[],errors=[];connector.on('requestResolved',event=>resolved.push(event.requestId));connector.on('connectionError',event=>errors.push(event.message));
 runtime.emit('serverRequest',{id:'page-approval',method:'mcpServer/elicitation/request',params:{threadId:'internal-ephemeral'}});runtime.emit('notification',{method:'serverRequest/resolved',params:{requestId:'other-chat'}});assert.deepEqual(resolved,[]);runtime.emit('notification',{method:'serverRequest/resolved',params:{requestId:'page-approval'}});assert.deepEqual(resolved,['page-approval']);
 runtime.emit('serverRequest',{id:'disconnected-approval',method:'mcpServer/elicitation/request',params:{threadId:'internal-ephemeral'}});runtime.emit('exit',{code:1});assert.equal(connector.requests.size,0);assert.equal(errors.length,1);assert.equal(connector.threadId,null);
});

class EmptyPeer extends NativePeer{
 constructor(){super();this.blocks=[];this.writes=0}
 async request(method,args){
  if(method!=='mcpServer/tool/call')return super.request(method,args);
  const input=args.arguments;
  if(args.tool==='chatgpt_space.read_page'){this.calls.push({method,args:structuredClone(args)});return{structuredContent:{metadata:{page_id:input.page_id,access:{can_write:!this.readonly}},content:{title:'Empty Page',title_hash:'title-hash',blocks:structuredClone(this.blocks)}}}}
  if(args.tool==='chatgpt_space.list_page_comments')return{structuredContent:{threads:[],truncated:false}};
  if(args.tool==='chatgpt_space.edit_page'){
   this.writes++;this.lastInsert=structuredClone(input);
   assert.deepEqual(input.operations,[{op:'insert_markdown',block_units:[{kind:'markdown',markdown:''}],at:{kind:'between_blocks',preceding_block_id:null,following_block_id:null}}]);
   if(this.externalInsert)this.blocks.push({id:'external-source',hash:'external-hash',kind:'markdown',markdown:'New cloud paragraph',metadata:{keep:true}});
   if(this.blocks.length)return{isError:true,structuredContent:{error:{code:'edit_conflict',commit_status:'not_committed',message:'Canonical neighbors are no longer adjacent'}}};
   this.blocks=[{id:'first-canonical',hash:'blank-hash',kind:'markdown',markdown:'',metadata:{}}];
   return{structuredContent:{operation_results:this.omitReceipt?[]:[{operation_index:0,created_block_ids:['first-canonical'],affected_blocks:[{block_id:'first-canonical',hash:'blank-hash'}]}]}};
  }
  return super.request(method,args);
 }
}
test('empty Page initialization uses canonical empty-neighbor guard, exact blank receipt and serializes duplicate clicks',async t=>{
 const runtime=new EmptyPeer(),connector=new PageConnector({runtime});t.after(()=>connector.close());
 const [a,b]=await Promise.all([connector.initializeEmpty(pageId),connector.initializeEmpty(pageId)]);
 assert.equal(a.initialized,true);assert.equal(b.initialized,false);assert.equal(runtime.writes,1);assert.equal(a.blocks[0].id,'first-canonical');assert.equal(a.blocks[0].markdown,'');assert.equal(a.blocks[0].hash,'blank-hash');assert.equal(runtime.lastInsert.base_sequence,undefined);
});
test('empty Page native neighbor guard preserves an intervening cloud paragraph without replay',async t=>{
 const runtime=new EmptyPeer(),connector=new PageConnector({runtime});t.after(()=>connector.close());runtime.externalInsert=true;
 await assert.rejects(connector.initializeEmpty(pageId),error=>error.code==='edit_conflict'&&error.commitStatus==='not_committed'&&error.snapshot.blocks[0].id==='external-source');
 const latest=await connector.initializeEmpty(pageId);assert.equal(latest.initialized,false);assert.equal(runtime.writes,1);assert.equal(latest.blocks[0].markdown,'New cloud paragraph');assert.deepEqual(latest.blocks[0].metadata,{keep:true});
});
test('empty Page missing receipt is uncertain and a fresh explicit retry never inserts twice; read-only stays untouched',async t=>{
 const runtime=new EmptyPeer(),connector=new PageConnector({runtime});t.after(()=>connector.close());runtime.omitReceipt=true;
 await assert.rejects(connector.initializeEmpty(pageId),error=>error.code==='PAGE_EDIT_UNCERTAIN'&&error.snapshot.blocks.length===1);
 assert.equal((await connector.initializeEmpty(pageId)).initialized,false);assert.equal(runtime.writes,1);
 runtime.blocks=[];runtime.readonly=true;await assert.rejects(connector.initializeEmpty(pageId),/read only/);assert.equal(runtime.writes,1);
});
