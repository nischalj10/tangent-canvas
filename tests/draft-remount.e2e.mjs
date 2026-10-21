import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron,expect} from '@playwright/test';

const root=path.resolve(import.meta.dirname,'..'),output=path.resolve(root,'../../work/draft-remount-e2e');
const original='The pending request belongs to the old composer.';
const successor='A newer draft belongs to the current view.';

for(const scenario of ['rejected-successor','rejected-empty-successor','accepted-successor','accepted-send-successor'])test(`pending delivery across composer remount preserves ${scenario}`,{timeout:20000},async t=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),`tangent-draft-remount-${scenario}-`));
  await fs.mkdir(output,{recursive:true});
  const control=path.join(folder,'control.json'),directory=path.join(folder,'data');
  await fs.writeFile(control,JSON.stringify({delayMs:2000,mode:scenario.startsWith('rejected')?'reject':'accept'}));
  const proof={scenario,hidden:true,foregroundInteraction:false,trustedSuccessorInput:true,rendererErrors:[]};
  let app,page,boardId,nodeId;
  const invoke=(command,payload={})=>page.evaluate(({command,payload})=>window.tangent.invoke(command,payload),{command,payload});
  const node=()=>invoke('app/state').then(state=>state.boards.find(board=>board.id===boardId).nodes.find(item=>item.id===nodeId));
  const close=async()=>{if(!app)return;const current=app;app=null;const timer=setTimeout(()=>current.process()?.kill('SIGKILL'),6000);try{await current.close()}finally{clearTimeout(timer)}};
  t.after(async()=>{
    if(page)try{await page.screenshot({path:path.join(output,`${scenario}.png`)})}catch{}
    await fs.writeFile(path.join(output,`${scenario}-proof.json`),JSON.stringify(proof,null,2)+'\n');
    await close();await fs.rm(folder,{recursive:true,force:true});
  });
  const launch=async()=>{
    app=await electron.launch({args:['.','--background'],cwd:root,env:{...process.env,TANGENT_E2E:'1',TANGENT_ALLOW_MULTIPLE:'1',TANGENT_DATA_DIR:directory,TANGENT_TEST_CODEX_BINARY:path.join(root,'tests/fixtures/codex-appserver.mjs'),TANGENT_FIXTURE_STATE:path.join(folder,'peer.json'),TANGENT_FIXTURE_STEER_CONTROL:control}});
    page=await app.firstWindow();page.setDefaultTimeout(3500);page.on('pageerror',error=>proof.rendererErrors.push(error.message));
    await page.getByTestId('canvas-surface').waitFor();await expect.poll(()=>invoke('app/connection')).toMatchObject({connected:true});
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,1000));
  };
  await launch();proof.renderer=await page.locator('script[type=module]').getAttribute('src');
  await page.getByTestId('new-chat').click();boardId=(await invoke('app/state')).activeBoardId;
  await expect.poll(async()=>{nodeId=(await invoke('app/state')).boards.find(board=>board.id===boardId).nodes.find(item=>item.kind==='chat')?.id;return Boolean(nodeId)}).toBe(true);
  let card=page.getByTestId(`card-${nodeId}`),composer=card.getByTestId(`composer-${nodeId}`);
  if(scenario==='accepted-send-successor'){
    // Let new-card navigation/autofocus settle before beginning physical keys.
    await page.waitForTimeout(350);
    await app.evaluate(({ipcMain})=>{
      const handler=ipcMain._invokeHandlers.get('tangent:invoke');ipcMain.removeHandler('tangent:invoke');
      globalThis.__remountSend={held:false};
      ipcMain.handle('tangent:invoke',async(...args)=>{if(args[1]==='node/send'&&!globalThis.__remountSend.held){globalThis.__remountSend.held=true;await new Promise(resolve=>setTimeout(resolve,2000))}return handler(...args)});
    });
    await composer.pressSequentially(original,{delay:1});await expect(composer).toHaveValue(original);await card.getByTestId(`send-${nodeId}`).click();
    await expect.poll(()=>app.evaluate(()=>globalThis.__remountSend.held)).toBe(true);
  }else{
    await composer.fill('SLOW_TEST');await card.getByTestId(`send-${nodeId}`).click();
    await expect.poll(async()=>(await node()).status).toBe('running');
    await composer.pressSequentially(original,{delay:1});await expect(composer).toHaveValue(original);await card.getByTestId(`steer-${nodeId}`).click();
    await expect.poll(async()=>(await node()).messages.find(message=>message.text===original)?.deliveryStatus).toBe('sending');
  }
  await expect(composer).toHaveValue('');
  await card.getByTestId(`chat-focus-open-${nodeId}`).click();
  const fullscreen=page.getByTestId(`chat-fullscreen-${nodeId}`);await expect(fullscreen).toBeVisible();
  composer=fullscreen.getByTestId(`composer-${nodeId}`);await expect(composer).toHaveValue('');
  await composer.pressSequentially(successor,{delay:2});
  const expected=scenario==='rejected-empty-successor'?'':successor;
  if(!expected){await composer.press('Meta+A');await composer.press('Backspace')}
  if(scenario==='accepted-send-successor')await expect.poll(async()=>(await node()).messages.some(message=>message.role==='user'&&message.text===original)).toBe(true);
  else await expect.poll(async()=>(await node()).messages.find(message=>message.text===original)?.deliveryStatus).toBe(scenario.startsWith('rejected')?'failed':'accepted');
  await expect(composer).toHaveValue(expected);proof.visibleSuccessorAfterAcknowledgement=true;
  proof.backendDraftAfterAcknowledgement=(await node()).draft;
  await expect.poll(async()=>(await node()).draft,{timeout:2500}).toBe(expected);
  proof.backendSuccessorAfterAcknowledgement=true;
  await page.getByTestId('chat-focus-back').click();card=page.getByTestId(`card-${nodeId}`);await expect(card.getByTestId(`composer-${nodeId}`)).toHaveValue(expected);
  await card.getByTestId(`chat-focus-open-${nodeId}`).click();await expect(page.getByTestId(`chat-fullscreen-${nodeId}`).getByTestId(`composer-${nodeId}`)).toHaveValue(expected);proof.remountRetained=true;
  await close();await launch();await page.getByTestId(`chat-focus-open-${nodeId}`).click();
  await expect(page.getByTestId(`chat-fullscreen-${nodeId}`).getByTestId(`composer-${nodeId}`)).toHaveValue(expected);proof.restartRetained=true;
  assert.deepEqual(await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];return{visible:w.isVisible(),focused:w.isFocused()}}),{visible:false,focused:false});
  assert.deepEqual(proof.rendererErrors,[]);proof.passed=true;
});
