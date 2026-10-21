import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {_electron as electron,expect} from '@playwright/test';
import {selectPageText,nativePageShortcut} from './page-editor-helpers.mjs';

const root=path.resolve(import.meta.dirname,'..');
const sourceDirectory=path.resolve(root,'../../work/native-page-source');
const output=path.resolve(root,'../../work/page-passage-actions-e2e');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const quote='chemical building blocks';
const replacementQuote='whole human being';

// All state, Codex threads and Page tools below belong to disposable local
// peers. Pointer input selects real rendered prose; no range is installed by JS.
async function fixture(t,zoom,kind){
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),`tangent-passage-${zoom}-`));
  const sourceBytes=await fs.readFile(path.join(sourceDirectory,'page.json'));
  const source=JSON.parse(sourceBytes),blockId=source.content.blocks[0].id;
  assert.equal(source.content.blocks.length,81,'Use the original complete Page fixture.');
  const toolLog=path.join(folder,'page-tools.jsonl'),remoteState=path.join(folder,'page.json');
  const proof={kind,zoom,fixtureOnly:true,sourceDigest:digest(sourceBytes),screenshots:[],rendererErrors:[],checkpoints:[]};
  let app,page,boardId,pageNodeId;
  const invoke=(command,params={})=>page.evaluate(({command,params})=>window.tangent.invoke(command,params),{command,params});
  const state=()=>invoke('app/state');
  const board=async()=>{const s=await state();return s.boards.find(b=>b.id===boardId)};
  const node=async id=>(await board()).nodes.find(n=>n.id===id);
  const shell=()=>page.getByTestId(`page-focus-${pageNodeId}`);
  const block=()=>shell().getByTestId(`page-block-${blockId}`);
  const composer=()=>shell().getByRole('textbox',{name:'Ask Codex about this Page',exact:true});
  const toolbar=()=>page.getByRole('toolbar',{name:'Text formatting',exact:true});
  const screenshot=async name=>{const file=path.join(output,`${kind}-${zoom}-${name}.png`);await page.screenshot({path:file});proof.screenshots.push(file)};
  const close=async()=>{if(!app)return;const current=app;app=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  t.after(async()=>{
    await fs.mkdir(output,{recursive:true});
    if(page)try{
      proof.finalNodes=(await board()).nodes.map(({id,kind,parentId,pageTargetId,targetChatId,archived,messages})=>({id,kind,parentId,pageTargetId,targetChatId,archived,messages:(messages||[]).map(({id,role,text,quote,blockId,pageTargetId})=>({id,role,text,quote,blockId,pageTargetId}))}));
      await screenshot('last-state');
    }catch{}
    try{proof.tools=(await fs.readFile(toolLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}catch{proof.tools=[]}
    proof.sourceUnchanged=digest(await fs.readFile(path.join(sourceDirectory,'page.json')))===proof.sourceDigest;
    await fs.writeFile(path.join(output,`${kind}-${zoom}-proof.json`),JSON.stringify(proof,null,2));
    await close();await fs.rm(folder,{recursive:true,force:true});
  });
  await fs.mkdir(output,{recursive:true});
  app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:path.join(folder,'data'),TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'threads.json'),TANGENT_FIXTURE_RPC_LOG:path.join(folder,'rpc.jsonl'),TANGENT_PAGE_FIXTURE_DIR:sourceDirectory,TANGENT_PAGE_FIXTURE_STATE:remoteState,TANGENT_PAGE_FIXTURE_LOG:toolLog}});
  page=await app.firstWindow();page.setDefaultTimeout(6000);page.on('pageerror',error=>proof.rendererErrors.push(error.message));
  await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];window.setContentSize(1440,1000);if(window.isVisible()||window.isFocused())throw Error('Passage tests must remain hidden.');});
  boardId=(await state()).activeBoardId;
  const linked=await invoke('page/link',{boardId,url:source.metadata.url,title:'Disposable Page passage fixture'});pageNodeId=linked.id;
  await expect.poll(async()=>(await node(pageNodeId)).pageSyncStatus,{timeout:20000}).toBe('ready');
  await page.locator('.outline-list > button').filter({hasText:(await node(pageNodeId)).title}).first().click();await expect(shell()).toBeVisible();
  if(await shell().getAttribute('data-page-mode')!=='full')await page.getByTestId(`page-view-toggle-${pageNodeId}`).click();
  if(zoom===75)for(let index=0;index<3;index++)await nativePageShortcut(app,'-');
  await expect(shell()).toHaveAttribute('data-page-zoom',String(zoom));
  proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  const initialMedia=structuredClone((await node(pageNodeId)).pageSnapshot.media);
  await page.getByTestId('page-discussion-toggle').click();
  await composer().fill('Reply exactly: Main discussion remains independent.');await composer().press('Enter');
  let main;await expect.poll(async()=>{main=await node((await node(pageNodeId)).targetChatId);return main?.messages.at(-1)?.text}).toBe('Main discussion remains independent.');
  await expect.poll(async()=>(await node(main.id)).status).toBe('idle');
  await page.getByTitle('Close discussion',{exact:true}).click();await expect(shell().locator('.page-discussion-panel')).toBeHidden();
  const select=async text=>{
    await selectPageText(page,block(),text);await expect(toolbar()).toBeVisible();
    // Read the local text offsets produced by the pointer without depending on
    // ProseMirror internals or manufacturing a selection.
    return block().evaluate(element=>{
      const selection=getSelection(),range=selection.getRangeAt(0),prefix=range.cloneRange();
      prefix.selectNodeContents(element);prefix.setEnd(range.startContainer,range.startOffset);
      const from=prefix.toString().length;return{from,to:from+selection.toString().length};
    });
  };
  const highlighted=async(text,stage)=>{
    const mark=shell().getByTestId('page-quoted-highlight');await expect(mark).toHaveText(text);await expect(mark).toBeVisible();
    const details=await mark.evaluate(element=>{const rect=element.getBoundingClientRect(),style=getComputedStyle(element);return{text:element.textContent,width:rect.width,height:rect.height,background:style.backgroundColor,selection:getSelection()?.toString()||'',focused:document.activeElement?.getAttribute('aria-label')}});
    assert.ok(details.width>0&&details.height>0,`${stage}: the highlight must cover rendered text.`);
    assert.notEqual(details.background,'rgba(0, 0, 0, 0)',`${stage}: document highlighting must have visible paint.`);
    proof.checkpoints.push({stage,...details});return details;
  };
  const refresh=async()=>{await page.getByTestId(`page-title-menu-${pageNodeId}`).click();await page.getByTestId(`page-refresh-${pageNodeId}`).click();await expect.poll(async()=>(await node(pageNodeId)).pageSyncStatus).toBe('ready');};
  const protectedState=async()=>{
    const tools=(await fs.readFile(toolLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.ok(tools.some(entry=>entry.tool==='read_page'&&entry.server==='codex_apps'));
    assert.equal(tools.some(entry=>entry.tool==='edit_page'),false,'Discussion actions must not write Page content.');
    assert.deepEqual((await node(pageNodeId)).pageSnapshot.media,initialMedia,'Discussion actions preserve every managed Page asset.');
    assert.equal(digest(await fs.readFile(path.join(sourceDirectory,'page.json'))),proof.sourceDigest);
    assert.deepEqual(proof.rendererErrors,[]);
    await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows()[0];if(window.isFocused()||window.isVisible())throw Error('The isolated test must never foreground an app.');});
  };
  return{app,page,boardId,pageNodeId,blockId,source,remoteState,proof,invoke,board,node,shell,block,composer,toolbar,select,highlighted,screenshot,refresh,protectedState,main};
}

