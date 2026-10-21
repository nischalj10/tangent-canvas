import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {_electron as electron,expect} from '@playwright/test';
import {CanvasStore,newBoard} from '../electron/store.mjs';

const root=path.resolve(import.meta.dirname,'..');
const output=path.resolve(root,'../../work/typing-performance-e2e');
const sample='A controlled experiment compares measured treatment and control conditions. **Keep the mechanism and evidence separate.**\n\n| Measure | Interpretation |\n| --- | --- |\n| Response | A repeatable change |\n\n';
const percentile=(values,p)=>values.length?Number([...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))].toFixed(2)):0;

function syntheticState(directory){
  const store=new CanvasStore(directory),board=store.state.boards[0];
  board.title='Synthetic typing performance canvas';board.viewport={x:30,y:90,zoom:1};
  board.nodes=Array.from({length:38},(_,index)=>({
    id:`perf-chat-${index}`,kind:index===0?'chat':'comment',title:`Synthetic research conversation ${index+1}`,
    position:{x:(index%7)*500,y:Math.floor(index/7)*650},width:440,height:560,collapsed:index!==0,
    messages:Array.from({length:index<34?8:7},(_,message)=>({id:`perf-message-${index}-${message}`,role:message%2?'assistant':'user',text:sample.repeat(3),status:'completed',createdAt:1700000000000+message})),
    // Completed tool results are retained in ordinary histories but stay closed.
    // This synthetic payload matches the user's state size without reading it.
    activities:[{id:`perf-activity-${index}`,type:'mcpToolCall',title:'Completed synthetic research lookup',status:'completed',result:sample.repeat(320)}],
    inheritedCount:0,queue:[],queuePaused:false,status:'idle',draft:'',model:'gpt-6.1-sol',effort:'low',permissionMode:'full',createdAt:1700000000000,
  }));
  store.state.boards.push(newBoard('Synthetic archive 1'),newBoard('Synthetic archive 2'),newBoard('Synthetic archive 3'));
  store.touch();store.flush();return{boardId:board.id,nodeId:board.nodes[0].id,bytes:Buffer.byteLength(JSON.stringify(store.state)),cards:board.nodes.length,messages:board.nodes.reduce((n,c)=>n+c.messages.length,0)};
}

