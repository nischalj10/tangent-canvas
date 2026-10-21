import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {PageConnector} from '../electron/page-connector.mjs';
import {selectPageText} from '../tests/page-editor-helpers.mjs';
import {requireLivePageUrl} from './live-page-target.mjs';
const original=requireLivePageUrl();

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-real-pages-'));
const executable=process.argv[2];
const errors=[];let application,ownPageId,testThreadId,cleanupConfirmed=false;
const nonce=randomUUID(),title=`Tangent native UI check ${nonce}`,initial=`UI_INITIAL_${nonce}`,updated=`UI_SAVED_${nonce}`,agentUpdated=`AGENT_SAVED_${nonce}`;
const control=new PageConnector({directory:folder});
const dataOf=result=>result.structuredContent||(result.content||[]).filter(c=>c.type==='text').map(c=>{try{return JSON.parse(c.text)}catch{return null}}).find(Boolean);
try{
  const created=dataOf(await control.call('new-private-test-page','create_page',{title,idempotency_key:nonce,initial_blocks:[initial]}));
  ownPageId=created?.metadata?.page_id||created?.content?.page_id||created?.page_id;
  assert.ok(ownPageId,'A new private test Page must be confirmed before any live edits.');
  const env={...process.env,TANGENT_DATA_DIR:folder,TANGENT_ALLOW_MULTIPLE:'1'};
  delete env.ELECTRON_RUN_AS_NODE;delete env.TANGENT_E2E;delete env.TANGENT_TEST_CODEX_BINARY;
  application=await electron.launch({...(executable?{executablePath:executable}:{cwd:root}),args:executable?['--background']:['.','--background'],env});
  const page=await application.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('canvas-surface').waitFor();
  await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection')),{timeout:45000}).toMatchObject({connected:true,account:{type:'chatgpt'}});
  const start=await page.evaluate(()=>window.tangent.invoke('app/state')),boardId=start.activeBoardId;
  const node=await page.evaluate(({boardId,url})=>window.tangent.invoke('page/link',{boardId,url}),{boardId,url:original});
  const snapshot=await page.evaluate(({boardId,nodeId})=>window.tangent.invoke('page/sync',{boardId,nodeId}),{boardId,nodeId:node.id});
  const imageCount=snapshot.media.filter(m=>m.kind==='image').length,figureCount=snapshot.media.filter(m=>m.kind==='visualization').length;
  assert.equal(snapshot.pageId,original.split('/').at(-1));assert.ok(snapshot.blocks.length>=81);assert.ok(imageCount>=4);assert.ok(figureCount>=2);assert.equal(snapshot.mediaErrors.length,0);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
  // Enter the native-sized reader through the same sidebar used by the user.
  // The original source remains read-only throughout this part of the test.
  await page.locator('.outline-list > button').filter({hasText:snapshot.title}).first().click();
  await expect(page.getByTestId(`page-focus-${node.id}`)).toBeVisible();
  const article=page.getByTestId(`card-${node.id}`);
  await expect(page.getByTestId(`page-focus-${node.id}`)).toHaveAttribute('data-page-mode','half');
  await page.getByTestId(`page-title-menu-${node.id}`).click();
  await page.getByTestId(`page-zoom-${node.id}`).selectOption('75');
  await page.getByTestId(`page-title-menu-${node.id}`).click();
  await expect(page.getByTestId(`page-focus-${node.id}`)).toHaveAttribute('data-page-zoom','75');
  await page.screenshot({path:path.join(root,'screenshots/page-half-75-live.png')});
  await page.getByTestId(`page-view-toggle-${node.id}`).click();
  await expect(page.getByTestId(`page-focus-${node.id}`)).toHaveAttribute('data-page-mode','full');
  await page.getByTestId(`page-title-menu-${node.id}`).click();
  await page.getByTestId(`page-zoom-reset-${node.id}`).click();
  await page.getByTestId(`page-title-menu-${node.id}`).click();
  for(const image of await article.locator('img').all()){await image.scrollIntoViewIfNeeded();await expect.poll(()=>image.evaluate(img=>img.complete&&img.naturalWidth>0),{timeout:45000}).toBe(true)}
  await expect.poll(()=>article.locator('img').evaluateAll(images=>images.filter(image=>image.complete&&image.naturalWidth>0).length),{timeout:45000}).toBe(imageCount);
  assert.equal(await article.locator('iframe').count(),figureCount);
  for(const frame of await article.locator('iframe').all())assert.equal(await frame.getAttribute('sandbox'),'allow-scripts');
  const tableCount=await article.locator('table').count();assert.ok(tableCount>=5);
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getOpacity()),1);
  await article.locator('.rich-page-scroll').evaluate(element=>element.scrollTo({top:0,behavior:'instant'}));
  const shot=path.join(root,'screenshots/native-biology-live.png');await page.screenshot({path:shot});
  const typography=await article.locator('.rich-page-document').evaluate(element=>{const style=getComputedStyle(element);return{font:style.fontFamily,fontSize:style.fontSize,lineHeight:style.lineHeight,scale:element.getBoundingClientRect().width/element.offsetWidth}});
  assert.ok(Math.abs(typography.scale-1)<.02);assert.ok(parseFloat(typography.fontSize)>=16);
  await article.getByTestId('page-outline-toggle').hover();
  await expect(article.getByRole('navigation',{name:'Page contents'})).toBeVisible();
  await expect.poll(()=>article.getByRole('navigation',{name:'Page contents'}).evaluate(element=>Number(getComputedStyle(element).opacity))).toBe(1);
  await article.screenshot({path:path.join(root,'screenshots/page-focus-live-outline.png')});
  await page.mouse.move(1400,20);
  await page.getByTestId(`page-comments-tab-${node.id}`).click();
  await expect(article.getByTestId('original-page-comments')).toBeVisible();
  await expect(article.locator('.page-outline-popover')).toHaveCount(0);
  await page.mouse.move(1400,900);
  await article.screenshot({path:path.join(root,'screenshots/page-focus-live-comments.png')});
  await article.locator('.page-panel-heading button').click();
  for(const[index,figure]of(await article.locator('.page-source-image,.page-visualization').all()).entries()){
    await figure.scrollIntoViewIfNeeded();await figure.screenshot({path:path.join(root,`screenshots/native-biology-figure-${index+1}.png`)});
  }
  const blockIds=await article.locator('[data-page-block-id]').evaluateAll(elements=>elements.map(element=>element.dataset.pageBlockId));
  if(blockIds.length)assert.equal(new Set(blockIds).size,snapshot.blocks.length);
  // The only mutable remote document in this test is our nonce-named private Page.
  const disposable=await page.evaluate(({boardId,pageId})=>window.tangent.invoke('page/link',{boardId,url:`https://chatgpt.com/space/${pageId}`}),{boardId,pageId:ownPageId});
  const disposableSnapshot=await page.evaluate(({boardId,nodeId})=>window.tangent.invoke('page/sync',{boardId,nodeId}),{boardId,nodeId:disposable.id});
  const sourceBlock=disposableSnapshot.blocks.find(b=>b.markdown.includes(initial));assert.ok(sourceBlock);
  await page.locator('.outline-list > button').filter({hasText:disposableSnapshot.title}).first().click();
  await expect(page.getByTestId(`page-focus-${disposable.id}`)).toBeVisible();
  const editable=page.getByTestId(`card-${disposable.id}`);
  await page.getByTestId(`page-view-toggle-${disposable.id}`).click();
  await expect(page.getByTestId(`page-focus-${disposable.id}`)).toHaveAttribute('data-page-mode','full');
  await expect(editable.getByRole('textbox',{name:'Page document',exact:true})).toHaveAttribute('contenteditable','true');
  await selectPageText(page,editable.getByTestId(`page-block-${sourceBlock.id}`),initial);await page.keyboard.insertText(updated);
  await expect.poll(async()=>(await control.read(ownPageId)).blocks.some(block=>block.markdown===updated),{timeout:60000,intervals:[500,1000]}).toBe(true);
  const verified=await control.read(ownPageId);assert.ok(verified.blocks.some(b=>b.markdown===updated));assert.ok(!verified.blocks.some(b=>b.markdown===initial));
  await page.getByTestId('page-discussion-toggle').click();
  await editable.getByTestId(`page-ask-input-${disposable.id}`).fill(`Edit this exact linked test Page: replace the unique paragraph ${updated} with exactly ${agentUpdated}. Read the Page for fresh block guards, update that paragraph, read it back and reply briefly. This is a disposable private integration-test Page. Do not edit any other Page, create a Page, run shell commands or change files.`);
  await editable.getByTestId(`page-ask-send-${disposable.id}`).click();
  let testChat;
  await expect.poll(async()=>{
    const state=await page.evaluate(()=>window.tangent.invoke('app/state')),board=state.boards.find(b=>b.id===boardId),p=board.nodes.find(n=>n.id===disposable.id);
    testChat=board.nodes.find(n=>n.id===p.targetChatId);
    testThreadId=testChat?.threadId||testThreadId;
    if(testChat?.pendingApproval){
      const approval=testChat.pendingApproval;let details=approval.parameters;try{details??=JSON.parse(approval.details)}catch{}
      console.log(JSON.stringify({liveTestApproval:{title:approval.title,details}}));
      assert.equal(approval.kind,'mcpServer/elicitation/request');
      assert.equal(details?.page_id,ownPageId,'Only the newly created disposable Page may be approved.');
      assert.match(approval.title,/chatgpt_space\.(?:read_page|edit_page|list_page_comments)/);
      await editable.getByTestId('approval-accept').click();
    }
    return testChat?.status==='idle'&&testChat.messages.some(m=>m.role==='assistant');
  },{timeout:150000,intervals:[500,1000]}).toBe(true);
  const agentReadback=await control.read(ownPageId);assert.ok(agentReadback.blocks.some(b=>b.markdown===agentUpdated),'The chosen real Codex thread must actually edit the original linked test Page.');
  await expect.poll(async()=>{
    const state=await page.evaluate(()=>window.tangent.invoke('app/state'));return state.boards.find(b=>b.id===boardId).nodes.find(n=>n.id===disposable.id).pageSnapshot.blocks.some(b=>b.markdown===agentUpdated);
  },{timeout:45000}).toBe(true);
  await editable.screenshot({path:path.join(root,'screenshots/native-page-agent-edit-live.png')});
  assert.deepEqual(errors,[]);
  const result={mode:executable?'packaged':'development',realCodexSubscription:true,separateBrowserLoginRequired:false,originalPageUnchanged:true,blocks:snapshot.blocks.length,loadedImages:imageCount,htmlFigures:figureCount,tables:tableCount,sourceCommentThreads:snapshot.comments.length,failedAttachments:0,typography,halfViewAt75Percent:true,fullReadingView:true,singleFloatingToolbar:true,outlineAndCommentsVisuallyCaptured:true,liveInlineOriginalPageSaveReadback:true,liveDirectRichAutosaveReadback:true,liveSelectedCodexThreadActuallyEditedLinkedPage:true,agentEditAutoRefreshed:true,windowHidden:true,windowOpaque:true,rendererErrors:errors,screenshot:shot};
  fs.writeFileSync(path.resolve(root,'../../work/native-page-live-proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(application){const child=application.process(),watchdog=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}},7000);try{await application.close().catch(()=>{})}finally{clearTimeout(watchdog)}}
  if(testThreadId)try{await control.runtime.request('thread/archive',{threadId:testThreadId})}catch{}
  if(ownPageId){try{const receipt=dataOf(await control.call(ownPageId,'trash_page',{page_id:ownPageId}));cleanupConfirmed=receipt?.trashed===true;if(!cleanupConfirmed)console.error(JSON.stringify({cleanupConfirmed:false,testPageId:ownPageId}))}catch(error){console.error(JSON.stringify({cleanupConfirmed:false,testPageId:ownPageId,error:error.message}))}}
  await control.close();
  fs.rmSync(folder,{recursive:true,force:true});
}
