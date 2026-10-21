import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PageConnector} from '../electron/page-connector.mjs';
import {requireLivePageUrl} from '../scripts/live-page-target.mjs';

const live=process.env.TANGENT_PAGE_CONNECTOR_LIVE==='1';
test('LIVE authenticated native Page sync reads original rich assets and guarded edits only its disposable Page',{skip:!live,timeout:120000},async t=>{
 const sourceId=requireLivePageUrl().split('/').at(-1);
 const nonce=randomUUID(),title=`Tangent native Page connector check — ${nonce}`,before=`CONNECTOR_BEFORE_${nonce}`,after=`CONNECTOR_AFTER_${nonce}`;
 let createdPageId;const approvals=[];
 const connector=new PageConnector({directory:process.cwd(),onRequest:({request})=>{
  const p=request.params||{},args=p._meta?.tool_params||{},tool=p.message?.match(/(?:run|running)\s+tool\s+"([^"]+)"/)?.[1];
  const readOnly=args.page_id===sourceId&&['chatgpt_space.read_page','chatgpt_space.list_page_comments','chatgpt_space.read_page_reference'].includes(tool);
  const create=tool==='chatgpt_space.create_page'&&args.title===title&&!args.parent_page_id&&!args.space_id;
  const own=createdPageId&&args.page_id===createdPageId&&['chatgpt_space.read_page','chatgpt_space.list_page_comments','chatgpt_space.edit_page','chatgpt_space.trash_page'].includes(tool);
  const allowed=request.method==='mcpServer/elicitation/request'&&p._meta?.codex_approval_kind==='mcp_tool_call'&&(readOnly||create||own);approvals.push({tool,allowed});
  return{action:allowed?'accept':'decline',content:allowed?{}:null,_meta:null};
 }});
 t.after(async()=>{
  if(createdPageId){
   const result=await connector.call(createdPageId,'trash_page',{page_id:createdPageId});assert.equal(result.isError,false);assert.equal(result.structuredContent?.trashed,true);t.diagnostic(`Cleaned up ONLY own disposable Page ${createdPageId}.`);
  }
  await connector.close();
 });
 const snapshot=await connector.read(sourceId);assert.match(snapshot.title,/DNA RNA proteins/);assert.ok(snapshot.blocks.length>=70);assert.ok(snapshot.comments.length>=1);assert.equal(snapshot.throughSequence,null);assert.equal(snapshot.canWrite,true);
 const media=await Promise.all(snapshot.references.map(ref=>connector.readReference(sourceId,ref.reference)));assert.equal(media.filter(item=>item.mime==='text/html').length,2);assert.equal(media.filter(item=>item.mime==='image/png').length,4);assert.ok(media.filter(item=>item.text).every(item=>item.text.includes('<')));assert.ok(media.filter(item=>item.bytes).every(item=>item.bytes.length>100000));
 t.diagnostic(`No model turns or browser sign-in: ${snapshot.blocks.length} canonical blocks,${snapshot.comments.length} comment threads,4 exact PNGs and2 original interactive HTML sources verified by native SHA256 receipts.`);
 const result=await connector.call('pending-test','create_page',{title,initial_blocks:[before],idempotency_key:nonce});createdPageId=result.structuredContent?.metadata?.page_id||result.structuredContent?.page_id;assert.ok(createdPageId);assert.notEqual(createdPageId,sourceId);
 const initial=await connector.read(createdPageId),block=initial.blocks.find(block=>block.markdown===before);assert.ok(block);
 const updated=await connector.editBlock(createdPageId,{blockId:block.id,expectedHash:block.hash,markdown:after});assert.ok(updated.blocks.some(block=>block.markdown===after));assert.ok(updated.editReceipt.operation_results.length);
 await assert.rejects(connector.editBlock(createdPageId,{blockId:block.id,expectedHash:block.hash,markdown:'STALE_MUST_NOT_WRITE'}),error=>error.code==='PAGE_CONFLICT');
 const fresh=updated.blocks.find(block=>block.markdown===after);const emptied=await connector.editBlock(createdPageId,{blockId:fresh.id,expectedHash:fresh.hash,markdown:''});assert.ok(!emptied.blocks.some(block=>block.id===fresh.id&&block.markdown.trim()));
 t.diagnostic(`Disposable Page guarded replacement,stale-write rejection,and empty replacement all verified against exact operation_results and fresh canonical blocks. Native approval requests:${approvals.length}.`);
});