test('Page passage reanchors across source blocks after a whole canonical document refresh',{timeout:65000},async t=>{
  const f=await fixture(t,75,'canonical-cross-block');
  const tail='genetic information.',heading='1. The smallest building blocks';
  const next=f.shell().getByTestId(`page-block-${f.source.content.blocks[1].id}`);
  const point=async(locator,text,last=false)=>locator.evaluate((element,{text,last})=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node;
    while((node=walker.nextNode())){
      const index=node.textContent.indexOf(text);if(index<0)continue;
      const offset=index+(last?text.length-1:0),range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);
      const rect=range.getBoundingClientRect();return{x:last?rect.right-.1:rect.left+.1,y:rect.top+rect.height/2};
    }
    throw Error('Expected source passage endpoint is not present.');
  },{text,last});
  await f.block().scrollIntoViewIfNeeded();
  const start=await point(f.block(),tail),end=await point(next,heading,true);
  await f.page.mouse.move(start.x,start.y);await f.page.mouse.down();await f.page.mouse.move(end.x,end.y,{steps:16});await f.page.mouse.up();
  const normalize=text=>text.replace(/\s+/g,' ').trim(),expected=normalize(`${tail} ${heading}`);
  assert.equal(normalize(await f.page.evaluate(()=>getSelection()?.toString()||'')),expected,'A trusted pointer must select precisely across the two canonical source blocks.');
  await expect(f.toolbar()).toBeVisible();await f.toolbar().getByRole('button',{name:'Ask Codex',exact:true}).click();
  await expect(f.composer()).toBeFocused();
  const exactQuote=await f.page.getByTestId('selection-toolbar').locator('blockquote').textContent();assert.equal(normalize(exactQuote),expected);
  const marks=f.shell().getByTestId('page-quoted-highlight');
  const verifyMarks=async stage=>{
    await expect.poll(async()=>normalize((await marks.allTextContents()).join(' ')),{message:`The cross-block Page passage must retain exact painted text after ${stage}.`}).toBe(expected);
    const painted=await marks.evaluateAll(elements=>elements.map(element=>{const rect=element.getBoundingClientRect();return{width:rect.width,height:rect.height,background:getComputedStyle(element).backgroundColor}}));
    assert.ok(painted.length>=2,'A passage crossing canonical source blocks needs visible highlights in both.');
    assert.ok(painted.every(mark=>mark.width>0&&mark.height>0&&mark.background!=='rgba(0, 0, 0, 0)'));
    f.proof.checkpoints.push({stage,paintedSegments:painted.length,textMatches:true});
  };
  await verifyMarks('initial selection');await f.screenshot('before-refresh');
  const editor=await f.shell().getByRole('textbox',{name:'Page document',exact:true}).elementHandle();
  const remote=JSON.parse(await fs.readFile(f.remoteState,'utf8'));
  const inserted={id:'fixture-before-cross-block-passage',kind:'markdown',markdown:'A fixture-only canonical insertion moves every later document position.',metadata:{}};
  inserted.hash=digest(inserted.markdown);remote.page.content.blocks.unshift(inserted);remote.page.content.markdown=remote.page.content.blocks.map(block=>block.markdown).join('\n\n');
  await fs.writeFile(f.remoteState,JSON.stringify(remote));await f.refresh();await expect(f.page.locator('.page-options-menu')).toHaveCount(0);
  await expect.poll(()=>f.shell().getByTestId(`page-block-${inserted.id}`).count()).toBe(1);
  assert.equal(await editor.evaluate(element=>element.isConnected),true,'Refreshing canonical blocks keeps the mounted editor.');
  await verifyMarks('whole canonical document replacement');await f.screenshot('after-refresh');
  await f.composer().fill('Reply exactly: Canonical passage answer.');await f.composer().press('Enter');
  await expect.poll(async()=>(await f.node(f.main.id)).messages.at(-1)?.text).toBe('Canonical passage answer.');
  await verifyMarks('submitted question and response');
  const sent=(await f.node(f.main.id)).messages.find(message=>message.role==='user'&&message.text==='Reply exactly: Canonical passage answer.');
  assert.equal(sent.quote,exactQuote);assert.equal(sent.blockId,f.blockId);
  await f.protectedState();f.proof.canonicalInsertionOnlyInDisposableFixture=true;
});

