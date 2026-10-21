import assert from 'node:assert/strict';

// Read geometry only, then use Chromium pointer/keyboard input. Do not set a
// selection or editor content by script: those shortcuts miss caret regressions.
export async function selectPageText(page,block,text,{clearCurrentFormatting=true}={}){
  await block.scrollIntoViewIfNeeded();
  // Clear an earlier floating formatting toolbar with an ordinary caret click
  // before starting a fresh drag. Otherwise its previous position can cover the
  // text after a heading/font change, making the pointer hit the toolbar.
  if(clearCurrentFormatting){await placePageCaretAtEnd(page,block);await page.locator('[data-page-rich-toolbar]').waitFor({state:'hidden'})}
  const points=await block.evaluate((element,wanted)=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),nodes=[];
    let node;while((node=walker.nextNode())){
      const parent=node.parentElement;
      if(!node.textContent||parent.closest('button,script,style')||parent.closest('[contenteditable]')?.getAttribute('contenteditable')==='false')continue;
      const range=document.createRange();range.selectNodeContents(node);if(range.getBoundingClientRect().height>0)nodes.push(node);
    }
    const joined=nodes.map(node=>node.textContent).join(''),start=joined.indexOf(wanted);
    if(start<0)throw Error(`Cannot find selectable text ${wanted}`);
    const locate=offset=>{let cursor=0;for(const node of nodes){if(offset<cursor+node.textContent.length)return{node,offset:offset-cursor};cursor+=node.textContent.length}throw Error('Selection offset is outside the editable prose')};
    const first=locate(start),last=locate(start+wanted.length-1),a=document.createRange(),b=document.createRange();
    a.setStart(first.node,first.offset);a.setEnd(first.node,first.offset+1);b.setStart(last.node,last.offset);b.setEnd(last.node,last.offset+1);
    const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();
    const hit=(x,y)=>{const element=document.elementFromPoint(x,y);return{tag:element?.tagName,class:element?.className,text:element?.textContent?.slice(0,100)}};
    return{x1:x.left+.1,y1:x.top+x.height/2,x2:y.right-.1,y2:y.top+y.height/2,hits:[hit(x.left+.1,x.top+x.height/2),hit(y.right-.1,y.top+y.height/2)]};
  },text);
  await page.mouse.move(points.x1,points.y1);await page.mouse.down();await page.mouse.move(points.x2,points.y2,{steps:12});
  const duringDrag=await page.evaluate(()=>getSelection()?.toString());
  await page.mouse.up();
  // Assert the completed gesture. Chromium and the editor can commit the final
  // selection on mouse-up/selectionchange, after the last dispatched move.
  const selected=await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>resolve(getSelection()?.toString()))));
  assert.equal(selected,text,`The real pointer drag must select exactly the intended source text. ${JSON.stringify({...points,duringDrag})}`);
  return selected;
}

export async function placePageCaretAtEnd(page,block){
  await block.scrollIntoViewIfNeeded();
  const point=await block.evaluate(element=>{
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT),nodes=[];let node;
    while((node=walker.nextNode())){
      const parent=node.parentElement;
      if(!node.textContent?.trim()||parent.closest('button,script,style')||parent.closest('[contenteditable]')?.getAttribute('contenteditable')==='false')continue;
      const range=document.createRange();range.selectNodeContents(node);if(range.getBoundingClientRect().height>0)nodes.push(node);
    }
    const last=nodes.at(-1);if(!last)throw Error('No visible Page paragraph is available for a caret.');
    const range=document.createRange();range.setStart(last,last.textContent.length-1);range.setEnd(last,last.textContent.length);const rect=range.getBoundingClientRect(),parent=element.getBoundingClientRect();
    return{x:Math.min(rect.right+1,parent.right-1)-parent.left,y:rect.top+rect.height/2-parent.top};
  });
  // Element-relative coordinates survive a translate-only reader transition;
  // locator.click also waits for stable geometry before sending the pointer.
  await block.click({position:point});
  const focused=await block.evaluate(element=>{const active=document.activeElement;return active?.isContentEditable&&(active.contains(element)||element.contains(active))});
  assert.equal(focused,true,'Clicking Page prose must focus its actual contenteditable editor before typing.');
}

export async function typeAtPageEnd(page,block,text){
  await placePageCaretAtEnd(page,block);await page.keyboard.insertText(text);
}

export async function nativePageShortcut(application,key,extra=[]){
  await application.evaluate(({BrowserWindow},{key,extra})=>{
    const window=BrowserWindow.getAllWindows()[0],modifiers=[process.platform==='darwin'?'meta':'control',...extra];
    window.webContents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});window.webContents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});
    if(window.isFocused()||window.isVisible())throw Error('An isolated Page test must never foreground the application.');
  },{key,extra});
}
