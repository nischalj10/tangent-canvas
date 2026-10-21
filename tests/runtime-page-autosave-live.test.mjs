import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PageConnector} from '../electron/page-connector.mjs';

test('LIVE typed atomic Page autosave preserves canonical block ID, metadata, blank blocks and title guards',{skip:process.env.TANGENT_PAGE_AUTOSAVE_LIVE!=='1',timeout:150000},async t=>{
  const nonce=randomUUID(),title=`Tangent autosave integration check — ${nonce}`;let ownPage;
  const connector=new PageConnector({directory:process.cwd(),onRequest:({request})=>{
    const p=request.params||{},args=p._meta?.tool_params||{},tool=p.message?.match(/(?:run|running)\s+tool\s+"([^"]+)"/)?.[1];
    const create=tool==='chatgpt_space.create_page'&&args.title===title&&!args.parent_page_id&&!args.space_id;
    const own=ownPage&&args.page_id===ownPage&&['chatgpt_space.read_page','chatgpt_space.list_page_comments','chatgpt_space.edit_page','chatgpt_space.trash_page'].includes(tool);
    const allowed=request.method==='mcpServer/elicitation/request'&&p._meta?.codex_approval_kind==='mcp_tool_call'&&(create||own);
    return{action:allowed?'accept':'decline',content:allowed?{}:null,_meta:null};
  }});
  const proof={nonce,source:'Official authenticated Codex app-server MCP transport',originalPagesReadOrWritten:false};
  try{
    const result=await connector.call('new-autosave-probe','create_page',{title,initial_blocks:['Alpha base Omega','Unrelated original block'],idempotency_key:nonce});
    ownPage=result.structuredContent?.metadata?.page_id||result.structuredContent?.page_id;assert.ok(ownPage);proof.pageId=ownPage;
    let snapshot=await connector.read(ownPage),body=snapshot.blocks.find(block=>block.markdown==='Alpha base Omega');assert.ok(body);
    await connector.call(ownPage,'edit_page',{page_id:ownPage,stream_kind:'content',operations:[{op:'set_block_metadata',block_id:body.id,expected_hash:body.hash,metadata:{tangent_autosave_probe:{nonce}}}]});
    snapshot=await connector.read(ownPage);body=snapshot.blocks.find(block=>block.id===body.id);const untouched=structuredClone(snapshot.blocks.filter(block=>block.id!==body.id)),metadata=structuredClone(body.metadata);
    const markdown='Alpha **rich** Omega\n\nA second paragraph in the same canonical source block. 😀';
    const saved=await connector.editBlocks(ownPage,{blocks:[{blockId:body.id,expectedHash:body.hash,markdown},{blockId:'__title__',expectedHash:snapshot.titleHash,markdown:`${title} — saved`} ]});
    const mapped=saved.editMappings[body.id].blocks,updated=saved.blocks.find(block=>block.id===body.id);assert.equal(mapped.map(block=>block.markdown).join('\n\n'),markdown);assert.equal(mapped[0].id,body.id);assert.deepEqual(updated.metadata,metadata);assert.deepEqual(saved.blocks.filter(block=>!mapped.some(owned=>owned.id===block.id)),untouched);assert.equal(saved.title,`${title} — saved`);assert.equal(saved.editReceipt.operation_results.length,2);
    await assert.rejects(connector.editBlocks(ownPage,{blocks:[{blockId:body.id,expectedHash:body.hash,markdown:'STALE MUST NOT WRITE'}]}),error=>error.code==='PAGE_CONFLICT');
    const blank=await connector.editBlocks(ownPage,{blocks:[{blockId:body.id,expectedHash:updated.hash,targets:mapped.map(block=>({id:block.id,hash:block.hash})),markdown:''}]});assert.equal(blank.blocks.find(block=>block.id===body.id)?.markdown,'');assert.deepEqual(blank.blocks.find(block=>block.id===body.id)?.metadata,metadata);assert.deepEqual(blank.blocks.filter(block=>block.id!==body.id),untouched);
    Object.assign(proof,{passed:true,canonicalBlockId:body.id,firstSourceIdPreserved:true,nativeSplitReceiptTracked:mapped.length>1,ownTrailingSpanGuardedlyRemoved:true,metadataPreserved:true,unrelatedBlocksPreserved:true,intentionalBlankPreserved:true,guardedTitleSaved:true,staleRejected:true,receiptOperations:saved.editReceipt.operation_results.map(item=>({index:item.operation_index,status:item.status||'applied',created:item.created_block_ids,affected:item.affected_blocks}))});
  }catch(error){
    proof.error={message:error.message,code:error.code,receipt:error.receipt,snapshot:error.snapshot};throw error;
  }finally{
    if(ownPage){try{const cleanup=await connector.call(ownPage,'trash_page',{page_id:ownPage});proof.ownDisposablePageTrashed=cleanup.structuredContent?.trashed===true;assert.equal(proof.ownDisposablePageTrashed,true)}catch(error){proof.cleanupError=error.message;t.diagnostic(`Own disposable Page retained for cleanup: ${ownPage}`)}}
    await fs.mkdir(path.resolve(process.cwd(),'../../work'),{recursive:true});await fs.writeFile(path.resolve(process.cwd(),'../../work/page-autosave-live-proof.json'),JSON.stringify(proof,null,2)+'\n');await connector.close();
  }
  t.diagnostic('Native typed units preserve one source ID/metadata through rich multi-paragraph and blank edits; atomic body+title receipts and stale rejection verified. Only own disposable Page touched and trashed.');
});