for(const zoom of [75,100]){
  test(`Page Ask Codex keeps the exact passage visibly highlighted after Enter at ${zoom}%`,{timeout:65000},async t=>{
    const f=await fixture(t,zoom,'ask');
    const range=await f.select(quote);
    await f.toolbar().getByRole('button',{name:'Ask Codex',exact:true}).click();
    await expect(f.page.getByTestId('selection-toolbar').locator('blockquote')).toHaveText(quote);
    await f.composer().fill(`Reply exactly: Passage answer ${zoom}.`);
    const before=await f.highlighted(quote,'composer focus before Enter');assert.equal(before.focused,'Ask Codex about this Page');
    await f.screenshot('focused-composer');
    await expect.poll(()=>f.toolbar().isVisible(),{message:'The Page formatting toolbar must close when Ask Codex focuses its composer.'}).toBe(false);
    // Hold the actual IPC acknowledgment, leaving the normal renderer path and
    // Page service intact. This catches transient Enter clearing independently
    // from the later state/answer events that can accidentally restore a mark.
    await f.app.evaluate(({ipcMain})=>{
      const original=ipcMain._invokeHandlers.get('tangent:invoke');
      if(typeof original!=='function')throw Error('Missing real application IPC handler.');
      globalThis.__passageAsk={calls:[],release:null};ipcMain.removeHandler('tangent:invoke');
      ipcMain.handle('tangent:invoke',(event,command,payload)=>{
        if(command!=='page/ask')return original(event,command,payload);
        const gate=globalThis.__passageAsk;gate.calls.push(structuredClone(payload));
        return new Promise((resolve,reject)=>{gate.release=()=>Promise.resolve(original(event,command,payload)).then(resolve,reject)});
      });
    });
    await f.composer().press('Enter');
    await expect.poll(()=>f.app.evaluate(()=>globalThis.__passageAsk.calls.length)).toBe(1);
    await expect(f.composer()).toBeFocused();
    const pending=await f.highlighted(quote,'Enter before asynchronous acknowledgment');
    assert.equal(pending.selection,'','The document highlight cannot depend on the browser native selection after composer input.');
    await f.screenshot('enter-pending');
    const [request]=await f.app.evaluate(()=>globalThis.__passageAsk.calls);
    assert.equal(request.nodeId,f.pageNodeId);assert.equal(request.chatId,f.main.id);assert.equal(request.quote,quote);assert.equal(request.blockId,f.blockId);
    assert.equal(range.to-range.from,quote.length,'The local highlight uses the exact source passage range.');
    await f.app.evaluate(()=>{globalThis.__passageAsk.release();globalThis.__passageAsk.release=null;});
    await expect.poll(async()=>(await f.node(f.main.id)).messages.at(-1)?.text).toBe(`Passage answer ${zoom}.`);
    await f.highlighted(quote,'response and acknowledgment');await expect(f.composer()).toBeFocused();
    await expect.poll(()=>f.toolbar().isVisible(),{message:'The Page formatting toolbar must stay closed after the Ask Codex question is submitted.'}).toBe(false);
    const sent=(await f.node(f.main.id)).messages.filter(message=>message.role==='user'&&message.text===`Reply exactly: Passage answer ${zoom}.`);
    assert.equal(sent.length,1);assert.equal(sent[0].quote,quote);assert.equal(sent[0].blockId,f.blockId);assert.equal(sent[0].pageTargetId,f.pageNodeId);
    // The source decoration and unsent composer chip are separate from the
    // submitted message. The passage must remain visible alongside that exact
    // user question after Enter clears the composer.
    const sentMessage=f.shell().getByTestId(`page-thread-${f.pageNodeId}`).getByTestId(`message-${sent[0].id}`);
    const sentQuote=sentMessage.getByTestId(`message-quote-${sent[0].id}`);
    await f.screenshot('submitted-question');
    f.proof.sentQuote={messageId:sent[0].id,stored:true,visibleQuoteElements:await sentQuote.count()};
    await expect.poll(()=>sentQuote.count(),{message:'The submitted Ask Codex message must render its stored source passage.'}).toBe(1);
    await expect(sentQuote).toHaveText(quote);await expect(sentQuote).toBeVisible();
    await expect(sentMessage.locator('.message-text > p')).toHaveText(`Reply exactly: Passage answer ${zoom}.`);
    assert.equal((await f.node(f.pageNodeId)).targetChatId,f.main.id);assert.equal(await f.app.evaluate(()=>globalThis.__passageAsk.calls.length),1);
    await f.refresh();await f.highlighted(quote,'canonical refresh with unchanged text');await expect(sentQuote).toHaveText(quote);
    await expect(f.page.locator('.page-options-menu')).toHaveCount(0);
    await f.select(replacementQuote);await f.toolbar().getByRole('button',{name:'Ask Codex',exact:true}).click();
    await f.highlighted(replacementQuote,'new passage replaces old highlight');
    await f.page.getByTitle('Remove quoted passage',{exact:true}).click();
    await expect(f.shell().getByTestId('page-quoted-highlight')).toHaveCount(0);
    await expect(sentQuote).toHaveText(quote);await expect(sentQuote).toBeVisible();
    await expect(f.shell()).toBeVisible();await f.protectedState();await f.screenshot('passed');
    f.proof.range=range;f.proof.exactlyOneAsk=true;
  });

  test(`Page selection offers Ask Codex and an isolated collapsible side chat at ${zoom}%`,{timeout:65000},async t=>{
    const f=await fixture(t,zoom,'side-chat'),mainBefore=structuredClone(await f.node(f.main.id));
    await f.select(quote);
    await expect(f.toolbar().getByRole('button',{name:'Ask Codex',exact:true})).toBeVisible();
    const sideAction=f.page.getByTestId('page-selection-side-chat');
    await expect.poll(()=>sideAction.count(),{message:'Page text selection must offer a separate Start side chat action.'}).toBe(1);
    await expect(sideAction).toBeVisible();await expect(sideAction).toHaveAccessibleName('Start side chat');
    await f.screenshot('both-actions');await sideAction.click();
    // The second action opens an isolated question form. Submitting it creates
    // its own saved conversation while the main discussion stays selected.
    const popover=f.page.locator('.selection-popover:visible');await expect(popover).toBeVisible();
    await expect(popover.locator('blockquote')).toHaveText(quote);
    const sideQuestion=popover.getByTestId('comment-question');
    await sideQuestion.fill(`Reply exactly: Isolated passage answer ${zoom}.`);
    await sideQuestion.press('Shift+Enter');await expect(sideQuestion).toHaveValue(`Reply exactly: Isolated passage answer ${zoom}.\n`);
    assert.equal((await f.board()).nodes.filter(node=>node.kind==='comment'&&node.parentId===f.pageNodeId&&node.id!==f.main.id).length,0,'Shift+Enter adds a line without creating a side conversation.');
    await sideQuestion.press('Backspace');
    await f.highlighted(quote,'side question form owns the selected source passage');
    await sideQuestion.press('Enter');
    let child;await expect.poll(async()=>{child=(await f.board()).nodes.find(node=>node.kind==='comment'&&node.parentId===f.pageNodeId&&node.id!==f.main.id);return child?.id}).toBeTruthy();
    const floating=f.page.getByTestId(`floating-side-chat-${child.id}`);await expect(floating).toBeVisible();await expect(f.shell()).toBeVisible();
    assert.equal(child.quote,quote);assert.equal(child.pageTargetId,f.pageNodeId);assert.equal(child.inheritedCount,0);
    assert.equal((await f.node(f.pageNodeId)).targetChatId,f.main.id);assert.deepEqual((await f.node(f.main.id)).messages,mainBefore.messages);
    await f.highlighted(quote,'side conversation opens over the source passage');
    const input=floating.getByTestId(`composer-${child.id}`);
    await expect.poll(async()=>(await f.node(child.id)).messages.at(-1)?.text).toBe(`Isolated passage answer ${zoom}.`);
    const childQuestions=(await f.node(child.id)).messages.filter(message=>message.role==='user');assert.equal(childQuestions.length,1);
    assert.equal(childQuestions[0].quote,quote);assert.equal(childQuestions[0].blockId,f.blockId);assert.equal(childQuestions[0].pageTargetId,f.pageNodeId);
    const childQuote=floating.getByTestId(`message-quote-${childQuestions[0].id}`);await expect.poll(()=>childQuote.count()).toBe(1);
    await expect(childQuote).toHaveText(quote);await expect(childQuote).toBeVisible();
    await f.highlighted(quote,'side conversation answer');assert.deepEqual((await f.node(f.main.id)).messages,mainBefore.messages);
    await floating.getByTestId(`floating-chat-collapse-${child.id}`).click();await expect(floating).toHaveClass(/is-minimized/);
    await expect(input).toBeHidden();await expect(f.shell()).toBeVisible();await f.highlighted(quote,'side conversation collapsed');
    await floating.getByTestId(`floating-chat-collapse-${child.id}`).click();await expect(input).toBeVisible();
    assert.ok((await f.board()).edges.some(edge=>edge.source===f.pageNodeId&&edge.target===child.id),'The isolated side chat is saved as a connected canvas card.');
    await f.screenshot('floating-source-highlight');await floating.getByTestId(`floating-chat-close-${child.id}`).click();
    await f.page.getByTestId('page-focus-back').click();await expect(f.page.getByTestId(`card-${child.id}`)).toBeVisible();
    assert.equal(!!(await f.node(child.id)).archived,false);await f.protectedState();
    f.proof.sideChatId=child.id;f.proof.mainChatId=f.main.id;f.proof.mainChatUnchanged=true;
  });
}
