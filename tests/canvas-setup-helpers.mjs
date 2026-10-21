import {expect} from '@playwright/test';

// Linked Pages are attached through the same IPC endpoint used by Codex's
// canvas_page tool. The compact canvas toolbar intentionally has no Page form.
export async function attachFixturePage(page,{boardId,url,title}={}){
  const linked=await page.evaluate(async input=>{
    const state=await window.tangent.invoke('app/state');
    return window.tangent.invoke('page/link',{...input,boardId:input.boardId||state.activeBoardId});
  },{boardId,url,title});
  let node;
  await expect.poll(async()=>{
    const state=await page.evaluate(()=>window.tangent.invoke('app/state'));
    node=state.boards.flatMap(board=>board.nodes).find(item=>item.id===linked.id);
    return node?.pageSyncStatus;
  },{timeout:20000}).toBe('ready');
  await page.locator('.outline-list > button').filter({hasText:node.title}).first().click();
  await expect(page.getByTestId(`page-focus-${node.id}`)).toBeVisible();
  return node;
}
