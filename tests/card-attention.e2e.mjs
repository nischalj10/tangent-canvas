import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {CanvasStore} from '../electron/store.mjs';

const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(root,'../../work/card-attention-e2e');
const shadowColors=shadow=>[...shadow.matchAll(/rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)(?:\s*[,/]\s*([\d.]+))?\s*\)/g)].map(match=>({r:Number(match[1]),g:Number(match[2]),b:Number(match[3]),a:match[4]===undefined?1:Number(match[4])}));
const yellow=shadow=>shadowColors(shadow).some(c=>c.a>0&&c.r>=150&&c.g>=100&&c.b<=110);
const green=shadow=>shadowColors(shadow).some(c=>c.a>0&&c.r<=140&&c.g>=90&&c.b<=170&&c.g>c.r);

test('chat cards distinguish working, unread completion and read state without marking failures or old history complete',{timeout:40000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-card-attention-')),directory=path.join(folder,'data');
  await fs.mkdir(output,{recursive:true});
  const store=new CanvasStore(directory),boardId=store.state.activeBoardId,historyId='attention-existing-history';
  store.state.boards[0].viewport={x:15,y:95,zoom:1};
  store.state.boards[0].nodes.push({id:historyId,kind:'chat',title:'Existing completed history',position:{x:10,y:10},width:440,height:520,messages:[{id:'attention-existing-user',role:'user',text:'A historical question.',status:'completed'},{id:'attention-existing-answer',role:'assistant',text:'An old completed answer must not appear newly unread.',status:'completed',turnId:'historical-turn'}],activities:[],queue:[],queuePaused:false,status:'idle',draft:'',model:'gpt-6.1-sol',effort:'low',permissionMode:'full',inheritedCount:0,createdAt:1700000000000});
  store.touch();store.flush();
  const proof={hidden:true,foregroundInteraction:false,fixtureOnly:true,screenshots:[],rendererErrors:[]};
  let app,page,nodeId;
  const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.tangent.invoke(command,payload),{command,payload});
  const board=()=>invoke('app/state').then(state=>state.boards.find(board=>board.id===boardId));
  const node=()=>board().then(board=>board.nodes.find(node=>node.id===nodeId));
  const card=()=>page.getByTestId(`card-${nodeId}`),history=()=>page.getByTestId(`card-${historyId}`),composer=()=>card().getByTestId(`composer-${nodeId}`);
  const shadow=element=>element.evaluate(element=>getComputedStyle(element).boxShadow);
  const shot=async name=>{await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));const file=path.join(output,`${name}.png`);await page.screenshot({path:file});proof.screenshots.push(file)};
  const close=async()=>{if(!app)return;const current=app;app=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  const launch=async()=>{app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:directory,TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'threads.json')}});page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000))};
  t.after(async()=>{if(page)try{await shot('last-state')}catch{}await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');await close();await fs.rm(folder,{recursive:true,force:true})});
  await launch();proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  await expect(history()).not.toHaveAttribute('data-attention',/working|completed/);assert.equal(green(await shadow(history())),false);proof.existingHistoryIsNotUnread=true;
  await page.getByTestId('new-chat').click();await expect.poll(async()=>{nodeId=(await board()).nodes.find(node=>node.id!==historyId&&node.kind==='chat')?.id;return Boolean(nodeId)}).toBe(true);
  await invoke('node/update',{boardId,nodeId,position:{x:500,y:10},width:440,height:520});await page.waitForTimeout(350);
  await composer().fill('SLOW_TEST');await expect(composer()).toHaveValue('SLOW_TEST');await card().getByTestId(`send-${nodeId}`).click();await expect.poll(async()=>(await node()).status).toBe('running');
  await expect(card()).toHaveAttribute('data-attention','working',{timeout:500});
  await expect.poll(async()=>yellow(await shadow(card())),{timeout:1500}).toBe(true);proof.workingBoxShadow=await shadow(card());assert.ok(yellow(proof.workingBoxShadow),'A working card must have a visible yellow glow.');await shot('working-yellow');
  await composer().pressSequentially('Reply exactly: A newly completed answer.',{delay:2});await card().getByTestId(`steer-${nodeId}`).click();
  await expect.poll(async()=>(await node()).status).toBe('idle');await expect.poll(async()=>(await node()).hasUnreadReply).toBe(true);
  await expect(card()).toHaveAttribute('data-attention','completed');await expect.poll(async()=>green(await shadow(card())),{timeout:1500}).toBe(true);proof.completedBoxShadow=await shadow(card());assert.ok(green(proof.completedBoxShadow),'A newly completed unread reply must have a visible green glow.');await shot('completed-green');
  const unrelatedPoint=await page.getByTestId('canvas-surface').evaluate(element=>{
    const r=element.getBoundingClientRect(),points=[{x:r.right-22,y:r.top+140},{x:r.right-22,y:r.top+r.height/2},{x:r.left+r.width/2,y:r.bottom-170},{x:r.left+22,y:r.bottom-170}];
    return points.find(point=>{const target=document.elementFromPoint(point.x,point.y);return target?.closest('[data-testid="canvas-surface"]')&&!target.closest('.canvas-card,button,input,textarea,.sidebar,.canvas-toolbar')});
  });assert.ok(unrelatedPoint,'An actual visible blank canvas point must be available.');await page.mouse.click(unrelatedPoint.x,unrelatedPoint.y);
  await expect(card()).toHaveAttribute('data-attention','completed');assert.equal((await node()).hasUnreadReply,true);proof.unrelatedClickPreservesUnread=true;
  await close();await launch();await expect(card()).toHaveAttribute('data-attention','completed');assert.equal((await node()).hasUnreadReply,true);proof.unreadPersistsOnNormalRelaunch=true;
  await card().locator('.card-header').click({position:{x:70,y:14}});await expect(card()).not.toHaveAttribute('data-attention',/working|completed/);await expect.poll(async()=>(await node()).hasUnreadReply).toBe(false);await expect.poll(async()=>green(await shadow(card())),{timeout:1500}).toBe(false);proof.cardClickMarksRead=true;await shot('read-without-glow');
  await composer().pressSequentially('THROW_TEST',{delay:2});await card().getByTestId(`send-${nodeId}`).click();await expect.poll(async()=>(await node()).status).toBe('error');await expect(card()).not.toHaveAttribute('data-attention','completed');assert.equal(!!(await node()).hasUnreadReply,false);await expect.poll(async()=>green(await shadow(card())),{timeout:1500}).toBe(false);proof.failedReplyIsNotCompleted=true;
  await composer().fill('SLOW_TEST');await card().getByTestId(`send-${nodeId}`).click();await expect.poll(async()=>(await node()).status).toBe('running');await expect(card()).toHaveAttribute('data-attention','working');
  await card().getByTestId(`stop-${nodeId}`).click();await expect.poll(async()=>(await node()).status).toBe('interrupted');await expect(card()).not.toHaveAttribute('data-attention','completed');assert.equal(!!(await node()).hasUnreadReply,false);await expect.poll(async()=>green(await shadow(card())),{timeout:1500}).toBe(false);proof.interruptedReplyIsNotCompleted=true;
  await expect(history()).not.toHaveAttribute('data-attention',/working|completed/);
  // A side conversation hovering over a full-screen chat uses the same durable
  // attention state, with the visible floating wrapper carrying the glow.
  const completed=(await node()).messages.find(message=>message.role==='assistant'&&message.text==='A newly completed answer.');assert.ok(completed?.turnId);
  await card().getByTestId(`chat-focus-open-${nodeId}`).click();const full=page.getByTestId(`chat-fullscreen-${nodeId}`);await expect(full).toBeVisible();
  await full.getByTestId(`comment-${completed.id}`).click();const form=page.getByTestId('selection-toolbar');await form.getByTestId('comment-question').fill('SLOW_TEST');await form.getByTestId('submit-comment').click();
  let side;await expect.poll(async()=>{side=(await board()).nodes.find(item=>item.parentId===nodeId&&item.kind==='comment');return side?.status}).toBe('running');
  const floating=page.getByTestId(`floating-side-chat-${side.id}`);await expect(floating).toBeVisible();await expect(floating).toHaveAttribute('data-attention','working');
  await expect.poll(async()=>yellow(await shadow(floating)),{timeout:1500}).toBe(true);proof.floatingWorkingBoxShadow=await shadow(floating);assert.ok(yellow(proof.floatingWorkingBoxShadow));
  await floating.getByTestId(`composer-${side.id}`).fill('Reply exactly: A completed floating answer.');await floating.getByTestId(`steer-${side.id}`).click();
  await expect.poll(async()=>(await board()).nodes.find(item=>item.id===side.id).status).toBe('idle');await expect(floating).toHaveAttribute('data-attention','completed');await expect.poll(async()=>green(await shadow(floating)),{timeout:1500}).toBe(true);proof.floatingCompletedBoxShadow=await shadow(floating);assert.ok(green(proof.floatingCompletedBoxShadow));await shot('floating-completed-green');
  await floating.getByTestId(`floating-chat-title-${side.id}`).click();await expect(floating).not.toHaveAttribute('data-attention',/working|completed/);await expect.poll(async()=>green(await shadow(floating)),{timeout:1500}).toBe(false);await expect.poll(async()=>(await board()).nodes.find(item=>item.id===side.id).hasUnreadReply).toBe(false);proof.floatingGlowAndReadClick=true;
  assert.deepEqual(proof.rendererErrors,[]);
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});proof.passed=true;
});
