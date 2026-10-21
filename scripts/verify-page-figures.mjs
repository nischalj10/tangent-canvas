import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {_electron as electron,expect} from '@playwright/test';
import {requireLivePageUrl} from './live-page-target.mjs';
const url=requireLivePageUrl();

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'tangent-real-page-figures-'));
const executable=process.argv[2];
let application,page;const errors=[];
try{
  const env={...process.env,TANGENT_DATA_DIR:directory,TANGENT_ALLOW_MULTIPLE:'1'};
  delete env.ELECTRON_RUN_AS_NODE;delete env.TANGENT_E2E;delete env.TANGENT_TEST_CODEX_BINARY;
  application=await electron.launch({...(executable?{executablePath:executable}:{cwd:root}),args:executable?['--background']:['.','--background'],env});
  page=await application.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
  await page.getByTestId('canvas-surface').waitFor();
  await expect.poll(()=>page.evaluate(()=>window.tangent.invoke('app/connection')),{timeout:45000}).toMatchObject({connected:true,account:{type:'chatgpt'}});
  const start=await page.evaluate(()=>window.tangent.invoke('app/state')),boardId=start.activeBoardId;
  const node=await page.evaluate(({boardId,url})=>window.tangent.invoke('page/link',{boardId,url}),{boardId,url});
  const snapshot=await page.evaluate(({boardId,nodeId})=>window.tangent.invoke('page/sync',{boardId,nodeId}),{boardId,nodeId:node.id});
  assert.equal(snapshot.mediaErrors.length,0);assert.ok(snapshot.media.filter(asset=>asset.kind==='visualization').length>=3);
  await page.locator('.outline-list>button').filter({hasText:snapshot.title}).first().click();await page.waitForTimeout(450);
  const card=page.getByTestId(`card-${node.id}`);let rna,packaging,rnaElement,packagingElement;
  await page.getByTestId(`page-title-menu-${node.id}`).click();
  await page.getByTestId(`page-zoom-${node.id}`).selectOption('75');
  await page.getByTestId(`page-title-menu-${node.id}`).click();
  await expect(page.getByTestId(`page-focus-${node.id}`)).toHaveAttribute('data-page-zoom','75');
  for(const element of await card.getByTestId('page-visualization-frame').all()){
    await element.scrollIntoViewIfNeeded();const frame=await(await element.elementHandle()).contentFrame();
    await expect.poll(()=>frame.locator('body').innerText()).not.toBe('');
    if(await frame.locator('#step0').count()){rna=frame;rnaElement=element;}
    if(await frame.locator('#dna-packaging-clarified').count()){packaging=frame;packagingElement=element;}
    assert.equal(await frame.evaluate(()=>typeof window.tangent),'undefined');
    assert.equal(await element.getAttribute('sandbox'),'allow-scripts');
  }
  // Playwright's nested locator bounds omit a transformed canvas ancestor.
  // Map the real child viewport into its actual screen rectangle, then send
  // a trusted pointer event through the parent page.
  const clickInFrame=async(frame,element,button)=>{
    await button.evaluate(target=>target.scrollIntoView({block:'center',inline:'nearest'}));
    await element.scrollIntoViewIfNeeded();
    const box=await element.boundingBox(),point=await button.evaluate(target=>{const r=target.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,width:innerWidth,height:innerHeight}});
    assert.ok(box&&point.x>=0&&point.x<=point.width&&point.y>=0&&point.y<=point.height,'Figure control must be visible in its own viewport');
    await page.mouse.click(box.x+point.x*box.width/point.width,box.y+point.y*box.height/point.height);
  };
  assert.ok(rna,'The actual original RNA interactive figure must be present.');
  assert.ok(packaging,'The actual original packaging interactive figure must be present.');
  await rna.evaluate(()=>document.addEventListener('click',event=>{window.__tangentFigureClick={id:event.target.id,text:event.target.textContent?.slice(0,90),trusted:event.isTrusted,x:event.clientX,y:event.clientY}},true));
  for(let index=0;index<4;index++){
    const button=rna.locator(`#step${index}`);await clickInFrame(rna,rnaElement,button);await expect(button).toHaveAttribute('aria-pressed','true');
    await expect(rna.locator(`#panel${index}`)).toBeVisible();
    for(let other=0;other<4;other++)if(other!==index)await expect(rna.locator(`#panel${other}`)).toBeHidden();
  }
  await clickInFrame(rna,rnaElement,rna.locator('#step1'));await rna.locator('h1').scrollIntoViewIfNeeded();
  const screenshots=path.join(root,'screenshots');await fs.mkdir(screenshots,{recursive:true});
  await rnaElement.screenshot({path:path.join(screenshots,'native-page-rna-live-interactive.png')});
  const tokens=await packaging.evaluate(()=>({font:getComputedStyle(document.body).fontFamily,text:getComputedStyle(document.body).color,core:getComputedStyle(document.querySelector('.dp-core')).fill,dna:getComputedStyle(document.querySelector('.dp-dna')).stroke,foreground:getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim(),series:getComputedStyle(document.documentElement).getPropertyValue('--viz-series-1').trim()}));
  assert.ok(tokens.foreground&&tokens.series,'Host visualization tokens must be available in isolated Page fragments.');
  assert.match(tokens.font,/system-ui|-apple-system|sans-serif/i);assert.doesNotMatch(tokens.font,/Times/i);
  assert.notEqual(tokens.core,'rgb(0, 0, 0)');assert.notEqual(tokens.dna,'none');assert.notEqual(tokens.core,tokens.dna);
  const stages=[];
  for(let index=0;index<5;index++){
    const button=packaging.locator(`button[data-stage="${index}"]`);await clickInFrame(packaging,packagingElement,button);await expect(button).toHaveAttribute('aria-pressed','true');
    const title=await packaging.locator('.dp-stage-title').innerText();assert.match(title,new RegExp(`^${index+1}`));stages.push(title);
    assert.ok(await packaging.locator('.dp-drawing>*').count());
  }
  await clickInFrame(packaging,packagingElement,packaging.locator('button[data-stage="3"]'));await packaging.locator('.viz-controls').scrollIntoViewIfNeeded();
  await packagingElement.screenshot({path:path.join(screenshots,'native-page-packaging-live-interactive.png')});
  const originalElement=await packagingElement.elementHandle();
  await page.getByTestId('page-discussion-toggle').click();
  await card.getByTestId(`page-ask-input-${node.id}`).fill('Unsaved local draft; keep the original visualization state.');
  assert.equal(await originalElement.evaluate(element=>element.isConnected),true);await expect(packaging.locator('button[data-stage="3"]')).toHaveAttribute('aria-pressed','true');
  assert.equal(await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);assert.deepEqual(errors,[]);
  const result={mode:executable?'packaged':'development',originalPageReadOnly:true,pageZoom:75,pageView:'half',realOriginalRnaSteps:4,realOriginalPackagingStages:5,styles:tokens,stages,iframeStateRetained:true,windowHidden:true,rendererErrors:errors};
  await fs.writeFile(path.resolve(root,'../../work/native-page-figure-proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){if(page)try{await page.screenshot({path:path.join(root,'screenshots/native-page-figure-failure.png')})}catch{}throw error;}finally{
  if(application){const child=application.process(),timer=setTimeout(()=>child.kill('SIGKILL'),7000);try{await application.close().catch(()=>{})}finally{clearTimeout(timer)}}
  await fs.rm(directory,{recursive:true,force:true});
}
