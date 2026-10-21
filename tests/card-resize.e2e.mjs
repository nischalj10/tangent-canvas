import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {CanvasStore} from '../electron/store.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('independently resize actual side-question and historical branch at77%: origin, stream updates, fonts, contraction and reload',{timeout:90000},async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-card-resize-e2e-'));
  const dataDirectory=path.join(directory,'app-data');
  const initial=new CanvasStore(dataDirectory);initial.state.boards[0].viewport={x:70,y:90,zoom:.77};initial.touch();initial.flush();
  const environment={...process.env,TANGENT_DATA_DIR:dataDirectory,TANGENT_ALLOW_MULTIPLE:'1',TANGENT_E2E:'1',TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(directory,'peer.json')};
  let application,page;const errors=[];
  const close=async()=>{const current=application;application=null;if(!current)return;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  t.after(async()=>{await close();await fs.rm(directory,{recursive:true,force:true})});
  const launch=async()=>{
    application=await electron.launch({args:['.','--background'],cwd:root,env:environment});page=await application.firstWindow();page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1600,1200));
    await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection'))).toMatchObject({connected:true});
    assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  };
  const state=()=>page.evaluate(()=>window.tangent.invoke('app/state'));
  const board=async()=>{const s=await state();return s.boards.find(b=>b.id===s.activeBoardId)};
  const node=async id=>(await board()).nodes.find(n=>n.id===id);
  const idle=async id=>expect.poll(async()=>(await node(id)).status,{timeout:10000}).toBe('idle');
  const navigate=async id=>{const n=await node(id);await page.locator('.outline-list > button').filter({hasText:n.title}).first().click();await page.waitForTimeout(450)};
  const font=async id=>page.getByTestId(`card-${id}`).evaluate(el=>({composer:getComputedStyle(el.querySelector('textarea')).fontSize,message:getComputedStyle(el.querySelector('.message-text')).fontSize}));
  const zoom=async()=>Number(await page.locator('.react-flow__viewport').evaluate(el=>el.style.transform.match(/scale\(([^)]+)\)/)[1]));
  const place=async id=>{
    const n=await node(id),b=await board(),rect=await page.getByTestId('canvas-surface').boundingBox();
    await page.evaluate(({boardId,viewport})=>window.tangent.invoke('board/update',{boardId,viewport}),{boardId:b.id,viewport:{x:rect.width/2-(n.position.x+n.width/2)*.77,y:rect.height/2-(n.position.y+n.height/2)*.77,zoom:.77}});
    await page.reload();await page.getByTestId(`card-${id}`).waitFor();await expect.poll(zoom).toBe(.77);
    await expect.poll(async()=>(await board()).viewport.zoom).toBe(.77);
  };
  const drag=async(id,direction,dx,dy,{stateDuring=false}={})=>{
    const before=await node(id),beforeFonts=await font(id),beforeZoom=await zoom(),card=page.getByTestId(`card-${id}`),grip=page.getByTestId(`resize-${direction}-${id}`);
    await grip.hover();const r=await grip.boundingBox();
    assert.ok(r&&r.width>=18&&r.height>=18,'The resize corner must present a generous target at77%');
    const x=r.x+r.width/2,y=r.y+r.height/2;
    const hit=await page.evaluate(({x,y})=>{const el=document.elementFromPoint(x,y);return {className:el?.className?.baseVal||el?.className,card:el?.closest('[data-testid^="card-"]')?.dataset.testid,testId:el?.closest('[data-testid]')?.dataset.testid}},{x,y});
    assert.equal(hit.card,`card-${id}`,`The actual pointer must reach the requested card's grip: ${JSON.stringify(hit)}`);
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx/2,y+dy/2,{steps:4});
    if(stateDuring){
      const halfway=await card.boundingBox();
      await page.evaluate(({boardId,nodeId})=>window.tangent.invoke('node/update',{boardId,nodeId,title:'Side question resized during a state update'}),{boardId:(await board()).id,nodeId:id});
      await page.waitForTimeout(80);const afterState=await card.boundingBox();
      assert.ok(Math.abs(halfway.width-afterState.width)<2&&Math.abs(halfway.height-afterState.height)<2,'Streaming/state reconciliation must not reset a live resize');
    }
    await page.mouse.move(x+dx,y+dy,{steps:4});await page.mouse.up();
    const expectedWidth=before.width+(direction==='nw'?-dx:dx)/beforeZoom,expectedHeight=before.height+(direction==='nw'?-dy:dy)/beforeZoom;
    await expect.poll(async()=>Math.abs((await node(id)).width-expectedWidth)).toBeLessThan(3);
    await expect.poll(async()=>Math.abs((await node(id)).height-expectedHeight)).toBeLessThan(3);
    const after=await node(id);
    if(direction==='nw'){
      assert.ok(Math.abs(after.position.x-before.position.x-dx/beforeZoom)<3);
      assert.ok(Math.abs(after.position.y-before.position.y-dy/beforeZoom)<3);
      assert.ok(Math.abs(after.position.x+after.width-before.position.x-before.width)<3,'The opposite corner stays fixed');
    }else assert.deepEqual(after.position,before.position);
    assert.equal(await zoom(),beforeZoom);assert.equal((await board()).viewport.zoom,.77);assert.deepEqual(await font(id),beforeFonts,'Changing a card size must not change body/composer font size');
    const rect=await card.boundingBox();assert.ok(Math.abs(rect.width-after.width*.77)<3&&Math.abs(rect.height-after.height*.77)<3,'Saved and visual dimensions agree');
    return after;
  };

  await launch();await page.getByTestId('new-chat').click();
  let main;await expect.poll(async()=>{main=(await board()).nodes.find(n=>n.kind==='chat');return !!main}).toBe(true);await page.waitForTimeout(450);
  await page.getByTestId(`composer-${main.id}`).fill('Reply exactly: Original forkable response.');await page.getByTestId(`send-${main.id}`).click();await idle(main.id);
  const reply=(await node(main.id)).messages.find(m=>m.role==='assistant');assert.ok(reply?.turnId);
  await page.getByTestId(`branch-${reply.id}`).click();
  let branch;await expect.poll(async()=>{branch=(await board()).nodes.find(n=>n.parentId===main.id&&n.kind==='chat');return !!branch?.threadId}).toBe(true);await page.waitForTimeout(500);
  await page.getByTestId(`composer-${branch.id}`).fill('Reply exactly: Independent branch response.');await page.getByTestId(`send-${branch.id}`).click();await idle(branch.id);
  assert.equal(branch.inheritedCount,2);
  await navigate(main.id);
  await page.getByTestId(`card-${main.id}`).getByTestId(`message-${reply.id}`).locator('.message-text').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}))});
  await page.getByTestId('selection-comment').click();await page.getByTestId('comment-question').fill('Reply exactly: Side question answered.');await page.getByTestId('submit-comment').click();
  let side;await expect.poll(async()=>{side=(await board()).nodes.find(n=>n.parentId===main.id&&n.kind==='comment');return side?.status}).toBe('idle');
  await place(side.id);
  await page.getByTestId(`composer-${side.id}`).fill('An unsent side-question draft survives resizing.');
  const parentBefore=await node(main.id),branchBefore=await node(branch.id);
  await drag(side.id,'se',110,95,{stateDuring:true});
  assert.deepEqual(await node(main.id),parentBefore);assert.deepEqual(await node(branch.id),branchBefore,'A side-card resize does not alter its sibling');
  await drag(side.id,'nw',-55,-45);
  const finalSide=await drag(side.id,'se',-45,-35);
  await expect(page.getByTestId(`composer-${side.id}`)).toHaveValue('An unsent side-question draft survives resizing.');
  await place(branch.id);
  await expect(page.getByTestId(`card-${branch.id}`)).not.toHaveClass(/is-selected/);
  await expect(page.getByTestId(`resize-se-${branch.id}`)).toBeVisible();
  await navigate(branch.id);await expect.poll(zoom).toBe(.77);
  const finalBranch=await drag(branch.id,'se',105,90);
  await close();await launch();
  for(const expected of [finalSide,finalBranch]){
    const saved=await node(expected.id);assert.deepEqual([saved.width,saved.height,saved.position],[expected.width,expected.height,expected.position]);
    await place(saved.id);const rect=await page.getByTestId(`card-${saved.id}`).boundingBox();assert.ok(Math.abs(rect.width-saved.width*.77)<3&&Math.abs(rect.height-saved.height*.77)<3);
  }
  await fs.mkdir(path.join(root,'screenshots'),{recursive:true});await page.screenshot({path:path.join(root,'screenshots/card-resize-77-percent.png')});
  const oversized=await page.evaluate(({boardId})=>window.tangent.invoke('node/create',{boardId,kind:'note',title:'Large canvas geometry check'}),{boardId:(await board()).id});
  await page.evaluate(({boardId,nodeId})=>window.tangent.invoke('node/update',{boardId,nodeId,width:4096,height:3072}),{boardId:(await board()).id,nodeId:oversized.id});
  await expect.poll(async()=>(await node(oversized.id)).width).toBe(4096);
  const largeRect=await page.getByTestId(`card-${oversized.id}`).boundingBox();
  assert.ok(Math.abs(largeRect.width-4096*.77)<3&&Math.abs(largeRect.height-3072*.77)<3,'Geometry above the former2000px limit renders at its saved size without snapping');
  assert.equal(await zoom(),.77);assert.deepEqual(errors,[]);
  t.diagnostic('Actual hidden Electron, native historical branch and quoted side question: independent expansion, contraction, north-west origin, streaming state, native fonts, unchanged77% zoom and relaunch persistence passed.');
});
