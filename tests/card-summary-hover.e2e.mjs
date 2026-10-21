import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {CanvasStore,newBoard} from '../electron/store.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const proofDirectory=path.resolve(root,'../../work/card-summary-hover-e2e');
const summaryText='A controlled experiment compares treatment with an otherwise identical control and measures the same biological response. The result supports a specific conclusion while preserving uncertainty about alternative mechanisms and future experiments.';
const base=(id,kind,position,fields={})=>({id,kind,title:`Readable ${kind} summary`,position,width:440,height:420,inheritedCount:0,messages:[],activities:[],queue:[],queuePaused:false,status:'idle',draft:'',createdAt:1700000000000,summary:{status:'ready',text:`${id}: ${summaryText}`,model:'gpt-6-luna',effort:'low',fast:true,generatedAt:1700000000000},...fields});
const pageFields={pageUrl:'https://chatgpt.com/space/page_HoverSummaryFixture',pageSyncStatus:'ready',pageView:'full',pageSnapshot:{title:'A connected biology Page',blocks:[{id:'summary-hover-page-block',hash:'summary-hover-hash',markdown:'# Biological experiments\n\nA measured comparison reveals an effect while preserving uncertainty about its mechanism.'}],media:[],commentThreads:[]}};

test('whole-card summary hover stays readable at25% and100%, clamps to the workspace, and never starts inference',{timeout:70000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-summary-hover-'));
  await fs.mkdir(proofDirectory,{recursive:true});
  const data=path.join(folder,'data'),rpcLog=path.join(folder,'rpc.jsonl'),store=new CanvasStore(data);
  const overview=store.state.boards[0];overview.title='Overview hover';overview.viewport={x:30,y:110,zoom:.25};
  overview.nodes=[
    base('hover_chat','chat',{x:20,y:20},{collapsed:true,threadId:'external-source',draft:'Keep this original draft.',model:'gpt-6-sol',effort:'high',permissionMode:'ask',messages:[{id:'hover-u',role:'user',text:'Compare a treatment with its control.',status:'completed'},{id:'hover-a',role:'assistant',text:'Measure both using the same assay.',status:'completed'}]}),
    base('hover_comment','comment',{x:520,y:20},{parentId:'hover_chat',quote:'Measure both using the same assay.',messages:[{id:'hover-comment-u',role:'user',text:'What does the control establish?',status:'completed'},{id:'hover-comment-a',role:'assistant',text:'It establishes a comparable baseline.',status:'completed'}]}),
    base('hover_note','note',{x:1020,y:20},{noteText:'A measurement and a matched control.'}),
    base('hover_document','document',{x:1520,y:20},{documentMarkdown:'# An experiment\n\nMeasure the response in both conditions.',documentRevision:1}),
    base('hover_page','page',{x:2020,y:20},pageFields),
    base('hover_empty','note',{x:2520,y:20},{noteText:'No generated summary yet.',summary:undefined}),
  ];overview.edges=[{id:'hover-edge',source:'hover_chat',target:'hover_comment',kind:'comment'}];
  const actual=newBoard('Actual size hover');actual.viewport={x:20,y:80,zoom:1};
  actual.nodes=[
    base('actual_chat','chat',{x:20,y:20},{draft:'Keep the actual-size draft.',messages:[{id:'actual-u',role:'user',text:'An existing question.',status:'completed'},{id:'actual-a',role:'assistant',text:'An existing answer.',status:'completed'}]}),
    base('actual_note','note',{x:620,y:20},{noteText:'The same summary should remain native size.'}),
    base('edge_note','note',{x:720,y:520},{width:600,height:400,noteText:'A partly visible card close to the bottom-right viewport edge.'}),
  ];store.state.boards.push(actual);store.touch();store.flush();
  let app,page;const errors=[],proof={hidden:true,foregroundInteraction:false,fixtureBackend:true,hoverChecks:[],screenshots:[]};
  const close=async()=>{const current=app;app=null;if(!current)return;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  const state=()=>page.evaluate(()=>window.tangent.invoke('app/state'));
  const board=async()=>{const s=await state();return s.boards.find(item=>item.id===s.activeBoardId)};
  const viewport=()=>page.locator('.react-flow__viewport').evaluate(el=>{const m=new DOMMatrixReadOnly(getComputedStyle(el).transform);return{x:m.e,y:m.f,zoom:m.a}});
  const hover=()=>page.getByTestId('card-summary-hover');
  const wrapper=id=>page.locator(`.react-flow__node[data-id="${id}"]`);
  const screenshot=async name=>{const file=path.join(proofDirectory,name);await page.screenshot({path:file});proof.screenshots.push(file)};
  const resize=async(width,height)=>{await app.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows()[0].setContentSize(width,height),{width,height});await expect.poll(()=>page.evaluate(()=>[innerWidth,innerHeight])).toEqual([width,height])};
  const leave=async()=>{const pane=await page.getByTestId('canvas-surface').boundingBox();await page.mouse.move(pane.x+12,pane.y+pane.height-140);await expect(hover()).toHaveCount(0)};
  const enter=async(id,{header=false,point}={})=>{
    if(!point){const card=wrapper(id),bounds=await card.boundingBox();assert.ok(bounds);const headerBounds=await card.locator('.card-header').boundingBox();point={x:bounds.x+Math.min(bounds.width-5,header?Math.min(45,bounds.width/2):bounds.width*.4),y:header?headerBounds.y+headerBounds.height/2:bounds.y+Math.min(bounds.height-5,Math.max((headerBounds.y+headerBounds.height-bounds.y)+5,bounds.height*.5))}}
    await page.mouse.move(point.x,point.y);await expect(hover()).toBeVisible();await expect(hover()).toHaveAttribute('data-node-id',id);return point;
  };
  const measure=async id=>{
    const expected=(await board()).nodes.find(node=>node.id===id);await expect(hover().getByTestId('card-summary-hover-text')).toHaveText(expected.summary.text);await expect(hover()).toContainText(expected.title);
    const metrics=await hover().evaluate(el=>{const p=el.querySelector('p'),r=el.getBoundingClientRect(),s=getComputedStyle(p),m=new DOMMatrixReadOnly(getComputedStyle(el).transform),surface=document.querySelector('[data-testid="canvas-surface"]').getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,fontSize:s.fontSize,lineHeight:s.lineHeight,clamp:s.webkitLineClamp,textHeight:p.clientHeight,textScrollHeight:p.scrollHeight,overflowX:el.scrollWidth-el.clientWidth,scale:m.a,parent:el.parentElement.tagName,workspaceLeft:surface.left,workspaceTop:surface.top,viewport:{width:innerWidth,height:innerHeight}}});
    assert.equal(metrics.fontSize,'14px');assert.equal(metrics.lineHeight,'22px');assert.equal(metrics.scale,1,'Canvas zoom cannot scale the hover summary');assert.equal(metrics.parent,'BODY','The hover must escape the React Flow transformed viewport');assert.ok(metrics.clamp==='none'||metrics.clamp==='0','The hover exposes the full saved summary');assert.equal(metrics.textHeight,metrics.textScrollHeight,'The complete summary must not be clipped');assert.ok(metrics.textHeight>=66,'This fixture genuinely exceeds the two-line in-card preview');assert.ok(metrics.overflowX<=1);assert.ok(metrics.x>=metrics.workspaceLeft+11&&metrics.y>=metrics.workspaceTop+11,'Summary hover stays inside the canvas workspace');assert.ok(metrics.right<=metrics.viewport.width-11&&metrics.bottom<=metrics.viewport.height-11,'Summary hover stays inside the right and bottom viewport edges');
    proof.hoverChecks.push({id,zoom:(await viewport()).zoom,...metrics});return metrics;
  };
  t.after(async()=>{if(app){try{proof.dragEvents=await page.evaluate(()=>window.__summaryDragEvents||[]);proof.lastHover=await hover().count()?await hover().getAttribute('data-node-id'):null;await screenshot('last-state.png');await fs.writeFile(path.join(proofDirectory,'state.json'),JSON.stringify(await state(),null,2)+'\n')}catch{}}try{await fs.copyFile(rpcLog,path.join(proofDirectory,'rpc.jsonl'))}catch{}await fs.writeFile(path.join(proofDirectory,'proof.json'),JSON.stringify({...proof,rendererErrors:errors},null,2)+'\n');await close();await fs.rm(folder,{recursive:true,force:true})});
  app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:data,TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'peer.json'),TANGENT_FIXTURE_RPC_LOG:rpcLog}});page=await app.firstWindow();page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection'))).toMatchObject({connected:true});await resize(1440,1000);
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  await page.evaluate(()=>{window.__summaryHoverInputs=[];document.querySelector('[data-testid="canvas-surface"]').addEventListener('pointerover',event=>{const el=event.target.closest?.('.react-flow__node[data-id]');if(el)window.__summaryHoverInputs.push({type:'pointerover',id:el.dataset.id,trusted:event.isTrusted})})});
  await expect.poll(async()=>(await viewport()).zoom).toBe(.25);await leave();const originalNodes=(await state()).boards.map(item=>({id:item.id,nodes:item.nodes,edges:item.edges})),originalViewport=await viewport(),rpcBefore=await fs.readFile(rpcLog,'utf8');
  await enter('hover_chat',{header:true});await measure('hover_chat');await expect(wrapper('hover_chat')).toHaveAttribute('aria-describedby',/(?:^|\s)canvas-card-summary-hover(?:\s|$)/);await screenshot('hover-collapsed-chat-25.png');
  // Crossing the small anchor-to-popup gap must not dismiss the summary while
  // the pointer is selecting or reading its full text.
  const popup=await hover().boundingBox();await page.mouse.move(popup.x+popup.width/2,popup.y+popup.height/2);await page.waitForTimeout(400);await expect(hover()).toBeVisible();await leave();await expect(wrapper('hover_chat')).not.toHaveAttribute('aria-describedby',/canvas-card-summary-hover/);
  for(const id of ['hover_comment','hover_note','hover_document','hover_page']){await enter(id);await measure(id);await leave()}
  await enter('hover_comment',{header:true});await measure('hover_comment');await screenshot('hover-expanded-chat-25.png');await page.keyboard.press('Escape');await expect(hover()).toHaveCount(0);await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await leave();
  const empty=await wrapper('hover_empty').boundingBox();await page.mouse.move(empty.x+empty.width/2,empty.y+empty.height/2);await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);
  assert.deepEqual((await state()).boards.map(item=>({id:item.id,nodes:item.nodes,edges:item.edges})),originalNodes,'Hovering must preserve histories, drafts, card geometry, settings, and saved summaries');assert.deepEqual(await viewport(),originalViewport,'Hovering cannot change the canvas camera');assert.equal(await fs.readFile(rpcLog,'utf8'),rpcBefore,'Hovering reads saved summaries without any native RPC or new inference');
  // Keyboard navigation exposes the same text on the node itself, while
  // editing an ordinary chat composer must not open a tooltip.
  await page.keyboard.press('Tab');await wrapper('hover_comment').evaluate(el=>el.focus({preventScroll:true}));await expect(hover()).toBeVisible();await expect(hover()).toHaveAttribute('data-node-id','hover_comment');await page.keyboard.press('Escape');await expect(hover()).toHaveCount(0);await page.getByTestId('composer-hover_comment').focus();await page.waitForTimeout(350);await expect(hover()).toHaveCount(0);await wrapper('hover_comment').evaluate(el=>el.blur());
  await page.getByTestId(`board-${actual.id}`).click();await expect.poll(async()=>(await board()).id).toBe(actual.id);await expect.poll(async()=>(await viewport()).zoom).toBe(1);await leave();
  for(const id of ['actual_chat','actual_note']){await enter(id);await measure(id);await leave()}
  const edgeRect=await wrapper('edge_note').boundingBox();await enter('edge_note',{point:{x:Math.min(1415,edgeRect.x+edgeRect.width-10),y:Math.min(905,edgeRect.y+edgeRect.height-10)}});await measure('edge_note');await screenshot('hover-bottom-right-100.png');
  await resize(1024,768);await expect(hover()).toHaveCount(0);await leave();const narrowRect=await wrapper('edge_note').boundingBox();await enter('edge_note',{point:{x:Math.min(1008,narrowRect.x+narrowRect.width-10),y:Math.min(685,narrowRect.y+narrowRect.height-10)}});await measure('edge_note');await screenshot('hover-bottom-right-1024.png');await leave();await resize(1440,1000);
  // A pointerdown or wheel dismisses immediately and stays dismissed until a
  // deliberate re-entry, even though the pointer still rests on the card.
  const notePoint=await enter('actual_note');await page.mouse.down();await expect(hover()).toHaveCount(0);await page.mouse.up();await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await leave();await enter('actual_note',{point:notePoint});await page.mouse.wheel(0,80);await expect(hover()).toHaveCount(0);await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await leave();
  await page.evaluate(()=>{window.__summaryDragEvents=[];for(const type of ['pointerover','pointerout','pointerdown','pointerup','focusin','focusout'])document.addEventListener(type,event=>window.__summaryDragEvents.push({type,trusted:event.isTrusted,id:event.target.closest?.('.react-flow__node[data-id]')?.dataset.id,target:event.target.tagName,related:event.relatedTarget?.tagName,buttons:event.buttons,point:{x:event.clientX,y:event.clientY},modality:document.documentElement.dataset.inputModality,time:performance.now()}),true)});
  for(let drag=0;drag<3;drag++){
    const beforeDrag=(await board()).nodes.find(node=>node.id==='actual_chat').position;
    const freeHeader=await wrapper('actual_chat').locator('.card-header').evaluate(el=>{const r=el.getBoundingClientRect();for(const y of [r.top+6,r.top+r.height/2,r.bottom-5])for(let x=r.left+10;x<r.right-10;x+=8){const hit=document.elementFromPoint(x,y);if(hit?.closest('.card-header')===el&&!hit.closest('input,button,textarea,select,.nodrag'))return{x,y}}throw Error('No exposed draggable header point')});
    const dragPoint=await enter('actual_chat',{point:freeHeader});await page.mouse.down();await expect(hover()).toHaveCount(0);await page.mouse.move(dragPoint.x+48,dragPoint.y+26,{steps:6});await page.mouse.up();await expect.poll(async()=>(await board()).nodes.find(node=>node.id==='actual_chat').position.x).not.toBe(beforeDrag.x);await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await leave();
  }
  proof.successiveHeldDragsWithoutTooltipReopening=3;
  await enter('actual_chat');await page.getByTestId('chat-focus-open-actual_chat').click();await expect(page.getByTestId('chat-fullscreen-actual_chat')).toBeVisible();await page.getByTestId('chat-fullscreen-actual_chat').hover();await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await page.getByTestId('chat-focus-back').click();await expect(page.getByTestId('chat-fullscreen-actual_chat')).toHaveCount(0);
  await leave();await enter('actual_note');await page.keyboard.press('Meta+k');await expect(page.getByRole('dialog',{name:'Find a card',exact:true})).toBeVisible();await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await page.keyboard.press('Escape');
  await page.getByTestId(`board-${overview.id}`).click();await expect.poll(async()=>(await board()).id).toBe(overview.id);await expect.poll(async()=>(await viewport()).zoom).toBe(.25);await leave();await enter('hover_page');await page.getByTestId('page-focus-open-hover_page').click();await expect(page.getByTestId('page-focus-hover_page')).toBeVisible();await page.getByTestId('page-focus-hover_page').locator('.rich-page-document').hover();await page.waitForTimeout(400);await expect(hover()).toHaveCount(0);await page.getByTestId('page-focus-back').click();await expect(page.getByTestId('page-focus-hover_page')).toBeHidden();
  const inputs=await page.evaluate(()=>window.__summaryHoverInputs);assert.ok(inputs.length>=8);assert.ok(inputs.every(input=>input.trusted),'Every exercised hover must arrive through real Chromium pointer input');assert.deepEqual(errors,[]);assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  Object.assign(proof,{passed:true,rendererBundle:await page.locator('script[type="module"]').getAttribute('src'),trustedPointerInputs:inputs.length,keyboardNodeFocus:true,fullSavedTextReadable:true,noInferenceOnHover:true,allCardKindsAt25:true,viewportClampingAt1024And1440:true,summaryHoverSuppressedFor:['pointerdown','wheel','Escape','drag','viewport resize','fullscreen chat','search modal','Page reader'],hoverContentAndGeometryUnchanged:true});
  t.diagnostic('Existing full summaries shown by trusted whole-card hover at25% and100%; native14px/22px text, keyboard node focus, popup reading, viewport clamping and interaction dismissal verified in a hidden isolated Electron profile.');
});
