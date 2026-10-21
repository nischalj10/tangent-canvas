import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {_electron as electron,expect} from '@playwright/test';
import {selectPageText,placePageCaretAtEnd,typeAtPageEnd,nativePageShortcut} from './page-editor-helpers.mjs';

const root=path.resolve(import.meta.dirname,'..');
const sourceDirectory=process.env.TANGENT_PAGE_FIXTURE_DIR||path.resolve(root,'../../work/native-page-source');
const hash=value=>createHash('sha256').update(value).digest('hex');

test('direct Page editor: rich input, durable autosave, delayed acknowledgments, conflict recovery and unchanged media',{timeout:180000},async t=>{
  const sourceBytes=await fs.readFile(path.join(sourceDirectory,'page.json'));
  const source=JSON.parse(sourceBytes),comments=JSON.parse(await fs.readFile(path.join(sourceDirectory,'comments.json'),'utf8'));
  const candidates=source.content.blocks.filter(block=>block.markdown.length>70&&!/^(?:#|!|\||>|[-*]\s|\d+\.)/.test(block.markdown));
  assert.ok(candidates.length>=2);const firstId=candidates[0].id,secondId=candidates[1].id;
  const remoteSeed={page:structuredClone(source),comments};
  const seedText=new Map([[firstId,'BOLDWORD ITALICWORD LINKWORD. Edit this paragraph directly.'],[secondId,'Second canonical paragraph for independent saves.']]);
  for(const block of remoteSeed.page.content.blocks)if(seedText.has(block.id)){block.markdown=seedText.get(block.id);block.hash=hash(block.markdown)}
  const protectedBlocks=remoteSeed.page.content.blocks.filter(block=>!seedText.has(block.id));
  const externalBlocks=new Map();
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-direct-page-'));
  const control=path.join(folder,'control.json'),remoteState=path.join(folder,'remote.json'),toolLog=path.join(folder,'tools.jsonl');
  const controlState=extra=>fs.writeFile(control,JSON.stringify({splitCanonicalBlocks:true,...extra}));
  await controlState();await fs.writeFile(remoteState,JSON.stringify(remoteSeed));
  const environment={...process.env,TANGENT_DATA_DIR:path.join(folder,'data'),TANGENT_ALLOW_MULTIPLE:'1',TANGENT_E2E:'1',TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'threads.json'),TANGENT_PAGE_FIXTURE_DIR:sourceDirectory,TANGENT_PAGE_FIXTURE_STATE:remoteState,TANGENT_PAGE_FIXTURE_CONTROL:control,TANGENT_PAGE_FIXTURE_LOG:toolLog};
  const proof={fixtureOnly:true,sourceImmutable:true,input:{typing:'Chromium keyboard',selection:'Physical pointer drag',htmlPaste:'Synthetic ClipboardEvent; OS clipboard untouched'},rendererErrors:[]};
  let application,page,boardId,pageNodeId;
  const invoke=(command,params={})=>page.evaluate(({command,params})=>window.tangent.invoke(command,params),{command,params});
  const state=()=>invoke('app/state');
  const board=async()=>{const s=await state();return s.boards.find(board=>board.id===boardId)};
  const pageNode=async()=>(await board()).nodes.find(node=>node.id===pageNodeId);
  const remote=async()=>JSON.parse(await fs.readFile(remoteState,'utf8'));
  const remoteBlock=async id=>(await remote()).page.content.blocks.find(block=>block.id===id);
  const logs=async()=>{try{return(await fs.readFile(toolLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch{return[]}};
  const logicalMarkdown=async id=>{
    const mappings=(await logs()).filter(entry=>entry.event==='edit-applied').flatMap(entry=>entry.mappings||[]).filter(mapping=>mapping.blockId===id&&!mapping.deleted);
    const ids=mappings.at(-1)?.affected.map(block=>block.block_id)||[id],blocks=(await remote()).page.content.blocks;
    return ids.map(id=>blocks.find(block=>block.id===id)?.markdown).filter(markdown=>markdown!==undefined).join('\n\n');
  };
  const mutations=async()=>(await logs()).filter(entry=>entry.tool==='edit_page');
  const shell=()=>page.getByTestId(`page-focus-${pageNodeId}`);
  const block=id=>shell().getByTestId(`page-block-${id}`);
  const editor=()=>shell().getByRole('textbox',{name:'Page document',exact:true});
  const format=()=>page.getByRole('toolbar',{name:'Text formatting',exact:true});
  const screenshot=async name=>{await page.screenshot({path:path.join(root,'screenshots',name)});proof.screenshots??=[];proof.screenshots.push(name)};
  const close=async()=>{if(!application)return;const current=application;application=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  const launch=async()=>{
    application=await electron.launch({args:['.','--background'],cwd:root,env:environment});page=await application.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));
    await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true,account:{type:'chatgpt'}});
    await application.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setContentSize(1440,1000);if(window.isVisible()||window.isFocused())throw Error('Direct Page tests must stay hidden')});
  };
  const open=async()=>{
    const node=await pageNode();await page.locator('.outline-list > button').filter({hasText:node.title}).first().click();await expect(shell()).toBeVisible();
    if(await shell().getAttribute('data-page-mode')!=='full')await page.getByTestId(`page-view-toggle-${pageNodeId}`).click();
    await expect(editor()).toHaveAttribute('contenteditable','true');
  };
  const saved=async(id,predicate=()=>true)=>{
    await expect.poll(async()=>predicate(await logicalMarkdown(id)),{timeout:15000}).toBe(true);
    await expect.poll(async()=>(await pageNode()).pageSaveStatus,{timeout:15000}).toBe('saved');
    await expect(page.getByTestId(`page-save-status-${pageNodeId}`)).toContainText(/Saved to ChatGPT/i);
    return logicalMarkdown(id);
  };
  const clickFormat=async(name,needle='BOLDWORD')=>{await selectPageText(page,block(firstId),needle);await format().getByRole('button',{name,exact:true}).click()};
  const refresh=async()=>{const menu=page.getByTestId(`page-options-menu-${pageNodeId}`);if(!await menu.isVisible())await page.getByTestId(`page-title-menu-${pageNodeId}`).click();await page.getByTestId(`page-refresh-${pageNodeId}`).click();await expect.poll(async()=>(await pageNode()).pageSyncStatus).toBe('ready')};
  const verifyProtected=async()=>{
    const blocks=(await remote()).page.content.blocks,ids=new Set(protectedBlocks.map(block=>block.id)),events=await logs(),created=new Set(events.flatMap(entry=>entry.created||[])),baseline=new Set(remoteSeed.page.content.blocks.map(block=>block.id));
    assert.deepEqual(blocks.filter(block=>ids.has(block.id)),protectedBlocks,'Editing prose must not rewrite unrelated blocks, images, HTML, tables, IDs, hashes or metadata.');
    for(const id of seedText.keys())assert.deepEqual(blocks.find(block=>block.id===id)?.metadata,remoteSeed.page.content.blocks.find(block=>block.id===id).metadata,'The first original block retains its metadata after canonical expansion.');
    for(const block of blocks)assert.ok(baseline.has(block.id)||created.has(block.id)||externalBlocks.has(block.id),'Every new canonical ID must have a proven receipt from our edit or the explicit external fixture mutation.');
    for(const[id,expected]of externalBlocks)assert.deepEqual(blocks.find(block=>block.id===id),expected,'An independently inserted cloud block must remain untouched.');
    for(const entry of events)for(const operation of entry.operations||[])if(operation.op==='delete_block')assert.ok(created.has(operation.blockId),'A continuation save may delete only a canonical ID created by this editor, never another source block.');
    assert.equal(hash(await fs.readFile(path.join(sourceDirectory,'page.json'))),hash(sourceBytes));assert.deepEqual(proof.rendererErrors,[]);
  };
  t.after(async()=>{
    const output=path.resolve(root,'../../work/direct-page-edit-proof');await fs.mkdir(output,{recursive:true});
    if(application)try{proof.finalState=await pageNode();await screenshot('direct-page-edit-last-state.png')}catch{}
    try{proof.tools=await logs();await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2))}catch{}
    await close();await fs.rm(folder,{recursive:true,force:true});
  });
  await fs.mkdir(path.join(root,'screenshots'),{recursive:true});await launch();boardId=(await state()).activeBoardId;
  const linked=await invoke('page/link',{boardId,url:source.metadata.url,title:'Disposable rich editor fixture'});pageNodeId=linked.id;
  await expect.poll(async()=>(await pageNode()).pageSyncStatus,{timeout:20000}).toBe('ready');
  assert.ok((await logs()).some(entry=>entry.tool==='read_page'&&entry.server==='codex_apps'),'A deterministic Page peer handshake is required before edits.');
  await open();proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  const initialMedia=(await pageNode()).pageSnapshot.media;
  const frames=()=>shell().getByTestId('page-visualization-frame');await expect(frames()).toHaveCount(2);
  const frameIdentity=[];
  for(const frameElement of await frames().all()){await frameElement.scrollIntoViewIfNeeded();const element=await frameElement.elementHandle(),frame=await element.contentFrame();await expect.poll(()=>frame.locator('svg').count()).toBeGreaterThan(0);await frame.evaluate(()=>window.__directEditorIdentity='preserved-original-frame');frameIdentity.push({element,frame})}
  const editorIdentity=await editor().elementHandle();
  await typeAtPageEnd(page,block(firstId),' DIRECT_TYPED.');await saved(firstId,markdown=>markdown.endsWith('DIRECT_TYPED.'));
  t.diagnostic('A paragraph accepts real pointer/keyboard input and autosaves through the authenticated Page peer.');
  await clickFormat('Bold');await expect(block(firstId).locator('strong')).toContainText('BOLDWORD');await saved(firstId,markdown=>/(\*\*|__)BOLDWORD\1/.test(markdown));
  await clickFormat('Italic','ITALICWORD');await expect(block(firstId).locator('em')).toContainText('ITALICWORD');await saved(firstId,markdown=>/(?:\*ITALICWORD\*|_ITALICWORD_)/.test(markdown));
  await selectPageText(page,block(firstId),'BOLDWORD');await format().getByRole('combobox',{name:'Text style',exact:true}).selectOption({label:'Heading 2'});await expect(block(firstId).locator('h2')).toContainText('BOLDWORD');await saved(firstId,markdown=>/^##\s/m.test(markdown));
  await placePageCaretAtEnd(page,block(firstId));await block(firstId).evaluate(element=>element.scrollIntoView({block:'start'}));
  await selectPageText(page,block(firstId),'BOLDWORD',{clearCurrentFormatting:false});await expect(format()).toBeVisible();
  const toolbarCollision=await format().evaluate(element=>{const bar=element.getBoundingClientRect(),selection=getSelection().getRangeAt(0).getBoundingClientRect();return{bar:{top:bar.top,bottom:bar.bottom,left:bar.left,right:bar.right},selection:{top:selection.top,bottom:selection.bottom,left:selection.left,right:selection.right},overlap:bar.left<selection.right&&bar.right>selection.left&&bar.top<selection.bottom&&bar.bottom>selection.top}});assert.equal(toolbarCollision.overlap,false,'Formatting controls near the header must not cover the selected text.');proof.toolbarNearHeader=toolbarCollision;
  await format().getByRole('combobox',{name:'Text style',exact:true}).selectOption({label:'Paragraph'});await saved(firstId,markdown=>!/^##\s/m.test(markdown));
  await clickFormat(/^Bulleted ?list$/i);await expect(block(firstId).locator('ul li')).toContainText('BOLDWORD');await saved(firstId,markdown=>/^[-*+]\s/m.test(markdown));
  await clickFormat(/^Numbered ?list$/i);await expect(block(firstId).locator('ol li')).toContainText('BOLDWORD');await saved(firstId,markdown=>/^\d+[.)]\s/m.test(markdown));
  await clickFormat(/^Numbered ?list$/i);await saved(firstId,markdown=>!/^\d+[.)]\s/m.test(markdown));
  await clickFormat('Link','LINKWORD');await page.getByRole('textbox',{name:'Link URL',exact:true}).fill('https://example.com/direct-page-proof');await page.getByRole('button',{name:'Apply link',exact:true}).click();
  await expect(block(firstId).getByRole('link',{name:'LINKWORD',exact:true})).toHaveAttribute('href','https://example.com/direct-page-proof');await saved(firstId,markdown=>markdown.includes('[LINKWORD](https://example.com/direct-page-proof)'));
  const beforeUndo=await logicalMarkdown(firstId);
  await typeAtPageEnd(page,block(firstId),' UNDO_REDO_MARKER.');await saved(firstId,markdown=>markdown.includes('UNDO_REDO_MARKER.'));
  await nativePageShortcut(application,'z');await saved(firstId,markdown=>markdown===beforeUndo);
  await nativePageShortcut(application,'z',['shift']);await saved(firstId,markdown=>markdown.includes('UNDO_REDO_MARKER.'));
  proof.richControls={directTyping:true,bold:true,italic:true,heading:true,bulletedList:true,numberedList:true,link:true,undoRedoAfterSave:true};
  await placePageCaretAtEnd(page,block(firstId));await page.keyboard.press('Enter');await page.keyboard.insertText('ENTER_CREATED_PARAGRAPH');await saved(firstId,markdown=>markdown.includes('ENTER_CREATED_PARAGRAPH'));
  assert.ok((await logs()).some(entry=>entry.event==='edit-applied'&&entry.created?.length),'The peer must expose native canonical paragraph expansion, not conceal it in a single block.');
  const afterCanonicalAck=await logicalMarkdown(firstId);
  await typeAtPageEnd(page,block(firstId),' AFTER_CANONICAL_ACK.');await saved(firstId,markdown=>markdown.includes('AFTER_CANONICAL_ACK.'));
  await nativePageShortcut(application,'z');await saved(firstId,markdown=>markdown===afterCanonicalAck);
  await nativePageShortcut(application,'z',['shift']);await saved(firstId,markdown=>markdown.includes('AFTER_CANONICAL_ACK.'));
  proof.canonicalExpansion={realEnter:true,typeAfterAcknowledgment:true,undoRedoAfterCanonicalAcknowledgment:true};
  await placePageCaretAtEnd(page,block(firstId));await page.keyboard.insertText('\nPLAIN_PASTE_LINE_ONE\nPLAIN_PASTE_LINE_TWO');await saved(firstId,markdown=>markdown.includes('PLAIN_PASTE_LINE_ONE')&&markdown.includes('PLAIN_PASTE_LINE_TWO'));
  await placePageCaretAtEnd(page,block(firstId));
  await editor().evaluate(element=>{const data=new DataTransfer();data.setData('text/plain','RICHWORD Safe link StyledWord');data.setData('text/html','<p><strong>RICHWORD</strong> <a href="https://example.com/paste">Safe link</a> <span style="font-size:100px" data-untrusted="true">StyledWord</span><script>window.__unsafePasteExecuted=true</script></p>');element.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))});
  await expect(block(firstId).locator('strong').filter({hasText:'RICHWORD'})).toBeVisible();await expect(block(firstId).locator('script,style,[data-untrusted]')).toHaveCount(0);assert.equal(await page.evaluate(()=>window.__unsafePasteExecuted),undefined);
  await saved(firstId,markdown=>markdown.includes('RICHWORD')&&markdown.includes('[Safe link](https://example.com/paste)'));
  proof.paste={trustedPlainTextInput:true,syntheticHtmlPasteHandler:true,noGlobalClipboardWrite:true,safeMarksAndLinks:true,unsafeDomRemoved:true};
  await screenshot('direct-page-rich-editing.png');await verifyProtected();
  const updatedTitle=source.content.title+' — direct editor test';await typeAtPageEnd(page,editor().locator('h1.page-document-title'),' — direct editor test');
  await expect.poll(async()=>(await remote()).page.content.title,{timeout:15000}).toBe(updatedTitle);await expect.poll(async()=>(await pageNode()).pageSaveStatus).toBe('saved');proof.guardedTitleAutosave=true;
  await typeAtPageEnd(page,block(secondId),' BEFORE_CLEAN_REFRESH.');await saved(secondId,markdown=>markdown.includes('BEFORE_CLEAN_REFRESH.'));
  const cleanCloud=(await remoteBlock(secondId)).markdown+' CLEAN_REMOTE_BASELINE.';await controlState({externalEdit:{blockId:secondId,markdown:cleanCloud}});await refresh();await expect(block(secondId)).toContainText('CLEAN_REMOTE_BASELINE.');await controlState();
  await typeAtPageEnd(page,block(secondId),' TYPED_AFTER_CLEAN_REFRESH.');await saved(secondId,markdown=>markdown.includes('CLEAN_REMOTE_BASELINE.')&&markdown.includes('TYPED_AFTER_CLEAN_REFRESH.'));proof.cleanExternalSameIdRefresh=true;
  const beforeInsertion=await remote(),firstIndex=beforeInsertion.page.content.blocks.findIndex(block=>block.id===firstId);
  const inserted={id:'fixture-unrelated-cloud-insertion',kind:'markdown',markdown:'UNRELATED_REMOTE_INSERT_KEEP',hash:hash('UNRELATED_REMOTE_INSERT_KEEP'),metadata:{external:true}};
  externalBlocks.set(inserted.id,structuredClone(inserted));beforeInsertion.page.content.blocks.splice(firstIndex+1,0,inserted);beforeInsertion.page.content.markdown=beforeInsertion.page.content.blocks.map(block=>block.markdown).join('\n\n');await fs.writeFile(remoteState,JSON.stringify(beforeInsertion));
  const ownedBefore=(await logs()).filter(entry=>entry.event==='edit-applied').flatMap(entry=>entry.created||[]),ownedIds=new Set(ownedBefore),independentDescendants=beforeInsertion.page.content.blocks.filter(block=>ownedIds.has(block.id));
  await refresh();await expect(block(inserted.id)).toContainText('UNRELATED_REMOTE_INSERT_KEEP');await expect(block(firstId)).not.toContainText('ENTER_CREATED_PARAGRAPH');
  await typeAtPageEnd(page,block(firstId),' AFTER_CANONICAL_REBUILD.');await saved(firstId,markdown=>markdown.endsWith('AFTER_CANONICAL_REBUILD.'));
  const afterInsertion=(await remote()).page.content.blocks;assert.deepEqual(afterInsertion.filter(block=>ownedIds.has(block.id)),independentDescendants,'A fresh canonical first-paragraph session must not duplicate or delete its former trailing paragraphs.');
  assert.equal(afterInsertion.map(block=>block.markdown).join('\n\n').split('ENTER_CREATED_PARAGRAPH').length-1,1);proof.cleanCanonicalRebuild={unrelatedInsertPreserved:true,createdParagraphOccursOnce:true,previousTrailingParagraphsUnchanged:true};await verifyProtected();
  await controlState({editDelayMs:1200});const startCount=(await mutations()).length;
  await typeAtPageEnd(page,block(secondId),' FIRST_IN_FLIGHT.');
  await expect.poll(async()=>(await logs()).filter(entry=>entry.event==='edit-applied').length).toBeGreaterThan(startCount);
  await expect.poll(async()=>(await pageNode()).pageSaveStatus).toBe('saving');
  await typeAtPageEnd(page,block(secondId),' SECOND_WHILE_SAVING.');
  await typeAtPageEnd(page,block(firstId),' CROSS_BLOCK_WHILE_SAVING.');
  await expect(block(secondId)).toContainText('SECOND_WHILE_SAVING.');await saved(secondId,markdown=>markdown.includes('FIRST_IN_FLIGHT.')&&markdown.includes('SECOND_WHILE_SAVING.'));
  await saved(firstId,markdown=>markdown.includes('CROSS_BLOCK_WHILE_SAVING.'));
  await expect(block(secondId)).toContainText('SECOND_WHILE_SAVING.');const delayedWrites=(await mutations()).slice(startCount),replacements=delayedWrites.flatMap(write=>write.operations).filter(operation=>operation.op==='replace_block_markdown');assert.equal(replacements.length,3,'Two revisions and an independent block need three guarded replacements, never a replay or lost typeahead.');
  proof.delayedAcknowledgment={newTypingPreserved:true,independentCanonicalDrafts:true,guardedReplacements:3,requests:delayedWrites.length};await controlState();
  await controlState({offline:true});
  await application.evaluate(({ipcMain},{nodeId,blockId})=>{
    const channel='tangent:invoke',original=ipcMain._invokeHandlers.get(channel);if(typeof original!=='function')throw Error('The real IPC handler must exist before fault injection.');
    const fault={held:null,reject:null};globalThis.__directDraftFailure=fault;ipcMain.removeHandler(channel);
    ipcMain.handle(channel,(event,command,payload)=>{if(command==='page/draft'&&payload.nodeId===nodeId&&payload.blockId===blockId&&!fault.held){fault.held=structuredClone(payload);return new Promise((_resolve,reject)=>{fault.reject=reject})}return original(event,command,payload)});
  },{nodeId:pageNodeId,blockId:secondId});
  await typeAtPageEnd(page,block(secondId),' LOCAL_FIRST_HELD.');await expect.poll(()=>application.evaluate(()=>Boolean(globalThis.__directDraftFailure.held))).toBe(true);
  await typeAtPageEnd(page,block(secondId),' NEWER_LOCAL_QUEUED. OFFLINE_REOPEN_DRAFT.');await expect(block(secondId)).toContainText('NEWER_LOCAL_QUEUED.');
  const rejectedRevision=await application.evaluate(()=>{const fault=globalThis.__directDraftFailure;fault.reject(Error('Simulated local draft IPC failure.'));fault.reject=null;return fault.held.clientRevision});
  await expect(page.getByTestId(`page-save-status-${pageNodeId}`)).toContainText('Could not save on this Mac');await expect(block(secondId)).toContainText('NEWER_LOCAL_QUEUED.');assert.ok(!(await remoteBlock(secondId)).markdown.includes('LOCAL_FIRST_HELD.'));
  await page.getByRole('button',{name:/^Retry ?save$/i}).click();
  await expect.poll(async()=>(await pageNode()).pageSaveStatus,{timeout:15000}).toBe('offline');await expect.poll(async()=>(await state()).persistence.saving).toBe(false);
  const offlineDraft=(await pageNode()).pageDrafts[secondId];assert.match(offlineDraft.markdown,/OFFLINE_REOPEN_DRAFT/);assert.ok(offlineDraft.baseHash);assert.ok(offlineDraft.editorJSON);
  assert.match(offlineDraft.markdown,/LOCAL_FIRST_HELD.*NEWER_LOCAL_QUEUED/);assert.ok(offlineDraft.clientRevision>rejectedRevision);assert.match(JSON.stringify(offlineDraft.editorJSON),/NEWER_LOCAL_QUEUED/);proof.localPersistenceFailure={heldOldRevision:rejectedRevision,newerRevisionPersisted:offlineDraft.clientRevision,latestRichJSONDurable:true};
  assert.ok(!(await remoteBlock(secondId)).markdown.includes('OFFLINE_REOPEN_DRAFT.'));
  assert.equal(await editorIdentity.evaluate(element=>element.isConnected),true);
  for(const{element,frame}of frameIdentity){assert.equal(await element.evaluate(element=>element.isConnected),true);assert.equal(await frame.evaluate(()=>window.__directEditorIdentity),'preserved-original-frame')}
  await close();await launch();await open();await expect(block(secondId)).toContainText('OFFLINE_REOPEN_DRAFT.');await expect.poll(async()=>(await pageNode()).pageSaveStatus).toBe('offline');
  await screenshot('direct-page-offline-reopened.png');await controlState();await page.getByRole('button',{name:/^Retry ?save$/i}).click();await saved(secondId,markdown=>markdown.includes('OFFLINE_REOPEN_DRAFT.'));
  proof.offlineRestart={localDraftAndBaseHashDurable:true,editorJSONRestored:true,explicitRetrySaved:true};
  let cloud=(await remoteBlock(secondId)).markdown.replace('Second','REMOTE_CONFLICT');await selectPageText(page,block(secondId),'Second');await page.keyboard.insertText('LOCAL_CONFLICT');await controlState({externalEdit:{blockId:secondId,markdown:cloud}});
  await expect(page.getByTestId('page-edit-conflict')).toBeVisible();await expect(block(secondId)).toContainText('LOCAL_CONFLICT');assert.match((await pageNode()).pageDrafts[secondId].remoteMarkdown,/REMOTE_CONFLICT/);assert.equal((await remoteBlock(secondId)).markdown,cloud);
  await controlState();await page.getByRole('button',{name:/^Use ?latest ?Page$/i}).click();await expect(block(secondId)).toContainText('REMOTE_CONFLICT');await expect(block(secondId)).not.toContainText('LOCAL_CONFLICT');
  cloud=(await remoteBlock(secondId)).markdown.replace('REMOTE_CONFLICT','REMOTE_LATEST');await selectPageText(page,block(secondId),'REMOTE_CONFLICT');await page.keyboard.insertText('LOCAL_FINAL');await controlState({externalEdit:{blockId:secondId,markdown:cloud}});
  await expect(page.getByTestId('page-edit-conflict')).toBeVisible();await controlState();await page.getByRole('button',{name:/^Keep ?my ?changes$/i}).click();await saved(secondId,markdown=>markdown.includes('LOCAL_FINAL')&&!markdown.includes('REMOTE_LATEST'));
  proof.conflict={sameRangeNeverBlindlyReplaced:true,localAndCloudVersionsRetained:true,useLatest:true,explicitKeepLocalFreshGuard:true};
  await controlState({omitEditReceipt:true});const beforeUncertain=(await mutations()).length;await typeAtPageEnd(page,block(secondId),' UNCERTAIN_RECEIPT.');
  await expect.poll(async()=>(await pageNode()).pageSaveStatus,{timeout:15000}).toBe('uncertain');await expect(block(secondId)).toContainText('UNCERTAIN_RECEIPT.');assert.ok((await remoteBlock(secondId)).markdown.includes('UNCERTAIN_RECEIPT.'));
  await page.waitForTimeout(1400);assert.equal((await mutations()).length,beforeUncertain+1,'An uncertain acknowledgment must never automatically replay the remote mutation.');
  await controlState();await page.getByRole('button',{name:/^Retry ?save$/i}).click();await saved(secondId,markdown=>markdown.includes('UNCERTAIN_RECEIPT.'));assert.equal((await mutations()).length,beforeUncertain+1,'Fresh readback can reconcile a committed uncertain save without another write.');
  proof.uncertainReceipt={localPreserved:true,noReplay:true,readbackReconciled:true};
  await nativePageShortcut(application,'-');await nativePageShortcut(application,'-');await nativePageShortcut(application,'-');await expect(shell()).toHaveAttribute('data-page-zoom','75');
  const quoteBlock=(await remote()).page.content.blocks.find(block=>block.markdown.includes('ENTER_CREATED_PARAGRAPH'));assert.ok(quoteBlock);
  const selected=await selectPageText(page,block(quoteBlock.id),'ENTER_CREATED_PARAGRAPH');await expect(format()).toBeVisible();await expect(shell().locator('.page-discussion-panel')).toBeHidden();
  await format().getByRole('button',{name:/^Ask ?Codex$/i}).click();await expect(page.getByTestId('comment-question')).toBeVisible();await expect(page.getByTestId('selection-toolbar').locator('blockquote')).toHaveText(selected);
  await page.getByTestId('comment-question').fill('Reply exactly: DIRECT_EDITOR_QUOTE75.');await expect(shell().locator('.page-quoted-highlight')).toHaveText(selected);await page.getByTestId('submit-comment').click();
  await expect.poll(async()=>(await board()).nodes.some(node=>node.messages?.some(message=>message.role==='assistant'&&message.text==='DIRECT_EDITOR_QUOTE75.'))).toBe(true);
  const message=(await board()).nodes.flatMap(node=>node.messages||[]).find(message=>message.text==='Reply exactly: DIRECT_EDITOR_QUOTE75.');assert.equal(message.quote,selected);assert.equal(message.blockId,quoteBlock.id);assert.equal(message.pageTargetId,pageNodeId);
  await expect(shell().locator('.page-quoted-highlight')).toHaveText(selected);
  const restoredEditor=await editor().elementHandle();await page.getByTestId(`page-view-toggle-${pageNodeId}`).click();await page.getByTestId(`page-view-toggle-${pageNodeId}`).click();assert.equal(await restoredEditor.evaluate(element=>element.isConnected),true);
  assert.deepEqual((await pageNode()).pageSnapshot.media,initialMedia);await verifyProtected();
  proof.quoteAt75={exactSelectedText:selected,canonicalBlockId:quoteBlock.id,receiptCreatedParagraph:true,explicitAskCodex:true};
  // Relaunch intentionally creates new frame objects; this checks their live
  // identity across another edit, independently of persisted source equality.
  const restoredFrames=[];for(const frameElement of await frames().all()){const element=await frameElement.elementHandle(),frame=await element.contentFrame();await frame.evaluate(()=>window.__directEditorIdentity='post-restart-frame');restoredFrames.push({element,frame})}
  await typeAtPageEnd(page,block(secondId),' MEDIA_CONTINUITY.');await saved(secondId,markdown=>markdown.endsWith('MEDIA_CONTINUITY.'));
  for(const{element,frame}of restoredFrames){assert.equal(await element.evaluate(element=>element.isConnected),true);assert.equal(await frame.evaluate(()=>window.__directEditorIdentity),'post-restart-frame')}
  await verifyProtected();await screenshot('direct-page-editor-75-percent.png');
  proof.media={protectedCanonicalBlocks:protectedBlocks.length,images:initialMedia.filter(media=>media.kind==='image').length,html:restoredFrames.length,iframeIdentityPreserved:true,sourceAssetsUnchanged:true};
  t.diagnostic('Direct editing, formatting, paste handling, autosave/durability/conflicts and exact75% quote routing passed without altering the source Page or user profile.');
});
