import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {_electron as electron,expect} from '@playwright/test';
import {CanvasStore,newBoard} from '../electron/store.mjs';
import {placePageCaretAtEnd} from './page-editor-helpers.mjs';

const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(root,'../../work/page-typing-performance-e2e');
const sourceDirectory=path.resolve(root,'../../work/native-page-source');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sample='A synthetic scientific result compares treatment and control conditions. **Keep mechanism and evidence separate.**\n\n| Measure | Evidence |\n| --- | --- |\n| Response | A repeatable change |\n\n';
const percentile=(values,p)=>values.length?Number([...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor(values.length*p))].toFixed(2)):0;

function seedCanvas(directory){
  const store=new CanvasStore(directory),board=store.state.boards[0];board.title='Synthetic Page typing performance';board.viewport={x:30,y:90,zoom:.5};
  board.nodes=Array.from({length:37},(_,index)=>({id:`page-perf-chat-${index}`,kind:'chat',title:`Synthetic closed conversation ${index+1}`,position:{x:index*500,y:0},width:440,height:500,collapsed:true,messages:Array.from({length:8},(_,n)=>({id:`page-perf-message-${index}-${n}`,role:n%2?'assistant':'user',text:sample.repeat(3),status:'completed'})),activities:[{id:`page-perf-result-${index}`,type:'mcpToolCall',title:'Completed synthetic lookup',status:'completed',result:sample.repeat(365)}],inheritedCount:0,queue:[],queuePaused:false,status:'idle',draft:'',model:'gpt-6.1-sol',effort:'low',permissionMode:'full',createdAt:1700000000000}));
  store.state.boards.push(newBoard('Synthetic archive 1'),newBoard('Synthetic archive 2'),newBoard('Synthetic archive 3'));store.touch();store.flush();return board.id;
}

