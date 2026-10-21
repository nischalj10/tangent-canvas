import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {selectPageText} from './page-editor-helpers.mjs';

const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(root,'../../work/fullscreen-selection-e2e');
const sourceDirectory=path.resolve(root,'../../work/native-page-source');
const quote='super-resolved fluorescence microscopy';
const answer=`The selected research marker is MARBLE-41. PALM uses ${quote} to locate individual labels. A side question should preserve this completed reply.`;
const laterAnswer='A later completed reply. '+Array(46).fill('This deliberately long later answer makes the source conversation scroll so a nested full-screen return must restore the earlier reading location.').join(' ');

for(const overPage of [false,true])test(`Trusted assistant selection opens a usable isolated side chat over full-screen conversation ${overPage?'over a Page':'over canvas'}`,{timeout:65000},async t=>{
  const name=overPage?'page':'canvas',folder=await fs.mkdtemp(path.join(os.tmpdir(),`tangent-fullscreen-selection-${name}-`));
  const proof={scenario:name,isolatedFixture:true,hidden:true,foregroundInteraction:false,screenshots:[],rendererErrors:[]};
  let app,page,boardId,pageId,pageMainId;
  const invoke=(command,params={})=>page.evaluate(({command,params})=>window.tangent.invoke(command,params),{command,params});
  const board=async()=>{const state=await invoke('app/state');return state.boards.find(board=>board.id===boardId)};
  const node=async id=>(await board()).nodes.find(node=>node.id===id);
  const screenshot=async stage=>{
    const dismiss=page.getByTitle('Dismiss notification');if(await dismiss.isVisible()&&!await page.locator('.selection-popover').count())await dismiss.click();
    const saved=page.locator('.saved-label:visible').first();if(await saved.count())await expect(saved).toContainText('On this Mac');
    // Observe settled ordinary motion instead of capturing the first faded-in
    // frame or forcibly completing animations, which would hide UI regressions.
    await page.evaluate(async()=>{
      await new Promise(resolve=>requestAnimationFrame(resolve));
      const pending=document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity);
      await Promise.all(pending.map(animation=>animation.finished.catch(()=>{})));
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    });
    const file=path.join(output,`${name}-${stage}.png`);await page.screenshot({path:file});proof.screenshots.push(file);
  };
  t.after(async()=>{
    await fs.mkdir(output,{recursive:true});
    if(page)try{await screenshot('last-state')}catch{}
    await fs.writeFile(path.join(output,`${name}-proof.json`),JSON.stringify(proof,null,2)+'\n');
    if(app){const current=app;app=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}}
    await fs.rm(folder,{recursive:true,force:true});
  });
  await fs.mkdir(output,{recursive:true});
  app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:path.join(folder,'data'),TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'threads.json'),TANGENT_FIXTURE_RPC_LOG:path.join(folder,'rpc.jsonl'),TANGENT_PAGE_FIXTURE_DIR:sourceDirectory,TANGENT_PAGE_FIXTURE_STATE:path.join(folder,'page.json'),TANGENT_PAGE_FIXTURE_LOG:path.join(folder,'page-tools.jsonl')}});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));
  await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1440,1000);assertHidden(w);function assertHidden(w){if(w.isVisible()||w.isFocused())throw Error('The test app must remain hidden')}});
  boardId=(await invoke('app/state')).activeBoardId;
  proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  let main;
  if(overPage){
    const source=JSON.parse(await fs.readFile(path.join(sourceDirectory,'page.json'),'utf8'));
    const linked=await invoke('page/link',{boardId,url:source.metadata.url,title:'Full-screen selection Page fixture'});pageId=linked.id;
    await expect.poll(async()=>(await node(pageId)).pageSyncStatus,{timeout:20000}).toBe('ready');
    await page.locator('.outline-list > button').filter({hasText:(await node(pageId)).title}).first().click();
    await expect(page.getByTestId(`page-focus-${pageId}`)).toBeVisible();
    await page.getByTestId('page-discussion-toggle').click();
    await page.getByTestId(`page-ask-input-${pageId}`).fill(`Reply exactly: ${answer}`);await page.getByTestId(`page-ask-input-${pageId}`).press('Enter');
    await expect.poll(async()=>{main=await node((await node(pageId)).targetChatId);return main?.status}).toBe('idle');
    // A Page-origin floating conversation already supports full screen. Enter
    // through that real workflow so its Page/draft/frame must survive return.
    pageMainId=main.id;
    const pageAnswer=main.messages.filter(message=>message.role==='assistant').at(-1);
    const thread=page.getByTestId(`page-thread-${pageId}`);await thread.getByTestId(`message-${pageAnswer.id}`).hover();await thread.getByTestId(`comment-${pageAnswer.id}`).click();
    const form=page.getByTestId('selection-toolbar');await form.getByTestId('comment-question').fill(`Reply exactly: ${answer}`);await form.getByTestId('submit-comment').click();
    await expect.poll(async()=>{main=(await board()).nodes.find(node=>node.parentId===pageMainId&&node.kind==='comment');return main?.status}).toBe('idle');
    const pageFloating=page.getByTestId(`floating-side-chat-${main.id}`);await expect(pageFloating).toBeVisible();
    await pageFloating.getByTestId(`floating-chat-fullscreen-${main.id}`).click();
  }else{
    await page.getByTestId('new-chat').click();await expect.poll(async()=>{main=(await board()).nodes.find(node=>node.kind==='chat');return Boolean(main)}).toBe(true);
    await page.getByTestId(`composer-${main.id}`).fill(`Reply exactly: ${answer}`);await page.getByTestId(`send-${main.id}`).click();await expect.poll(async()=>(await node(main.id)).status).toBe('idle');
    await page.getByTestId('hide-sidebar').click();await expect(page.getByTestId('show-sidebar')).toBeVisible();
    await page.getByTestId(`chat-focus-open-${main.id}`).click();
  }
  const full=page.getByTestId(`chat-fullscreen-${main.id}`);await expect(full).toBeVisible();
  main=await node(main.id);const first=main.messages.filter(message=>message.role==='assistant'&&message.text===answer).at(-1);assert.ok(first?.turnId);
  await full.getByTestId(`composer-${main.id}`).fill(`Remember later marker ORBIT-92. Reply exactly: ${laterAnswer}`);await full.getByTestId(`send-${main.id}`).click();await expect.poll(async()=>(await node(main.id)).status).toBe('idle');
  await full.getByTestId(`composer-${main.id}`).fill('Preserve this full-screen source draft.');
  const original=structuredClone(await node(main.id));
  await selectPageText(page,full.getByTestId(`message-${first.id}`).locator('.message-text'),quote,{clearCurrentFormatting:false});
  const toolbar=page.getByTestId('selection-toolbar');await expect(toolbar).toBeVisible();
  const action=toolbar.getByTestId('selection-comment');
  proof.selectionHit=await action.evaluate(element=>{const rect=element.getBoundingClientRect(),top=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return{selection:getSelection()?.toString(),toolbarZ:getComputedStyle(element.closest('.selection-popover')).zIndex,sourceZ:getComputedStyle(document.querySelector('.chat-fullscreen')).zIndex,topClass:top?.className,topTestId:top?.closest('[data-testid]')?.dataset.testid,hit:element===top||element.contains(top)}});
  await screenshot('selected-toolbar');
  assert.equal(proof.selectionHit.hit,true,'The full-screen selection action must be above the source conversation and receive the actual click.');
  await action.click();
  await expect(toolbar.getByTestId('comment-question')).toBeFocused();await expect(toolbar.locator('blockquote')).toHaveText(quote);
  await screenshot('expanded-side-question');
  await toolbar.getByTestId('comment-question').press('Escape');await expect(toolbar).toHaveCount(0);await expect(full).toBeVisible();
  await expect(full.getByTestId(`composer-${main.id}`)).toHaveValue('Preserve this full-screen source draft.');proof.escapeDismissesOnlySideQuestion=true;
  await selectPageText(page,full.getByTestId(`message-${first.id}`).locator('.message-text'),quote,{clearCurrentFormatting:false});await action.click();await expect(toolbar.getByTestId('comment-question')).toBeFocused();
  await toolbar.getByTestId('comment-question').fill('TEST_CONTEXT');await toolbar.getByTestId('submit-comment').click();
  let child;await expect.poll(async()=>{child=(await board()).nodes.find(node=>node.parentId===main.id&&node.kind==='comment');return child?.status}).toBe('idle');
  const floating=page.getByTestId(`floating-side-chat-${child.id}`);await expect(floating).toBeVisible();await expect(full).toBeVisible();
  assert.equal(child.sourceTurnId,first.turnId);assert.equal(child.quote,quote);assert.notEqual(child.threadId,main.threadId);assert.equal(child.messages.at(-1).text,'Visible markers: MARBLE-41');
  assert.deepEqual((await node(main.id)).messages,original.messages,'The side fork must not append to or rewrite its source chat.');
  await expect(full.getByTestId(`composer-${main.id}`)).toHaveValue('Preserve this full-screen source draft.');
  proof.child={separateThread:true,correctSelectedTurn:true,laterTurnExcluded:true,quoteRetained:true,canvasSaved:true};
  await screenshot('floating-child');
  const childAnswer=child.messages.filter(message=>message.role==='assistant').at(-1);
  await selectPageText(page,floating.getByTestId(`message-${childAnswer.id}`).locator('.message-text'),'MARBLE-41',{clearCurrentFormatting:false});
  await expect(toolbar).toBeVisible();await toolbar.getByTestId('selection-comment').click();await toolbar.getByTestId('comment-question').fill('Reply exactly: A nested floating side answer.');await toolbar.getByTestId('submit-comment').click();
  let nested;await expect.poll(async()=>{nested=(await board()).nodes.find(node=>node.parentId===child.id&&node.kind==='comment');return nested?.status}).toBe('idle');
  const nestedFloating=page.getByTestId(`floating-side-chat-${nested.id}`);await expect(nestedFloating).toBeVisible();await expect(floating).toBeVisible();await expect(full).toBeVisible();assert.equal(nested.sourceTurnId,childAnswer.turnId);assert.equal(nested.quote,'MARBLE-41');
  await nestedFloating.getByTestId(`floating-chat-close-${nested.id}`).click();await expect(nestedFloating).toHaveCount(0);await expect(full).toBeVisible();await expect(floating).toBeVisible();proof.nestedFloatingSelection=true;
  await floating.getByTestId(`composer-${child.id}`).fill('Preserve the floating child draft.');
  const collapse=floating.getByTestId(`floating-chat-collapse-${child.id}`);
  await expect(collapse).toHaveAttribute('aria-expanded','true');await expect(collapse).toHaveAttribute('aria-label','Minimize side conversation');
  await expect(collapse.locator('svg.lucide-chevron-up')).toHaveCount(1);await expect(collapse.locator('svg.lucide-chevron-down')).toHaveCount(0);
  await collapse.click();await expect(floating).toHaveClass(/is-minimized/);await expect(full).toBeVisible();
  await expect(collapse).toHaveAttribute('aria-expanded','false');await expect(collapse).toHaveAttribute('aria-label','Expand side conversation');
  await expect(collapse.locator('svg.lucide-chevron-down')).toHaveCount(1);await expect(collapse.locator('svg.lucide-chevron-up')).toHaveCount(0);
  await expect(floating.locator('.floating-chat-content')).toBeHidden();await screenshot('floating-child-collapsed-down');
  await collapse.click();await expect(floating).not.toHaveClass(/is-minimized/);await expect(collapse).toHaveAttribute('aria-expanded','true');
  await expect(collapse.locator('svg.lucide-chevron-up')).toHaveCount(1);await expect(collapse.locator('svg.lucide-chevron-down')).toHaveCount(0);
  await expect(floating.locator('.floating-chat-content')).toBeVisible();await expect(floating.getByTestId(`composer-${child.id}`)).toHaveValue('Preserve the floating child draft.');
  await expect(full).toBeVisible();await screenshot('floating-child-expanded-up');proof.collapseControl={expandedChevron:'up',collapsedChevron:'down',ariaExpandedTracksContent:true,draftPreserved:true};
  const sourceScroll=()=>full.locator('.chat-focus-column > .canvas-card .chat-scroll');
  const readingLocation=await sourceScroll().evaluate(element=>({top:element.scrollTop,max:element.scrollHeight-element.clientHeight}));
  assert.ok(readingLocation.max>300,'The source conversation must really overflow to exercise reading-position retention.');assert.ok(readingLocation.top<readingLocation.max-200,'The source must be read above its newest reply.');
  await floating.getByTestId(`floating-chat-fullscreen-${child.id}`).click();const childFull=page.getByTestId(`chat-fullscreen-${child.id}`);await expect(childFull).toBeVisible();
  await page.getByTestId('chat-focus-back').click();await expect(full).toBeVisible();await expect(floating).toBeVisible();await expect(floating.getByTestId(`composer-${child.id}`)).toHaveValue('Preserve the floating child draft.');
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
  const restoredLocation=await sourceScroll().evaluate(element=>({top:element.scrollTop,max:element.scrollHeight-element.clientHeight}));proof.readingPosition={before:readingLocation,after:restoredLocation};
  assert.ok(Math.abs(restoredLocation.top-readingLocation.top)<=2,'Returning from a nested full-screen side chat must retain the source reading position.');
  await floating.getByTestId(`floating-chat-close-${child.id}`).click();await expect(floating).toHaveCount(0);await expect(full).toBeVisible();assert.equal(!!(await node(child.id)).archived,false);
  proof.sourcePreservedAfterCollapseCloseAndNestedFullscreen=true;
  await page.getByTestId('chat-focus-back').click();await expect(full).toHaveCount(0);
  if(overPage){await expect(page.getByTestId(`page-focus-${pageId}`)).toBeVisible();await expect(page.getByTestId(`floating-side-chat-${main.id}`)).toBeVisible();assert.equal((await node(pageId)).targetChatId,pageMainId)}
  // Show on canvas is the explicit navigation path; an ordinary side-question
  // send above must never take this route or dismiss the reading surface.
  await page.getByTestId(overPage?`floating-chat-fullscreen-${main.id}`:`chat-focus-open-${main.id}`).click();await expect(full).toBeVisible();
  await selectPageText(page,full.getByTestId(`message-${first.id}`).locator('.message-text'),quote,{clearCurrentFormatting:false});
  await toolbar.getByTestId('selection-comment').click();await toolbar.getByTestId('comment-question').fill('Reply exactly: Canvas routing child.');await toolbar.getByTestId('submit-comment').click();
  let canvasChild;await expect.poll(async()=>{canvasChild=(await board()).nodes.find(node=>node.parentId===main.id&&node.messages?.some(message=>message.role==='user'&&message.text==='Reply exactly: Canvas routing child.'));return canvasChild?.status}).toBe('idle');
  const canvasFloating=page.getByTestId(`floating-side-chat-${canvasChild.id}`);await expect(canvasFloating).toBeVisible();await canvasFloating.getByTestId(`floating-chat-canvas-${canvasChild.id}`).click();
  await expect(full).toHaveCount(0);await expect(page.getByTestId(`card-${canvasChild.id}`)).toBeVisible();if(overPage)await expect(page.getByTestId(`page-focus-${pageId}`)).toBeHidden();
  assert.deepEqual((await node(main.id)).messages,original.messages);assert.equal((await node(main.id)).draft,'Preserve this full-screen source draft.');proof.explicitShowOnCanvas=true;
  await screenshot('explicit-canvas-route');
  assert.deepEqual(proof.rendererErrors,[]);assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  proof.passed=true;
});
