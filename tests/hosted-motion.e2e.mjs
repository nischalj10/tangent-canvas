import {attachFixturePage} from './canvas-setup-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceDirectory=path.resolve(root,'../../work/native-page-source');

test('native Browser fallback remains aligned across retained Page exits, sidebar FLIP and responsive reversal',{timeout:45000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-hosted-motion-'));
  const source=JSON.parse(await fs.readFile(path.join(sourceDirectory,'page.json'),'utf8'));
  let application,page;const errors=[],proof={checks:[],foregroundInteraction:false};
  const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.tangent.invoke(command,payload),{command,payload});
  const board=async()=>{const state=await invoke('app/state');return state.boards.find(item=>item.id===state.activeBoardId)};
  const close=async()=>{if(!application)return;const current=application;application=null;const timeout=setTimeout(()=>current.process()?.kill('SIGKILL'),5000);try{await current.close()}finally{clearTimeout(timeout)}};
  t.after(async()=>{if(page&&!page.isClosed()){try{await fs.writeFile(path.resolve(root,'../../work/hosted-sidebar-pointer-final.json'),JSON.stringify(await page.evaluate(()=>window.__hostedSidebarPointer||[]),null,2)+'\n');await fs.writeFile(path.resolve(root,'../../work/hosted-motion-partial-proof.json'),JSON.stringify(proof,null,2)+'\n');await page.screenshot({path:path.resolve(root,'../../work/hosted-motion-last-state.png'),animations:'disabled'})}catch{}}await close();await fs.rm(directory,{recursive:true,force:true})});
  application=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:path.join(directory,'app'),TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(directory,'peer.json'),TANGENT_PAGE_FIXTURE_DIR:sourceDirectory,TANGENT_PAGE_FIXTURE_STATE:path.join(directory,'pages.json')}});
  page=await application.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>errors.push(error.message));
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,982));
  await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});
  proof.rendererBundle=await page.locator('script[type=module]').getAttribute('src');
  assert.deepEqual(await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  await application.evaluate(async({session})=>{
    const profile=session.fromPartition('persist:tangent-chatgpt-pages');
    await profile.protocol.handle('https',()=>new Response('<!doctype html><title>Hosted motion fixture</title><h1>Isolated native Page</h1><textarea data-testid="native-draft">Persistent native draft</textarea><p>This fixture never contacts a remote Page.</p>',{headers:{'content-type':'text/html'}}));
  });
  let linked=await attachFixturePage(page,{url:source.metadata.url});
  const shell=page.getByTestId(`page-focus-${linked.id}`),body=page.getByTestId(`page-body-${linked.id}`);
  await expect(shell).toBeVisible();
  await page.getByTestId(`page-title-menu-${linked.id}`).click();await page.getByTestId(`page-browser-${linked.id}`).click();await page.getByTestId(`page-open-${linked.id}`).click();
  await expect(shell).toHaveCount(0);await expect.poll(async()=>(await invoke('page/status'))?.deferred).toBe(true);
  // AppKit requires a realized parent to create a native child. This isolated
  // window is transparent, ignores pointer input, has prohibited activation,
  // and is never focused or exposed to the user's workspace.
  await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setOpacity(0);w.setHasShadow(false);w.setIgnoreMouseEvents(true);w.showInactive()});
  let nativePage;await expect.poll(()=>{nativePage=application.context().pages().find(candidate=>candidate.url()===source.metadata.url);return Boolean(nativePage)}).toBe(true);
  await expect(nativePage.getByRole('heading',{name:'Isolated native Page'})).toBeVisible();
  const nativeGeometry=()=>application.evaluate(({BrowserWindow},url)=>{const w=BrowserWindow.getAllWindows()[0],container=w.contentView.children.find(view=>view.children?.some(child=>child.webContents?.getURL()===url)),child=container?.children.find(child=>child.webContents);return container?{visible:container.getVisible(),bounds:container.getBounds(),pageBounds:child.getBounds(),focused:w.isFocused(),opacity:w.getOpacity()}:null},source.metadata.url);
  await expect.poll(async()=>(await nativeGeometry())?.visible).toBe(true);
  await nativePage.getByTestId('native-draft').fill('Retained native document state',{force:true});
  const active=await board();await invoke('node/update',{boardId:active.id,nodeId:linked.id,width:1000,height:1800});
  await expect.poll(async()=>(await body.boundingBox())?.height||0).toBeGreaterThan(900);
  const before=await body.boundingBox(),zoom=await page.locator('.react-flow__viewport').evaluate(element=>new DOMMatrixReadOnly(getComputedStyle(element).transform).a);
  linked=(await board()).nodes.find(node=>node.id===linked.id);
  await invoke('node/update',{boardId:active.id,nodeId:linked.id,position:{...linked.position,y:linked.position.y+(-80-before.y)/zoom}});
  await expect.poll(async()=>Math.abs((await body.boundingBox()).y+80)).toBeLessThan(2);
  const assertAligned=async label=>{
    await expect(body).toHaveAttribute('data-native-visible','true');await expect.poll(async()=>(await nativeGeometry())?.visible).toBe(true);
    await expect.poll(async()=>{const geometry=await nativeGeometry(),rect=await body.boundingBox();const maxError=Math.max(Math.abs(geometry.bounds.x+geometry.pageBounds.x-Math.round(rect.x)),Math.abs(geometry.bounds.y+geometry.pageBounds.y-Math.round(rect.y)));proof.latestAlignment={label,geometry,body:rect,maxError};return maxError}).toBeLessThanOrEqual(1);
    const geometry=await nativeGeometry();const clip=await page.evaluate(()=>{const rect=element=>{const r=element.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}},canvas=rect(document.querySelector('.canvas-surface')),header=rect(document.querySelector('.workspace-topbar')),controls=[...document.querySelectorAll('.canvas-dock,.zoom-control')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').map(rect);return{canvas,header,bottom:Math.min(canvas.bottom,...controls.map(r=>r.y))}});
    assert.equal(geometry.bounds.y,Math.ceil(clip.header.bottom),'Native clip starts at the measured header, including its current46px geometry');
    assert.equal(geometry.bounds.y+geometry.bounds.height,Math.floor(clip.bottom),'Native content cannot cover the actual dock/zoom controls');
    assert.ok(geometry.bounds.x>=Math.ceil(clip.canvas.x));assert.equal(geometry.focused,false);assert.equal(geometry.opacity,0);
    await expect(nativePage.getByTestId('native-draft')).toHaveValue('Retained native document state');proof.checks.push({label,geometry,clip});
  };
  await assertAligned('initial dynamic clipping');
  const persisted=(await board()).nodes.map(node=>({id:node.id,position:node.position,width:node.width,height:node.height}));
  await page.getByTestId('hide-sidebar').click();await expect(body).toHaveAttribute('data-native-visible','false');await expect.poll(async()=>(await nativeGeometry()).visible,{intervals:[5,10,20]}).toBe(false);await assertAligned('sidebar collapsed after FLIP');
  await page.getByTestId('show-sidebar').click();await expect(body).toHaveAttribute('data-native-visible','false');await assertAligned('sidebar expanded after FLIP');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1024,982));await expect.poll(()=>page.evaluate(()=>innerWidth)).toBe(1024);await assertAligned('responsive1024 baseline');
  // Trusted renderer input reverses a running FLIP without Playwright's
  // stability wait. Sample the moving target and dispatch together in main;
  // separate CDP move/down/up roundtrips can outlive its sampled rectangle.
  await page.getByTestId('hide-sidebar').click();await expect(body).toHaveAttribute('data-native-visible','false');await page.waitForTimeout(35);
  await page.evaluate(()=>{window.__hostedSidebarPointer=[];for(const type of ['pointerdown','gotpointercapture','pointerup','click','lostpointercapture'])document.addEventListener(type,event=>{const button=document.querySelector('[data-testid="show-sidebar"]'),workspace=document.querySelector('.workspace'),r=button?.getBoundingClientRect(),animation=workspace?.getAnimations().find(animation=>animation.effect.getKeyframes().some(frame=>frame.translate));window.__hostedSidebarPointer.push({type,time:performance.now(),appClass:document.querySelector('.app-shell')?.className,pointerId:event.pointerId,hasPointerCapture:button&&Number.isFinite(event.pointerId)?button.hasPointerCapture(event.pointerId):null,trusted:event.isTrusted,point:{x:event.clientX,y:event.clientY},target:event.target.closest('[data-testid]')?.dataset.testid||event.target.tagName,button:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,hit:!!button&&event.target.closest('[data-testid="show-sidebar"]')===button,workspaceTranslate:getComputedStyle(workspace).translate,nativeVisible:document.querySelector('[data-native-visible]')?.dataset.nativeVisible,animation:animation?{state:animation.playState,currentTime:animation.currentTime,duration:animation.effect.getTiming().duration}:null});if(type==='click')queueMicrotask(()=>window.__hostedSidebarPointer.push({type:'after-click-microtask',time:performance.now(),appClass:document.querySelector('.app-shell')?.className}))},{capture:true,once:true});const shell=document.querySelector('.app-shell');new MutationObserver(()=>window.__hostedSidebarPointer.push({type:'app-class-mutation',time:performance.now(),appClass:shell.className})).observe(shell,{attributes:true,attributeFilter:['class']})});
  const requested=await application.evaluate(async({BrowserWindow},url)=>{
    const window=BrowserWindow.getAllWindows()[0],wc=window.webContents;
    const box=await wc.executeJavaScript(`(()=>{const r=document.querySelector('[data-testid="show-sidebar"]').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`),x=Math.round(box.x+box.width/2),y=Math.round(box.y+box.height/2);
    const container=window.contentView.children.find(view=>view.children?.some(child=>child.webContents?.getURL()===url)),nativeVisible=container?.getVisible();
    wc.sendInputEvent({type:'mouseMove',x,y});wc.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});await new Promise(resolve=>setTimeout(resolve,90));wc.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});return{box,point:{x,y},nativeVisible,heldMs:90};
  },source.metadata.url);
  proof.sidebarReversal={input:'trusted renderer input sampled and dispatched in one main batch',physicalOSInput:false,requested,events:await page.evaluate(()=>window.__hostedSidebarPointer)};await fs.writeFile(path.resolve(root,'../../work/hosted-sidebar-pointer.json'),JSON.stringify(proof.sidebarReversal,null,2)+'\n');
  const pointer=proof.sidebarReversal.events[0];assert.ok(pointer?.trusted&&pointer.hit,'The actual trusted pointerdown hits the moving show-sidebar control');assert.equal(pointer.animation?.state,'running');assert.ok(pointer.animation.currentTime<pointer.animation.duration,'The reversal interrupts FLIP rather than waiting for it to finish');assert.equal(pointer.nativeVisible,'false');assert.equal(requested.nativeVisible,false,'The actual native child remains hidden during the interrupted FLIP');
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-hidden/);await assertAligned('responsive sidebar reversal');
  const hideBox=await page.getByTestId('hide-sidebar').boundingBox();
  await application.evaluate(({BrowserWindow},{x,y})=>{const wc=BrowserWindow.getAllWindows()[0].webContents;wc.sendInputEvent({type:'mouseMove',x,y});wc.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseMove',x:x+36,y});wc.sendInputEvent({type:'mouseUp',x:x+36,y,button:'left',clickCount:1})},{x:Math.round(hideBox.x+hideBox.width/2),y:Math.round(hideBox.y+hideBox.height/2)});
  await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-hidden/);await assertAligned('dragging away cancels the captured sidebar press');
  const nativeSpace=()=>application.evaluate(({BrowserWindow})=>{const wc=BrowserWindow.getAllWindows()[0].webContents;wc.sendInputEvent({type:'keyDown',keyCode:'Space'});wc.sendInputEvent({type:'char',keyCode:' '});wc.sendInputEvent({type:'keyUp',keyCode:'Space'})});
  await page.getByTestId('hide-sidebar').focus();await nativeSpace();await expect(page.locator('.app-shell')).toHaveClass(/sidebar-hidden/);await assertAligned('native Space hides sidebar');await page.getByTestId('show-sidebar').focus();await nativeSpace();await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-hidden/);await assertAligned('native Space restores sidebar');proof.sidebarPress={heldDuringActiveFlip:true,dragAwayCancelled:true,physicalPointerTravelForCancellation:36,nativeKeyboardSpaceRetained:true};
  assert.deepEqual((await board()).nodes.map(node=>({id:node.id,position:node.position,width:node.width,height:node.height})),persisted);
  // The clipping probe deliberately placed the Browser toolbar above the
  // viewport. Use the ordinary canvas control to bring it back before clicking.
  await page.getByTestId('fit-canvas').click();
  await page.getByRole('button',{name:'Native view',exact:true}).click();await expect(page.getByTestId(`page-focus-${linked.id}`)).toBeVisible();await expect.poll(async()=>(await nativeGeometry())?.visible??false).toBe(false);
  await page.getByTestId(`page-title-menu-${linked.id}`).click();await page.getByTestId(`page-browser-${linked.id}`).click();await page.getByTestId(`page-open-${linked.id}`).click();await expect(body).toHaveAttribute('data-native-visible','true');await expect.poll(async()=>(await nativeGeometry())?.visible).toBe(true);
  assert.deepEqual(errors,[]);Object.assign(proof,{passed:true,nativeWindowOpacity:0,nativeWindowFocused:false,persistedGeometryUnchanged:true,rendererErrors:errors});await fs.writeFile(path.resolve(root,'../../work/hosted-motion-proof.json'),JSON.stringify(proof,null,2)+'\n');
  t.diagnostic('Real native child clips to measured toolbar/dock, hides during FLIP, resumes exact bounds, survives responsive reversal, retains native draft, and releases native Page exit gating.');
});
