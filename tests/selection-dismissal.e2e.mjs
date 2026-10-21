import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {selectPageText} from './page-editor-helpers.mjs';

const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(root,'../../work/selection-dismissal-e2e');
const quote='selected molecules';
const answer=`A completed synthetic answer compares ${quote} with the surrounding tissue. Preserve this source conversation while opening a side question or a branch. The source reference marker is MARBLE-81.`;

test('compact selection actions dismiss after deselection while expanded questions retain their draft and quote',{timeout:25000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-selection-dismissal-'));
  await fs.mkdir(output,{recursive:true});
  const proof={hidden:true,foregroundInteraction:false,trustedPointerSelection:true,rendererErrors:[],screenshots:[]};
  let app,page,boardId,nodeId;
  const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.tangent.invoke(command,payload),{command,payload});
  const board=()=>invoke('app/state').then(state=>state.boards.find(board=>board.id===boardId));
  const node=()=>board().then(board=>board.nodes.find(node=>node.id===nodeId));
  const shot=async name=>{const file=path.join(output,`${name}.png`);await page.screenshot({path:file});proof.screenshots.push(file)};
  t.after(async()=>{
    if(page)try{await shot('last-state')}catch{}
    await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');
    if(app){const current=app;app=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}}
    await fs.rm(folder,{recursive:true,force:true});
  });
  app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:path.join(folder,'data'),TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'threads.json')}});
  page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));await page.getByTestId('canvas-surface').waitFor();
  await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
  await page.getByTestId('new-chat').click();boardId=(await invoke('app/state')).activeBoardId;
  await expect.poll(async()=>{nodeId=(await board()).nodes.find(node=>node.kind==='chat')?.id;return Boolean(nodeId)}).toBe(true);
  const card=page.getByTestId(`card-${nodeId}`);await card.getByTestId(`composer-${nodeId}`).fill(`Reply exactly: ${answer}`);await card.getByTestId(`send-${nodeId}`).click();
  await expect.poll(async()=>(await node()).status).toBe('idle');const assistant=(await node()).messages.find(message=>message.role==='assistant'&&message.text===answer);assert.ok(assistant?.turnId);
  await card.getByTestId(`chat-focus-open-${nodeId}`).click();
  const full=page.getByTestId(`chat-fullscreen-${nodeId}`);await expect(full).toBeVisible();
  const source=full.getByTestId(`message-${assistant.id}`).locator('.message-text'),toolbar=()=>page.getByTestId('selection-toolbar');
  const select=async()=>{await selectPageText(page,source,quote,{clearCurrentFormatting:false});await expect(toolbar()).toBeVisible();await expect(toolbar().getByTestId('selection-comment')).toBeVisible()};
  const blankClick=async()=>{const scroller=full.locator('.chat-scroll');const box=await scroller.boundingBox();assert.ok(box);await scroller.click({position:{x:box.width-8,y:Math.min(box.height-12,220)}})};
  proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  await select();await shot('compact-selected');
  await blankClick();assert.equal(await page.evaluate(()=>getSelection()?.isCollapsed),true,'The ordinary blank click must collapse the actual browser selection.');
  await expect(toolbar()).toHaveCount(0,{timeout:350});proof.blankClickDismissedCompact=true;
  await select();
  // Clearing the native browser Selection also emits selectionchange. Arrow
  // keys on noneditable prose are not a reliable caret movement when another
  // control owns keyboard focus, so name this API check explicitly.
  await page.evaluate(()=>getSelection()?.removeAllRanges());
  assert.equal(await page.evaluate(()=>getSelection()?.isCollapsed),true,'Clearing the browser Selection must remove the actual selected range.');
  await expect(toolbar()).toHaveCount(0,{timeout:350});proof.selectionApiClearingDismissedCompact=true;
  await select();await toolbar().getByTestId('selection-comment').click();
  const question=toolbar().getByTestId('comment-question'),draft='Explain the selected marker without changing the source conversation.';
  await expect(question).toBeFocused();await question.pressSequentially(draft,{delay:2});
  await expect(toolbar().locator('blockquote')).toHaveText(quote);
  await blankClick();await expect(toolbar()).toBeVisible();await expect(question).toHaveValue(draft);await expect(toolbar().locator('blockquote')).toHaveText(quote);proof.expandedQuestionSurvivesOutsideClick=true;
  await question.click();await expect(question).toHaveValue(draft);await toolbar().getByTestId('submit-comment').click();
  let side;await expect.poll(async()=>{side=(await board()).nodes.find(item=>item.parentId===nodeId&&item.kind==='comment');return side?.status}).toBe('idle');
  const floating=page.getByTestId(`floating-side-chat-${side.id}`);await expect(floating).toBeVisible();await expect(full).toBeVisible();assert.equal(side.quote,quote);assert.ok(side.messages.some(message=>message.role==='user'&&message.text===draft));proof.expandedAskSubmissionUsable=true;
  await floating.getByTestId(`floating-chat-close-${side.id}`).click();await expect(floating).toHaveCount(0);
  await select();await toolbar().getByTestId('selection-branch').click();
  let branch;await expect.poll(async()=>{branch=(await board()).nodes.find(item=>item.parentId===nodeId&&item.kind==='chat');return Boolean(branch?.threadId)}).toBe(true);
  await expect(page.getByTestId(`floating-side-chat-${branch.id}`)).toBeVisible();await expect(full).toBeVisible();await expect(toolbar()).toHaveCount(0);proof.branchActionUsable=true;
  assert.equal((await node()).messages.filter(message=>message.role==='assistant'&&message.text===answer).length,1);assert.deepEqual(proof.rendererErrors,[]);
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});proof.passed=true;
});