test('typing keeps draft autosave local, avoids whole-canvas snapshots, and retains durable drafts',{timeout:90000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-typing-performance-'));
  await fs.mkdir(output,{recursive:true});
  const directory=path.join(folder,'data'),fixture=syntheticState(directory);
  assert.ok(fixture.bytes>=2500000,'The synthetic fixture represents a multi-megabyte canvas');
  const proof={fixture:{...fixture,synthetic:true},hidden:true,foregroundInteraction:false,phases:[],rendererErrors:[]};
  let application,page;
  const close=async()=>{if(!application)return;const current=application;application=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  t.after(async()=>{await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');await close();await fs.rm(folder,{recursive:true,force:true})});
  const launch=async()=>{
    application=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:directory,TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'peer.json')}});
    page=await application.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));
    await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection'))).toMatchObject({connected:true});
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
    await page.getByTestId(`chat-focus-open-${fixture.nodeId}`).click();
    await expect(page.getByTestId(`chat-fullscreen-${fixture.nodeId}`)).toBeVisible();
    await expect(page.locator('.saved-label:visible').first()).toContainText('On this Mac');
    await page.waitForTimeout(400);
  };
  await launch();proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  await application.evaluate(async({BrowserWindow,ipcMain},{storePath})=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/');
    const {CanvasStore}=require(storePath),w=BrowserWindow.getAllWindows()[0];
    const initial=()=>({commands:[],stateEvents:0,stateBytes:0,compactEvents:0,compactEventBytes:0,persistenceEvents:0,snapshotMs:[],flushMs:[],flushCount:0});
    const tracker=globalThis.__typingPerf={stats:initial(),reset(){this.stats=initial()}};
    const snapshot=CanvasStore.prototype.snapshot,flush=CanvasStore.prototype.flush;
    CanvasStore.prototype.snapshot=function(...args){tracker.store=this;const start=performance.now();try{return snapshot.apply(this,args)}finally{tracker.stats.snapshotMs.push(performance.now()-start)}};
    CanvasStore.prototype.flush=function(...args){tracker.store=this;const dirty=this.dirty,start=performance.now();try{return flush.apply(this,args)}finally{if(dirty){tracker.stats.flushCount++;tracker.stats.flushMs.push(performance.now()-start)}}};
    const handler=ipcMain._invokeHandlers.get('tangent:invoke');ipcMain.removeHandler('tangent:invoke');
    ipcMain.handle('tangent:invoke',(event,command,payload)=>{if(command!=='app/connection'&&command!=='app/state')tracker.stats.commands.push({command,keys:Object.keys(payload),draftLength:typeof payload.draft==='string'?payload.draft.length:undefined});return handler(event,command,payload)});
    const send=w.webContents.send.bind(w.webContents);w.webContents.send=(channel,...args)=>{if(channel==='tangent:event'){const event=args[0];if(event?.type==='state'){tracker.stats.stateEvents++;tracker.stats.stateBytes+=Buffer.byteLength(JSON.stringify(event))}if(event?.type!=='state'){tracker.stats.compactEvents++;tracker.stats.compactEventBytes+=Buffer.byteLength(JSON.stringify(event))}if(event?.type==='persistence')tracker.stats.persistenceEvents++}return send(channel,...args)};
  },{storePath:path.join(root,'electron/store.mjs')});
  await page.evaluate(({nodeId})=>{
    const initial=()=>({inputEvents:0,trustedEvents:0,inputFrameMs:[],longTasks:[],saveLabels:[],messageMutations:0});
    const tracker=window.__typingPerf={stats:initial(),reset(){this.stats=initial()}};
    document.addEventListener('input',event=>{if(event.target?.dataset?.testid!==`composer-${nodeId}`)return;const stats=tracker.stats,start=performance.now();stats.inputEvents++;if(event.isTrusted)stats.trustedEvents++;requestAnimationFrame(()=>stats.inputFrameMs.push(performance.now()-start))},true);
    try{new PerformanceObserver(list=>{for(const entry of list.getEntries())tracker.stats.longTasks.push(entry.duration)}).observe({type:'longtask',buffered:false})}catch{}
    new MutationObserver(records=>{for(const record of records){const target=record.target.nodeType===Node.ELEMENT_NODE?record.target:record.target.parentElement;if(target?.closest('.saved-label')){const label=document.querySelector('.saved-label')?.textContent?.trim();if(label&&label!==tracker.stats.saveLabels.at(-1))tracker.stats.saveLabels.push(label)}if(target?.closest('.message-text'))tracker.stats.messageMutations++}}).observe(document.body,{subtree:true,childList:true,characterData:true});
  },fixture);
  const composer=()=>page.getByTestId(`chat-fullscreen-${fixture.nodeId}`).getByTestId(`composer-${fixture.nodeId}`);
  for(const phase of [{name:'burst',text:'A quick question about the diagram.',delay:90},{name:'sustained',text:' Now explain this.',delay:360}]){
    await application.evaluate(()=>globalThis.__typingPerf.reset());await page.evaluate(()=>window.__typingPerf.reset());
    const start=Date.now();await composer().pressSequentially(phase.text,{delay:phase.delay});await page.waitForTimeout(1500);
    const main=await application.evaluate(()=>structuredClone(globalThis.__typingPerf.stats));
    const renderer=await page.evaluate(()=>structuredClone(window.__typingPerf.stats));
    const record={name:phase.name,characters:phase.text.length,delayMs:phase.delay,elapsedMs:Date.now()-start,...main,...renderer};
    record.inputFrameP95Ms=percentile(renderer.inputFrameMs,.95);record.longestTaskMs=percentile(renderer.longTasks,1);record.flushP95Ms=percentile(main.flushMs,.95);record.snapshotP95Ms=percentile(main.snapshotMs,.95);
    proof.phases.push(record);await page.screenshot({path:path.join(output,`${phase.name}.png`)});
    t.diagnostic(JSON.stringify({phase:phase.name,characters:record.characters,commands:record.commands.length,fullStateEvents:record.stateEvents,fullStateMiB:Number((record.stateBytes/1048576).toFixed(2)),flushes:record.flushCount,saveLabelTransitions:record.saveLabels.length,inputFrameP95Ms:record.inputFrameP95Ms,longestTaskMs:record.longestTaskMs}));
  }
  const expected='A quick question about the diagram. Now explain this.';
  await expect(composer()).toHaveValue(expected);
  await expect.poll(async()=>{const saved=JSON.parse(await fs.readFile(path.join(directory,'canvas-state.json'),'utf8'));return saved.boards.find(b=>b.id===fixture.boardId).nodes.find(n=>n.id===fixture.nodeId).draft}).toBe(expected);
  // Remounting and ordinary app quit must retain a draft, even when its final
  // keypress is inside the idle debounce window.
  await composer().pressSequentially(' Retain this final edit.',{delay:12});
  const remountedDraft=expected+' Retain this final edit.';
  await page.getByTestId('chat-focus-back').click();await page.getByTestId(`chat-focus-open-${fixture.nodeId}`).click();await expect(composer()).toHaveValue(remountedDraft);proof.draftDurability={remount:true};
  // Do not blur/unmount or wait for an idle save before ordinary quit.
  await composer().evaluate(el=>el.setSelectionRange(el.value.length,el.value.length));
  await composer().pressSequentially(' Final keypress before quit.',{delay:12});
  const finalDraft=remountedDraft+' Final keypress before quit.';
  await close();await launch();await expect(composer()).toHaveValue(finalDraft);proof.draftDurability.normalQuitWithoutIdleWait=true;
  // A message submitted before idle debounce must use the visible draft, and
  // the submitted text must never return as a later autosave.
  await composer().evaluate(el=>el.setSelectionRange(el.value.length,el.value.length));
  await composer().pressSequentially(' Send this exact draft.',{delay:12});
  const sent=finalDraft+' Send this exact draft.';
  await composer().press('Enter');await expect(composer()).toHaveValue('');
  await expect.poll(()=>page.evaluate(({boardId,nodeId})=>window.tangent.invoke('app/state').then(s=>s.boards.find(b=>b.id===boardId).nodes.find(n=>n.id===nodeId).messages.filter(m=>m.role==='user').at(-1).text),fixture)).toBe(sent);
  await expect.poll(async()=>{const saved=JSON.parse(await fs.readFile(path.join(directory,'canvas-state.json'),'utf8'));return saved.boards.find(b=>b.id===fixture.boardId).nodes.find(n=>n.id===fixture.nodeId).draft}).toBe('');proof.draftDurability.sendBeforeIdle=true;
  assert.deepEqual(await application.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  assert.deepEqual(proof.rendererErrors,[]);
  await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  for(const phase of proof.phases){
    assert.equal(phase.trustedEvents,phase.characters,'Typing uses trusted Chromium key input');
    assert.equal(phase.stateEvents,0,'Draft checkpoints must not send whole-canvas snapshots');
    assert.ok(phase.commands.length<phase.characters/2,'Continuous input must coalesce draft checkpoints');
    assert.equal(phase.saveLabels.length,0,'The global save label stays still while typing');
    assert.ok(phase.stateEvents<=2,`${phase.name}: draft-only typing must not repeatedly transfer the entire canvas (${phase.stateEvents} full snapshots, ${phase.stateBytes} bytes)`);
    assert.ok(phase.saveLabels.length<=2,`${phase.name}: draft typing must not flash global saving status for each character`);
    assert.equal(phase.messageMutations,0,'Typing a draft must not rewrite existing rendered message content');
  }
  proof.passed=true;
});
