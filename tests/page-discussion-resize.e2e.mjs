import {attachFixturePage} from './canvas-setup-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {CanvasStore} from '../electron/store.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceDirectory=process.env.TANGENT_PAGE_FIXTURE_DIR||path.resolve(root,'../../work/native-page-source');
const proofDirectory=path.resolve(root,'../../work/page-discussion-resize-e2e');
const sha=value=>createHash('sha256').update(value).digest('hex');
const near=(actual,expected,message,tolerance=1.5)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${message}: expected ${expected}, received ${actual}`);

// This harness starts an independent, hidden app and deterministic Codex peer.
// It never opens or modifies the user's running profile or foreground browser.
async function fixture(t){
  const sourceBytes=await fs.readFile(path.join(sourceDirectory,'page.json'));
  const source=JSON.parse(sourceBytes);
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-page-discussion-resize-'));
  const toolLog=path.join(folder,'page-tools.jsonl');
  const environment={...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:path.join(folder,'app-data'),TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'peer.json'),TANGENT_PAGE_FIXTURE_DIR:sourceDirectory,TANGENT_PAGE_FIXTURE_STATE:path.join(folder,'page-state.json'),TANGENT_PAGE_FIXTURE_LOG:toolLog};
  const store=new CanvasStore(environment.TANGENT_DATA_DIR);
  store.state.boards[0].viewport={x:70,y:90,zoom:.77};store.touch();store.flush();
  let application,page;
  const errors=[],proof={screenshots:[],hidden:true,foregroundInteraction:false,fixtureBackend:true};
  const state=()=>page.evaluate(()=>window.tangent.invoke('app/state'));
  const board=async()=>{const s=await state();return s.boards.find(item=>item.id===s.activeBoardId)};
  const node=async id=>(await board()).nodes.find(item=>item.id===id);
  const close=async()=>{const current=application;application=null;if(!current)return;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  const launch=async()=>{
    application=await electron.launch({args:['.','--background'],cwd:root,env:environment});page=await application.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',error=>errors.push(error.message));
    await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection'))).toMatchObject({connected:true,account:{type:'chatgpt'}});
    assert.deepEqual(await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  };
  const resize=async(width,height)=>{await application.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(size.width,size.height),{width,height});await expect.poll(()=>page.evaluate(()=>[innerWidth,innerHeight])).toEqual([width,height])};
  const screenshot=async name=>{const file=path.join(proofDirectory,name);await page.screenshot({path:file,animations:'disabled'});proof.screenshots.push(file);return file};
  const openPage=async id=>{const n=await node(id);await page.locator('.outline-list > button').filter({hasText:n.title}).first().click();await expect(page.getByTestId(`page-focus-${id}`)).toBeVisible()};
  const setMode=async(id,mode)=>{const shell=page.getByTestId(`page-focus-${id}`);if(await shell.getAttribute('data-page-mode')!==mode)await page.getByTestId(`page-view-toggle-${id}`).click();await expect(shell).toHaveAttribute('data-page-mode',mode);await expect.poll(async()=>(await node(id)).pageView??'half').toBe(mode);await expect.poll(()=>shell.evaluate(el=>el.getAnimations().every(animation=>animation.playState!=='running'))).toBe(true)};
  const logs=async()=>{try{return(await fs.readFile(toolLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch{return[]}};
  t.after(async()=>{
    await fs.mkdir(proofDirectory,{recursive:true});
    if(application){try{await fs.writeFile(path.join(proofDirectory,'state.json'),JSON.stringify(await state(),null,2)+'\n');await screenshot('last-state.png')}catch{}}
    try{await fs.copyFile(toolLog,path.join(proofDirectory,'tools.jsonl'))}catch{}
    await fs.writeFile(path.join(proofDirectory,'proof.json'),JSON.stringify({...proof,rendererErrors:errors},null,2)+'\n');await close();await fs.rm(folder,{recursive:true,force:true});
  });
  await fs.mkdir(proofDirectory,{recursive:true});
  return{get application(){return application},get page(){return page},source,sourceBytes,errors,proof,state,board,node,launch,close,resize,screenshot,openPage,setMode,logs};
}

test('Page discussion resizes with trusted input, keeps native content and drafts, and persists its preferred width',{timeout:140000},async t=>{
  const f=await fixture(t);await f.launch();await f.resize(1440,1000);
  let page=f.page;
  const linked=await attachFixturePage(page,{url:f.source.metadata.url,title:'Resizable Page discussion'});
  assert.ok((await f.logs()).some(call=>call.tool==='read_page'&&call.server==='codex_apps'),'The connected original Page must come from the isolated fixture peer');
  const id=linked.id;
  let shell=page.getByTestId(`page-focus-${id}`);
  await f.setMode(id,'full');
  const articleHandle=await shell.locator('.rich-page-document').elementHandle(),editorHandle=await shell.getByRole('textbox',{name:'Page document',exact:true}).elementHandle();
  const figure=shell.getByTestId('page-visualization-frame').first();await figure.scrollIntoViewIfNeeded();const figureHandle=await figure.elementHandle();
  await expect.poll(async()=>((await figureHandle.contentFrame())?.locator('svg').count())).toBe(1);
  const iframeName=await figure.getAttribute('name');
  await page.getByTestId('page-discussion-toggle').click();
  let panel=page.getByTestId('page-discussion-panel'),grip=page.getByTestId('page-discussion-resize'),input=page.getByTestId(`page-ask-input-${id}`);
  await expect(panel).toBeVisible();await expect(grip).toHaveAttribute('role','separator');await expect(grip).toHaveAttribute('aria-orientation','vertical');await expect(grip).toHaveAttribute('tabindex','0');await expect(grip).toHaveCSS('cursor','col-resize');

  // Hold only the test IPC acknowledgement. The real accepted send still runs
  // through page/ask and the deterministic peer; rejection never reaches it.
  await f.application.evaluate(({ipcMain})=>{
    globalThis.__discussionOriginalHandler=ipcMain._invokeHandlers.get('tangent:invoke');
    globalThis.__discussionSendControl={mode:'pass',waiting:false,release:null};
    ipcMain.removeHandler('tangent:invoke');
    ipcMain.handle('tangent:invoke',async(...args)=>{
      const control=globalThis.__discussionSendControl;
      if(args[1]!=='page/ask'||control.mode==='pass')return globalThis.__discussionOriginalHandler(...args);
      const reject=control.mode==='reject',result=reject?null:await globalThis.__discussionOriginalHandler(...args);
      control.waiting=true;await new Promise(resolve=>{control.release=resolve});control.waiting=false;control.mode='pass';control.release=null;
      if(reject)throw Error('Deterministic Page send rejected before dispatch.');
      return result;
    });
  });
  const holdSend=async mode=>f.application.evaluate((_,mode)=>{Object.assign(globalThis.__discussionSendControl,{mode,waiting:false,release:null})},mode);
  const releaseSend=async()=>f.application.evaluate(()=>globalThis.__discussionSendControl.release?.());
  const submitHeld=async text=>{await input.fill(text);await page.getByTestId(`page-ask-send-${id}`).click();await expect.poll(()=>f.application.evaluate(()=>globalThis.__discussionSendControl.waiting)).toBe(true);await expect(input).toHaveValue('',{timeout:200})};
  const longAnswer=Array(9).fill('A readable discussion retains the same words while a wider sidebar gives every line more room.').join(' ');
  const retainedDraft='Retain this unsent Page draft through every resize and relaunch.';
  await holdSend('delay');await submitHeld(`Reply exactly: ${longAnswer}`);await input.fill(retainedDraft);await releaseSend();
  let chat;await expect.poll(async()=>{chat=await f.node((await f.node(id)).targetChatId);return chat?.messages.at(-1)?.text}).toBe(longAnswer);await expect.poll(async()=>(await f.node(chat.id)).status).toBe('idle');await expect(input).toHaveValue(retainedDraft);
  const acceptedMessages=structuredClone((await f.node(chat.id)).messages);
  await holdSend('reject');await submitHeld('A rejected draft must return.');await releaseSend();await expect(input).toHaveValue('A rejected draft must return.');
  await holdSend('reject');await submitHeld('An older rejected draft must not replace new typing.');await input.fill('A newer draft survives rejection.');await releaseSend();await expect(input).toHaveValue('A newer draft survives rejection.');
  await holdSend('reject');await submitHeld('A deliberately emptied successor stays empty.');await input.fill('An intervening edit.');await input.fill('');await releaseSend();await expect(input).toHaveValue('');
  await input.fill(retainedDraft);await expect.poll(async()=>(await f.node(id)).draft).toBe(retainedDraft);
  assert.deepEqual((await f.node(chat.id)).messages,acceptedMessages,'Definite rejected sends cannot add duplicate messages');
  await f.application.evaluate(({ipcMain})=>{ipcMain.removeHandler('tangent:invoke');ipcMain.handle('tangent:invoke',globalThis.__discussionOriginalHandler);delete globalThis.__discussionOriginalHandler;delete globalThis.__discussionSendControl});
  const dismissError=shell.getByTitle('Dismiss Page error');if(await dismissError.isVisible())await dismissError.click();
  await page.getByTestId(`page-settings-${id}-trigger`).click();await expect(page.getByTestId(`page-settings-${id}-popover`)).toBeVisible();await page.getByTestId(`page-model-${id}`).selectOption('gpt-6-sol');const effort=page.getByTestId(`page-effort-${id}`);await expect(effort).toHaveAttribute('type','range');await expect(effort).toBeEnabled();await effort.focus();await effort.press('End');await expect.poll(async()=>({model:(await f.node(chat.id)).model,effort:(await f.node(chat.id)).effort})).toEqual({model:'gpt-6-sol',effort:'high'});await effort.press('Escape');await expect(page.getByTestId(`page-settings-${id}-popover`)).toHaveCount(0);await expect(panel).toBeVisible();
  await page.getByTestId(`page-permission-${id}`).click();await page.getByTestId(`page-permission-${id}-option-ask`).click();await expect.poll(async()=>(await f.node(chat.id)).permissionMode).toBe('ask');

  const nodeGeometry=()=>f.board().then(board=>board.nodes.map(({id,position,width,height})=>({id,position,width,height})));
  const canvasViewport=()=>page.locator('.react-flow__viewport').evaluate(el=>getComputedStyle(el).transform);
  const originalGeometry=await nodeGeometry(),originalViewport=await canvasViewport(),originalBlocks=structuredClone((await f.node(id)).pageSnapshot.blocks);
  const metrics=()=>shell.evaluate(el=>{
    const panel=el.querySelector('.page-discussion-panel'),grip=el.querySelector('[data-testid="page-discussion-resize"]'),article=el.querySelector('.rich-page-document'),paper=el.querySelector('.page-paper-region'),answer=panel.querySelector('.message.assistant .message-text'),paragraph=[...article.querySelectorAll('p')].find(item=>item.textContent.length>300),workspace=document.querySelector('.workspace');
    const rect=item=>{const r=item.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    const style=item=>{const s=getComputedStyle(item);return{font:s.fontSize,lineHeight:s.lineHeight,zoom:s.zoom,transform:s.transform}};
    const lineCount=item=>{const range=document.createRange();range.selectNodeContents(item);return new Set([...range.getClientRects()].filter(r=>r.width>0).map(r=>Math.round(r.top*10)/10)).size};
    return{viewport:{width:innerWidth,height:innerHeight},mode:el.dataset.pageMode,shell:rect(el),workspace:rect(workspace),paper:rect(paper),panel:rect(panel),article:{...rect(article),...style(article),scale:article.getBoundingClientRect().width/article.offsetWidth},answer:{...rect(answer),...style(answer),lines:lineCount(answer)},paragraph:{...rect(paragraph),...style(paragraph),lines:lineCount(paragraph)},min:Number(grip.getAttribute('aria-valuemin')),max:Number(grip.getAttribute('aria-valuemax')),now:Number(grip.getAttribute('aria-valuenow')),rootOverflow:document.documentElement.scrollWidth-innerWidth,discussionOverflow:panel.scrollWidth-panel.clientWidth,visibleComposers:[...el.querySelectorAll('textarea')].filter(item=>item.getClientRects().length).length};
  });
  const retained=async stage=>{
    for(const [name,handle]of [['Page article',articleHandle],['Page editor',editorHandle],['original visualization iframe',figureHandle]])assert.equal(await handle.evaluate(el=>el.isConnected),true,`${stage}: the same ${name} must remain mounted`);
    assert.equal(await figureHandle.getAttribute('name'),iframeName);await expect(input).toHaveValue(retainedDraft);await expect(page.getByTestId(`page-chat-target-${id}`)).toHaveValue(chat.id);await expect(page.getByTestId(`page-permission-${id}`)).toHaveAttribute('data-permission-mode','ask');
    const currentChat=await f.node(chat.id);assert.deepEqual({model:currentChat.model,effort:currentChat.effort,permission:currentChat.permissionMode,threadId:currentChat.threadId},{model:'gpt-6-sol',effort:'high',permission:'ask',threadId:chat.threadId},`${stage}: discussion settings and native thread must stay unchanged`);assert.deepEqual(currentChat.messages,acceptedMessages);assert.deepEqual((await f.node(id)).pageSnapshot.blocks,originalBlocks);assert.deepEqual(await nodeGeometry(),originalGeometry);assert.equal(await canvasViewport(),originalViewport);assert.equal(await f.application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()),1);
    const m=await metrics();assert.ok(Math.abs(m.article.scale-1)<.01,`${stage}: Page body must remain at native100%`);assert.equal(m.article.zoom,'1');assert.equal(m.visibleComposers,1);assert.ok(m.rootOverflow<=1&&m.discussionOverflow<=1,`${stage}: resizing must not create horizontal overflow`);assert.ok(m.panel.x>=m.workspace.x-1&&m.panel.right<=m.viewport.width+1,`${stage}: discussion must stay inside the available workspace`);assert.ok(m.paper.right<=m.panel.x+1||m.panel.right<=m.paper.x+1,`${stage}: document and discussion cannot overlap`);near(m.now,m.panel.width,`${stage}: separator value reflects rendered width`);return m;
  };
  const assertBounds=async stage=>{
    (f.proof.bounds??=[]).push({stage,...await metrics()});
    await expect.poll(async()=>{const m=await metrics(),available=m.mode==='full'?m.shell.width-320:m.shell.x-m.workspace.x-16;return Math.abs(m.max-Math.max(0,Math.min(800,available)))}).toBeLessThan(1.5);
    const m=await metrics(),available=m.mode==='full'?m.shell.width-320:m.shell.x-m.workspace.x-16,max=Math.max(0,Math.min(800,available)),min=Math.min(320,max);near(m.max,max,`${stage}: available-width maximum`);near(m.min,min,`${stage}: reachable minimum`);assert.ok(m.panel.width>=min-1&&m.panel.width<=max+1);return m;
  };
  const waitWidth=async expected=>{await expect.poll(async()=>Math.round((await metrics()).panel.width)).toBe(Math.round(expected));await expect(grip).toHaveAttribute('aria-valuenow',String(Math.round(expected)))};
  const savedWidth=async expected=>expect.poll(async()=>(await f.node(id)).pageDiscussionWidth??420).toBe(expected);
  const installTrusted=async()=>page.evaluate(()=>{window.__discussionResizeInput=[];const grip=document.querySelector('[data-testid="page-discussion-resize"]');for(const type of ['pointerdown','pointermove','pointerup','keydown'])grip.addEventListener(type,event=>window.__discussionResizeInput.push({type,trusted:event.isTrusted,key:event.key}))});
  const drag=async(dx,{cancel=false}={})=>{
    const before=await metrics(),box=await grip.boundingBox(),x=box.x+box.width/2,y=box.y+Math.min(box.height/2,200);await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx,y,{steps:12});if(cancel)await page.keyboard.press('Escape');await page.mouse.up();const after=await metrics();near(after.panel.right,before.panel.right,'A left-edge drag keeps the right edge anchored');return{before,after};
  };
  await installTrusted();
  const initial=await retained('Initial wide layout');await assertBounds('Initial1440 Full');near(initial.panel.width,420,'The default discussion is420px');
  const wider=await drag(-200);await waitWidth(620);await savedWidth(620);await retained('Widened discussion');assert.ok(wider.after.answer.lines<wider.before.answer.lines&&wider.after.answer.height<wider.before.answer.height,'Discussion text must reflow into fewer lines when widened');assert.ok(wider.after.paragraph.lines>wider.before.paragraph.lines,'The document must reflow into more lines as its available region narrows');assert.deepEqual({font:wider.after.answer.font,lineHeight:wider.after.answer.lineHeight,zoom:wider.after.answer.zoom,transform:wider.after.answer.transform},{font:wider.before.answer.font,lineHeight:wider.before.answer.lineHeight,zoom:wider.before.answer.zoom,transform:wider.before.answer.transform},'Widening changes line wrapping without scaling discussion typography');
  const narrower=await drag(100);await waitWidth(520);await savedWidth(520);await retained('Narrowed discussion');assert.ok(narrower.after.answer.lines>narrower.before.answer.lines,'Dragging back makes discussion text wrap again');
  const canceled=await drag(-80,{cancel:true});await waitWidth(520);await savedWidth(520);near(canceled.after.panel.width,canceled.before.panel.width,'Escape cancels an in-progress drag');
  await f.screenshot('full-1440-width520.png');
  for(const [width,height]of [[1440,1000],[1024,768]]){
    await f.resize(width,height);
    for(const mode of ['full','half']){
      await f.setMode(id,mode);const bounds=await assertBounds(`${width} ${mode}`);await retained(`${width} ${mode} start`);
      const start=await grip.boundingBox();await drag(2-(start.x+start.width/2));await waitWidth(bounds.max);await savedWidth(Math.round(Math.max(320,bounds.max)));await retained(`${width} ${mode} maximum`);
      const maxStart=await grip.boundingBox();await drag(width-2-(maxStart.x+maxStart.width/2));await waitWidth(bounds.min);await savedWidth(320);await retained(`${width} ${mode} minimum`);
      await grip.focus();await grip.press('End');await waitWidth(bounds.max);await grip.press('Home');await waitWidth(bounds.min);
      await grip.dblclick();await waitWidth(Math.min(bounds.max,420));await savedWidth(420);await retained(`${width} ${mode} reset`);await f.screenshot(`${mode}-${width}-reset.png`);
    }
  }
  await f.resize(1440,1000);await f.setMode(id,'full');await grip.dblclick();await waitWidth(420);await grip.focus();await grip.press('ArrowLeft');await waitWidth(440);await savedWidth(440);await grip.press('ArrowRight');await waitWidth(420);await savedWidth(420);
  await drag(-160);await waitWidth(580);await savedWidth(580);await retained('Preferred width580 saved');
  await f.resize(1024,768);const constrained=await assertBounds('Narrow constrained preference');await waitWidth(Math.min(580,constrained.max));await savedWidth(580);await f.resize(1440,1000);await waitWidth(580);await retained('Preferred width restored after viewport expansion');
  const trusted=await page.evaluate(()=>window.__discussionResizeInput);for(const type of ['pointerdown','pointermove','pointerup','keydown']){assert.ok(trusted.some(event=>event.type===type&&event.trusted),`Real trusted ${type} must reach the separator`);assert.ok(trusted.filter(event=>event.type===type).every(event=>event.trusted));}
  await panel.getByTitle('Close discussion').click();await expect(panel).toHaveCount(0);await page.getByTestId('page-discussion-toggle').click();await waitWidth(580);await retained('Discussion closed and reopened');
  await page.getByTestId('page-focus-back').click();await expect(shell).toBeHidden();await f.openPage(id);await waitWidth(580);await retained('Page closed and reopened');
  await expect.poll(async()=>(await f.state()).persistence.saving).toBe(false);await f.close();await f.launch();page=f.page;await f.resize(1440,1000);await f.openPage(id);shell=page.getByTestId(`page-focus-${id}`);panel=page.getByTestId('page-discussion-panel');grip=page.getByTestId('page-discussion-resize');input=page.getByTestId(`page-ask-input-${id}`);if(!await panel.isVisible())await page.getByTestId('page-discussion-toggle').click();await waitWidth(580);await savedWidth(580);await expect(input).toHaveValue(retainedDraft);await expect(page.getByTestId(`page-chat-target-${id}`)).toHaveValue(chat.id);assert.deepEqual({model:(await f.node(chat.id)).model,effort:(await f.node(chat.id)).effort,permission:(await f.node(chat.id)).permissionMode},{model:'gpt-6-sol',effort:'high',permission:'ask'});assert.deepEqual((await f.node(chat.id)).messages,acceptedMessages);assert.deepEqual((await f.node(id)).pageSnapshot.blocks,originalBlocks);assert.deepEqual(await nodeGeometry(),originalGeometry);assert.deepEqual(f.errors,[]);assert.equal(sha(await fs.readFile(path.join(sourceDirectory,'page.json'))),sha(f.sourceBytes));assert.equal((await f.logs()).filter(call=>call.tool==='edit_page').length,0);
  await f.screenshot('relaunch-width580.png');Object.assign(f.proof,{passed:true,command:'node --test --test-concurrency=1 tests/page-discussion-resize.e2e.mjs',rendererBundle:await page.locator('script[type="module"]').getAttribute('src'),trustedRendererInput:trusted,physicalOSInput:false,sourceUnchanged:true,preferredWidth:580,sameDocumentEditorAndIframeAcrossResize:true,immediateDraftClearBeforeAck:true,newerDraftSurvivesAcceptanceAndRejection:true,deliberateEmptyDraftSurvivesRejection:true});
  t.diagnostic('Hidden trusted pointer/keyboard resizing,1440/1024 Full/Half bounds, unscaled text reflow, native document/iframe identity, draft races and real relaunch persistence passed.');
});