test('rich Page body typing avoids per-keystroke full-canvas snapshots and retains local rich drafts',{timeout:70000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-page-typing-perf-'));
  await fs.mkdir(output,{recursive:true});
  const sourceBytes=await fs.readFile(path.join(sourceDirectory,'page.json')),commentsBytes=await fs.readFile(path.join(sourceDirectory,'comments.json'));
  const source=JSON.parse(sourceBytes),seed={page:structuredClone(source),comments:JSON.parse(commentsBytes)};
  const editable=seed.page.content.blocks.find(block=>block.kind==='markdown'&&block.markdown.length>70&&!/^(?:#|!|\||>|[-*]\s|\d+\.)/.test(block.markdown));assert.ok(editable);
  editable.markdown='Synthetic paragraph for Page typing performance.';editable.hash=sha(editable.markdown);
  const remoteState=path.join(folder,'remote.json'),control=path.join(folder,'control.json'),directory=path.join(folder,'data');
  await fs.writeFile(remoteState,JSON.stringify(seed));await fs.writeFile(control,'{}');
  const boardId=seedCanvas(directory),proof={fixtureOnly:true,sourceImmutable:true,hidden:true,foregroundInteraction:false,phases:[],rendererErrors:[]};
  let app,page,nodeId;
  const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.tangent.invoke(command,payload),{command,payload});
  const node=()=>invoke('app/state').then(state=>state.boards.find(board=>board.id===boardId).nodes.find(node=>node.id===nodeId));
  const close=async()=>{if(!app)return;const current=app;app=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  t.after(async()=>{await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');await close();await fs.rm(folder,{recursive:true,force:true})});
  app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:directory,TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'threads.json'),TANGENT_PAGE_FIXTURE_DIR:sourceDirectory,TANGENT_PAGE_FIXTURE_STATE:remoteState,TANGENT_PAGE_FIXTURE_CONTROL:control,TANGENT_PAGE_FIXTURE_LOG:path.join(folder,'tools.jsonl')}});
  page=await app.firstWindow();page.setDefaultTimeout(8000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));await page.getByTestId('canvas-surface').waitFor();
  await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
  const linked=await invoke('page/link',{boardId,url:source.metadata.url,title:'Synthetic Page body typing fixture'});nodeId=linked.id;
  await expect.poll(async()=>(await node()).pageSyncStatus,{timeout:20000}).toBe('ready');
  await page.locator('.outline-list > button').filter({hasText:(await node()).title}).first().click();
  const shell=page.getByTestId(`page-focus-${nodeId}`);await expect(shell).toBeVisible();
  if(await shell.getAttribute('data-page-mode')!=='full')await page.getByTestId(`page-view-toggle-${nodeId}`).click();
  const block=shell.getByTestId(`page-block-${editable.id}`);await expect(shell.getByRole('textbox',{name:'Page document',exact:true})).toHaveAttribute('contenteditable','true');
  await placePageCaretAtEnd(page,block);await page.waitForTimeout(400);
  const state=await invoke('app/state');proof.fixture={bytes:Buffer.byteLength(JSON.stringify(state)),boards:state.boards.length,cards:state.boards.flatMap(b=>b.nodes).length,synthetic:true};assert.ok(proof.fixture.bytes>=2700000);assert.equal(proof.fixture.cards,38);
  // Isolate local typing checkpoint cost from remote-save responses. Only the
  // temporary fixture peer becomes offline; the real Page is never contacted.
  await fs.writeFile(control,JSON.stringify({offline:true}));proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  await app.evaluate(({BrowserWindow,ipcMain},{storePath})=>{
    const require=process.getBuiltinModule('module').createRequire(process.cwd()+'/'),{CanvasStore}=require(storePath),w=BrowserWindow.getAllWindows()[0];
    const initial=()=>({draftCommands:0,commands:0,stateEvents:0,stateBytes:0,compactEvents:0,compactBytes:0,flushCount:0,flushMs:[]});const tracker=globalThis.__pageTypingPerf={stats:initial(),reset(){this.stats=initial()}};
    const flush=CanvasStore.prototype.flush;CanvasStore.prototype.flush=function(...args){const dirty=this.dirty,start=performance.now();try{return flush.apply(this,args)}finally{if(dirty){tracker.stats.flushCount++;tracker.stats.flushMs.push(performance.now()-start)}}};
    const handler=ipcMain._invokeHandlers.get('tangent:invoke');ipcMain.removeHandler('tangent:invoke');ipcMain.handle('tangent:invoke',(event,command,payload)=>{if(command!=='app/state'&&command!=='app/connection'){tracker.stats.commands++;if(command==='page/draft')tracker.stats.draftCommands++}return handler(event,command,payload)});
    const send=w.webContents.send.bind(w.webContents);w.webContents.send=(channel,...args)=>{if(channel==='tangent:event'){const event=args[0],bytes=Buffer.byteLength(JSON.stringify(event));if(event?.type==='state'){tracker.stats.stateEvents++;tracker.stats.stateBytes+=bytes}else{tracker.stats.compactEvents++;tracker.stats.compactBytes+=bytes}}return send(channel,...args)};
  },{storePath:path.join(root,'electron/store.mjs')});
  await page.evaluate(()=>{
    const initial=()=>({inputEvents:0,trustedInputEvents:0,frameMs:[],longTasks:[]});const tracker=window.__pageTypingPerf={stats:initial(),reset(){this.stats=initial()}};
    document.addEventListener('input',event=>{if(!event.target.closest?.('.page-rich-editor'))return;const stats=tracker.stats,start=performance.now();stats.inputEvents++;if(event.isTrusted)stats.trustedInputEvents++;requestAnimationFrame(()=>stats.frameMs.push(performance.now()-start))},true);
    try{new PerformanceObserver(list=>list.getEntries().forEach(entry=>tracker.stats.longTasks.push(entry.duration))).observe({type:'longtask',buffered:false})}catch{}
  });
  let suffix='';
  for(const phase of [{name:'burst',text:' A quick rich-text edit.',delay:90}]){
    await app.evaluate(()=>globalThis.__pageTypingPerf.reset());await page.evaluate(()=>window.__pageTypingPerf.reset());
    const start=Date.now();await page.keyboard.type(phase.text,{delay:phase.delay});suffix+=phase.text;await expect(block).toContainText(suffix);
    await page.waitForTimeout(1200);
    const main=await app.evaluate(()=>structuredClone(globalThis.__pageTypingPerf.stats)),renderer=await page.evaluate(()=>structuredClone(window.__pageTypingPerf.stats));
    const record={name:phase.name,characters:phase.text.length,delayMs:phase.delay,elapsedMs:Date.now()-start,...main,...renderer,inputFrameP95Ms:percentile(renderer.frameMs,.95),flushP95Ms:percentile(main.flushMs,.95),longestTaskMs:percentile(renderer.longTasks,1)};proof.phases.push(record);
    await page.screenshot({path:path.join(output,`${phase.name}.png`)});t.diagnostic(JSON.stringify({phase:phase.name,characters:record.characters,pageDraftCommands:record.draftCommands,fullStateEvents:record.stateEvents,fullStateMiB:Number((record.stateBytes/1048576).toFixed(2)),flushes:record.flushCount,inputFrameP95Ms:record.inputFrameP95Ms,flushP95Ms:record.flushP95Ms,longestTaskMs:record.longestTaskMs}));
  }
  const expected=editable.markdown+suffix;
  const saved=JSON.parse(await fs.readFile(path.join(directory,'canvas-state.json'),'utf8')).boards.find(board=>board.id===boardId).nodes.find(node=>node.id===nodeId);
  assert.equal(saved.pageDrafts[editable.id].markdown,expected);assert.ok(saved.pageDrafts[editable.id].editorJSON);proof.latestRichDraftDurable=true;
  const remote=JSON.parse(await fs.readFile(remoteState,'utf8'));assert.equal(remote.page.content.blocks.find(block=>block.id===editable.id).markdown,editable.markdown);assert.equal(sha(await fs.readFile(path.join(sourceDirectory,'page.json'))),sha(sourceBytes));assert.equal(sha(await fs.readFile(path.join(sourceDirectory,'comments.json'))),sha(commentsBytes));
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});assert.deepEqual(proof.rendererErrors,[]);
  // The final rich-text keystrokes must be checkpointed by normal shutdown,
  // without a blur, view change, explicit save, or idle-debounce wait.
  const finalSuffix=' Final rich keypress before quit.';
  await placePageCaretAtEnd(page,block);await page.keyboard.type(finalSuffix,{delay:2});
  const lastKeyCompletedAt=Date.now();proof.quitRequestedAfterLastKeyMs=Date.now()-lastKeyCompletedAt;
  await close();
  const closedState=JSON.parse(await fs.readFile(path.join(directory,'canvas-state.json'),'utf8'));
  const closedNode=closedState.boards.find(board=>board.id===boardId).nodes.find(node=>node.id===nodeId);
  assert.equal(closedNode.pageDrafts[editable.id].markdown,expected+finalSuffix,'Normal quit must retain the newest rich Page text even before idle saving.');
  assert.ok(JSON.stringify(closedNode.pageDrafts[editable.id].editorJSON).includes(finalSuffix),'Normal quit must retain the matching rich editor JSON.');
  proof.finalRichKeystrokesDurableOnNormalQuit=true;
  await fs.writeFile(path.join(output,'proof.json'),JSON.stringify(proof,null,2)+'\n');
  for(const phase of proof.phases){assert.equal(phase.trustedInputEvents,phase.characters);assert.ok(phase.stateEvents<=3,`${phase.name}: local Page body typing must not transfer the entire canvas for each keystroke (${phase.stateEvents} snapshots, ${phase.stateBytes} bytes)`)}
  proof.passed=true;
});
