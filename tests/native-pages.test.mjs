import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasService} from '../electron/service.mjs';
import {CanvasStore} from '../electron/store.mjs';
import {PageMediaStore,visualizationDocument} from '../electron/page-media.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Peer extends EventEmitter{
  constructor(){super();this.calls=[];this.turn=0}
  async start(){return{connected:true,model:'test',effort:'low',models:[]}}
  async newThread(){return{id:`thread-${this.calls.length}`}}
  async sendTurn(threadId,text){const turn={id:`turn-${++this.turn}`};this.calls.push({threadId,text,turnId:turn.id});this.emit('notification',{method:'turn/started',params:{threadId,turn}});return turn}
  async close(){}
  respond(){}
  reject(){}
  finish(call){this.emit('notification',{method:'turn/completed',params:{threadId:call.threadId,turn:{id:call.turnId,status:'completed'}}})}
}
class Connector extends EventEmitter{
  constructor(){super();this.reads=0;this.mediaReads=0;this.edits=0;this.snapshot={pageId:'page_test12345',title:'Real source',blocks:[{id:'block-one',hash:'hash-one',markdown:'Source paragraph'}],references:[{reference:'visualize:observed'}],comments:[],throughSequence:null,syncedAt:Date.now()}}
  async read(){this.reads++;if(this.offline)throw Error('Offline');return structuredClone(this.snapshot)}
  async readReference(){this.mediaReads++;return{mime:'text/html',text:'<!doctype html><button onclick="this.textContent=\'Clicked\'">Try figure</button>'}}
  async editBlock(_page,input){this.edits++;if(this.snapshot.blocks[0].hash!==input.expectedHash){const error=Error('Page changed');error.snapshot=structuredClone(this.snapshot);throw error}this.snapshot.blocks[0]={id:'block-one',hash:'hash-two',markdown:input.markdown};return this.read()}
  respond(id,result){this.reply={id,result}}
  reject(id,message){this.rejection={id,message}}
  async close(){this.closed=true}
}
async function setup(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-native-page-')),store=new CanvasStore(directory),peer=new Peer(),connector=new Connector(),service=new CanvasService(store,peer,{pageConnector:connector});await service.connect();
  const board=store.state.boards[0],node=service.makeNode(board,'page',{url:'https://chatgpt.com/space/page_test12345'}),p={boardId:board.id,nodeId:node.id};
  t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true})});return{directory,store,peer,connector,service,board,node,p};
}
test('linked Page sync reads exact source, serves HTML privately, persists offline and coalesces refresh',async t=>{
  const f=await setup(t);const[a,b]=await Promise.all([f.service.invoke('page/sync',f.p),f.service.invoke('page/sync',f.p)]);
  assert.deepEqual(a,b);assert.equal(f.connector.reads,1);assert.equal(f.connector.mediaReads,1);assert.equal(a.blocks[0].id,'block-one');assert.equal(a.blocks[0].hash,'hash-one');assert.equal(a.media.length,1);assert.equal(f.node.title,'Real source');
  const response=f.service.pageMedia.response(a.media[0].url);assert.equal(response.status,200);assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'none'/);assert.match(await response.text(),/Try figure/);
  await f.service.invoke('page/sync',f.p);assert.equal(f.connector.mediaReads,1);
  f.connector.offline=true;await assert.rejects(f.service.invoke('page/sync',f.p),/Offline/);f.store.flush();
  const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;assert.equal(reopened.pageSnapshot.blocks[0].markdown,'Source paragraph');assert.equal(reopened.pageSyncStatus,'error');assert.match(reopened.pageSyncError,/Offline/);
});
test('inline Page edit writes one exact guarded source block; conflict retains latest canonical source',async t=>{
  const f=await setup(t);await f.service.invoke('page/sync',f.p);
  const result=await f.service.invoke('page/edit-block',{...f.p,blockId:'block-one',expectedHash:'hash-one',markdown:'Edited source'});
  assert.equal(result.blocks[0].markdown,'Edited source');assert.equal(result.blocks[0].hash,'hash-two');assert.equal(f.connector.edits,1);
  await assert.rejects(f.service.invoke('page/edit-block',{...f.p,blockId:'block-one',expectedHash:'hash-one',markdown:'Stale overwrite'}),/changed/);
  assert.equal(f.node.pageSnapshot.blocks[0].markdown,'Edited source');assert.equal(f.connector.snapshot.blocks[0].markdown,'Edited source');
});
test('Page asks explicitly chosen existing chat, preserves anchor, queues when busy and retains source per queued message',async t=>{
  const f=await setup(t);await f.service.invoke('page/sync',f.p);const existing=f.service.makeNode(f.board,'chat',{title:'My existing chat'});
  await f.service.invoke('page/settings',{...f.p,targetChatId:existing.id});
  const result=await f.service.invoke('page/ask',{...f.p,text:'Explain source',quote:'Source paragraph',blockId:'block-one'});
  assert.equal(result.id,existing.id);assert.equal(f.board.nodes.filter(n=>n.kind==='comment').length,0);assert.match(f.peer.calls[0].text,/page_test12345/);assert.match(f.peer.calls[0].text,/block-one/);assert.match(f.peer.calls[0].text,/Source paragraph/);
  await f.service.invoke('page/ask',{...f.p,text:'Then edit it',quote:'Source paragraph',blockId:'block-one'});
  assert.equal(existing.queue.length,1);assert.equal(existing.queue[0].pageTargetId,f.node.id);assert.equal(existing.queue[0].blockId,'block-one');assert.equal(f.peer.calls.length,1);
  const other=f.service.makeNode(f.board,'page',{url:'https://chatgpt.com/space/page_other123'});existing.pageTargetId=other.id;
  f.peer.finish(f.peer.calls[0]);for(let i=0;i<5;i++)await tick();assert.equal(f.peer.calls.length,2);assert.match(f.peer.calls[1].text,/page_test12345/);assert.doesNotMatch(f.peer.calls[1].text,/page_other123/);
});
test('new Page discussion becomes explicit continuing target; invalid targets never start hidden chats',async t=>{
  const f=await setup(t);const first=await f.service.invoke('page/ask',{...f.p,text:'Discuss this',chatId:null});assert.equal(f.node.targetChatId,first.id);assert.equal(first.pageTargetId,f.node.id);assert.equal(f.board.edges.at(-1).source,f.node.id);
  f.peer.finish(f.peer.calls[0]);await f.service.invoke('page/ask',{...f.p,text:'Follow up'});assert.equal(f.board.nodes.filter(n=>n.kind==='comment').length,1);assert.equal(f.peer.calls[1].threadId,f.peer.calls[0].threadId);
  const count=f.board.nodes.length;await assert.rejects(f.service.invoke('page/ask',{...f.p,text:'No hidden chat',chatId:'missing'}),/no longer/);assert.equal(f.board.nodes.length,count);
  await assert.rejects(f.service.invoke('page/ask',{...f.p,text:'Bad anchor',blockId:'missing'}),/block changed/);
});
test('a selected Page passage starts an independent side chat with its canonical anchor preserved',async t=>{
  const f=await setup(t);await f.service.invoke('page/sync',f.p);
  const discussion=f.service.makeNode(f.board,'chat',{title:'Continuing Page discussion'});
  await f.service.invoke('page/settings',{...f.p,targetChatId:discussion.id});
  const source=structuredClone(f.node.pageSnapshot.blocks);
  const child=await f.service.invoke('node/branch',{...f.p,kind:'comment',quote:'Source paragraph',blockId:'block-one',text:'Explain this separately'});
  assert.equal(child.kind,'comment');assert.equal(child.parentId,f.node.id);assert.equal(child.pageTargetId,f.node.id);assert.equal(child.inheritedCount,0);
  assert.equal(f.node.targetChatId,discussion.id);assert.equal(discussion.messages.length,0);assert.equal(child.messages.length,1);
  const message=child.messages[0];assert.equal(message.role,'user');assert.equal(message.text,'Explain this separately');assert.equal(message.quote,'Source paragraph');assert.equal(message.blockId,'block-one');assert.equal(message.pageTargetId,f.node.id);
  assert.equal(f.board.edges.at(-1).source,f.node.id);assert.equal(f.board.edges.at(-1).target,child.id);
  assert.match(f.peer.calls[0].text,/page_test12345/);assert.match(f.peer.calls[0].text,/selected canonical block ID is block-one/);
  assert.equal(f.peer.calls[0].text.split('Source paragraph').length-1,1);
  const second=await f.service.invoke('node/branch',{...f.p,kind:'comment',quote:'Source paragraph',blockId:'block-one',text:'Explore another angle'});
  assert.notEqual(second.id,child.id);assert.notEqual(second.threadId,child.threadId);assert.equal(f.node.targetChatId,discussion.id);
  assert.deepEqual(f.node.pageSnapshot.blocks,source);assert.equal(f.connector.edits,0);
  f.store.flush();const reopened=new CanvasStore(f.directory);
  assert.equal(reopened.node(f.board.id,child.id).node.messages[0].quote,'Source paragraph');assert.equal(reopened.node(f.board.id,child.id).node.messages[0].blockId,'block-one');
});
test('invalid Page side-chat anchors are rejected before creating a card or sending a turn',async t=>{
  const f=await setup(t);await f.service.invoke('page/sync',f.p);
  const count=f.board.nodes.length,edges=f.board.edges.length;
  for(const invalid of [{blockId:'missing'}, {quote:'x'.repeat(20001)}, {quote:{text:'Source paragraph'}}]){
    await assert.rejects(f.service.invoke('node/branch',{...f.p,kind:'comment',text:'Explain this separately',...invalid}),/block changed|shorter passage/);
    assert.equal(f.board.nodes.length,count);assert.equal(f.board.edges.length,edges);assert.equal(f.peer.calls.length,0);assert.equal(f.node.targetChatId,undefined);
  }
});
test('Page zoom and half/full preferences persist independently of its exact discussion target',async t=>{
  const f=await setup(t),chat=f.service.makeNode(f.board,'chat');
  await f.service.invoke('page/settings',{...f.p,targetChatId:chat.id});
  await f.service.invoke('page/settings',{...f.p,pageZoom:75,pageView:'half'});
  assert.equal(f.node.targetChatId,chat.id);
  const reopened=new CanvasStore(f.directory).node(f.board.id,f.node.id).node;
  assert.deepEqual([reopened.pageZoom,reopened.pageView,reopened.targetChatId],[75,'half',chat.id]);
  for(const invalid of [{pageZoom:0.75},{pageZoom:49},{pageZoom:201},{pageZoom:NaN},{pageZoom:'75'},{pageView:'overlay'},{targetChatId:'missing',pageZoom:100}]){
    await assert.rejects(f.service.invoke('page/settings',{...f.p,...invalid}));
    assert.deepEqual([f.node.pageZoom,f.node.pageView,f.node.targetChatId],[75,'half',chat.id]);
  }
  await f.service.invoke('page/settings',{...f.p,pageView:'full'});
  await f.service.invoke('page/settings',{...f.p,pageZoom:100});
  await f.service.invoke('page/settings',{...f.p,targetChatId:null});
  assert.deepEqual([f.node.pageZoom,f.node.pageView,f.node.targetChatId],[100,'full',null]);
});
test('Page discussion width validates atomically and persists independently of content and other view settings',async t=>{
  const f=await setup(t);await f.service.invoke('page/sync',f.p);
  const blocks=structuredClone(f.node.pageSnapshot.blocks);
  assert.equal((await f.service.invoke('page/settings',f.p)).pageDiscussionWidth,420);
  await f.service.invoke('page/settings',{...f.p,pageDiscussionWidth:580,pageZoom:75,pageView:'full'});
  assert.equal(new CanvasStore(f.directory).node(f.board.id,f.node.id).node.pageDiscussionWidth,580);
  for(const value of [319,801,420.5,'420',NaN,null]){
    await assert.rejects(f.service.invoke('page/settings',{...f.p,pageDiscussionWidth:value,pageView:'half'}),/width/);
    assert.deepEqual([f.node.pageDiscussionWidth,f.node.pageView,f.node.pageZoom],[580,'full',75]);
  }
  await f.service.invoke('page/settings',{...f.p,pageView:'half'});
  assert.equal(f.node.pageDiscussionWidth,580);assert.deepEqual(f.node.pageSnapshot.blocks,blocks);assert.equal(f.connector.edits,0);
});
test('connector approvals are concrete, redacted, explicit, isolated from native turn IDs and single-use',async t=>{
  const f=await setup(t),request={id:4,method:'mcpServer/elicitation/request',params:{threadId:'internal',mode:'form',message:'Approve?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{page_id:'page_test12345',token:'hidden'}}}};
  f.connector.emit('serverRequest',{request,context:{pageId:'page_test12345',operation:'edit_page'}});
  assert.equal(f.node.pendingApproval.requestId,'page:4');assert.doesNotMatch(f.node.pendingApproval.details,/hidden/);assert.equal(f.connector.reply,undefined);
  await f.service.invoke('approval/respond',{requestId:'page:4',decision:'accept'});assert.deepEqual(f.connector.reply,{id:4,result:{action:'accept',content:{},_meta:null}});
  await assert.rejects(f.service.invoke('approval/respond',{requestId:'page:4',decision:'accept'}),/already/);
});
test('a Page approval belongs to its requesting canvas and survives an unrelated chat connection restart',async t=>{
  const f=await setup(t),other=await f.service.invoke('board/create',{title:'Second canvas'}),linked=f.service.makeNode(f.store.board(other.id),'page',{url:f.node.pageUrl});
  const request={id:8,method:'mcpServer/elicitation/request',params:{threadId:'internal',mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{page_id:'page_test12345'}}}};
  f.connector.emit('serverRequest',{request,context:{pageId:'page_test12345',operation:'edit_page',contextId:`${other.id}:${linked.id}`}});
  assert.equal(f.node.pendingApproval,undefined);assert.equal(linked.pendingApproval.requestId,'page:8');f.peer.emit('exit');
  assert.equal(linked.status,'awaiting-approval');assert.equal(linked.pendingApproval.requestId,'page:8');await f.service.invoke('approval/respond',{requestId:'page:8',decision:'decline'});assert.equal(f.connector.reply.result.action,'decline');
});
test('ordinary chat queue freezes its current Page target before another Page retargets the chat',async t=>{
  const f=await setup(t),chat=f.service.makeNode(f.board,'chat');chat.pageTargetId=f.node.id;
  await f.service.send({boardId:f.board.id,nodeId:chat.id,text:'Work first'});await f.service.enqueue({boardId:f.board.id,nodeId:chat.id,text:'Update that Page later'});
  const next=f.service.makeNode(f.board,'page',{url:'https://chatgpt.com/space/page_newtarget123'});chat.pageTargetId=next.id;f.peer.finish(f.peer.calls[0]);for(let i=0;i<5;i++)await tick();
  assert.match(f.peer.calls[1].text,/page_test12345/);assert.doesNotMatch(f.peer.calls[1].text,/page_newtarget123/);
});
test('Page media rejects paths, symlinks, altered bytes and unsupported formats',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-page-media-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const media=new PageMediaStore(directory),asset=media.import({mime:'text/html',text:'<p>exact source</p>'});
  assert.equal(media.response(asset.url).status,200);assert.equal(media.response(`${asset.url}/../secret`).status,404);assert.equal(media.response('file:///etc/passwd').status,404);assert.throws(()=>media.path('../private'));
  fs.writeFileSync(media.path(asset.id),'altered');assert.equal(media.response(asset.url).status,404);
  fs.rmSync(media.path(asset.id));fs.symlinkSync('/etc/hosts',media.path(asset.id));assert.equal(media.response(asset.url).status,404);
  assert.throws(()=>media.import({mime:'application/javascript',text:'alert(1)'}),/PNG/);
});
test('new wide Page cards do not cover existing cards or change their saved positions',async t=>{
  const f=await setup(t),before=structuredClone(f.node.position),second=f.service.makeNode(f.board,'page',{url:'https://chatgpt.com/space/page_second123'});
  assert.deepEqual(f.node.position,before);assert.ok(second.position.x>=f.node.position.x+f.node.width+35||second.position.y>=f.node.position.y+f.node.height+35);
});
test('agent completion refreshes after an older in-flight Page read instead of retaining its stale snapshot',async t=>{
  const f=await setup(t),chat=f.service.makeNode(f.board,'chat');chat.pageTargetId=f.node.id;
  await f.service.send({boardId:f.board.id,nodeId:chat.id,text:'Edit the Page'});
  let release;const stale=structuredClone(f.connector.snapshot),normal=f.connector.read.bind(f.connector);
  f.connector.read=async()=>{f.connector.read=normal;return new Promise(resolve=>{release=()=>resolve(stale)})};
  const inFlight=f.service.invoke('page/sync',f.p);await tick();f.connector.snapshot.blocks[0]={id:'block-one',hash:'latest',markdown:'Agent finished update'};
  f.peer.finish(f.peer.calls[0]);release();await inFlight;for(let i=0;i<10;i++)await tick();
  assert.equal(f.node.pageSnapshot.blocks[0].markdown,'Agent finished update');
});
test('resolved and disconnected Page approvals disappear without affecting another native request',async t=>{
  const f=await setup(t),request={id:19,method:'mcpServer/elicitation/request',params:{mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{page_id:'page_test12345'}}}},context={pageId:'page_test12345',operation:'read_page',contextId:`${f.board.id}:${f.node.id}`};
  f.connector.emit('serverRequest',{request,context});f.connector.emit('requestResolved',{requestId:19});assert.equal(f.node.pendingApproval,undefined);await assert.rejects(f.service.invoke('approval/respond',{requestId:'page:19',decision:'accept'}),/already/);
  f.connector.emit('serverRequest',{request:{...request,id:20},context});f.connector.emit('connectionError',{message:'Page connection stopped'});assert.equal(f.node.pendingApproval,undefined);assert.equal(f.node.pageSyncStatus,'error');assert.match(f.node.pageSyncError,/stopped/);
});
test('host-dependent HTML fragments receive local styles without changing their canonical source or standalone documents',async t=>{
  const f=await setup(t),source='<div style="color:var(--foreground)"><svg><circle class="core" style="fill:var(--viz-series-2)"/></svg><button class="btn" aria-pressed="true">Copy</button></div>',asset=f.service.pageMedia.import({mime:'text/html',text:source});
  assert.equal(fs.readFileSync(f.service.pageMedia.path(asset.id),'utf8'),source);
  const rendered=await f.service.pageMedia.response(asset.url).text();assert.ok(rendered.includes(source));assert.match(rendered,/data-tangent-page-host/);assert.match(rendered,/--viz-series-2:#ad6726/);assert.match(rendered,/system-ui/);
  const standalone='<!doctype html><html><style>body{font:18px Arial}</style><body>Author styles</body></html>';assert.equal(visualizationDocument(standalone),standalone);
  assert.equal(f.service.pageMedia.response(asset.url).headers.get('Cache-Control'),'private, no-cache');
});

test('Page new discussion applies its permission choice and existing targets retain their own policy',async t=>{
  const f=await setup(t);
  const first=await f.service.invoke('page/ask',{...f.p,text:'Review permissions',chatId:null,permissionMode:'auto'});
  assert.equal(first.permissionMode,'auto');
  assert.equal(f.service.options(f.board,first).approvalsReviewer,'auto_review');
  f.peer.finish(f.peer.calls[0]);
  await f.service.invoke('page/ask',{...f.p,text:'Existing target keeps its choice',chatId:first.id,permissionMode:'full'});
  assert.equal(f.store.node(f.board.id,first.id).node.permissionMode,'auto');
  const count=f.board.nodes.length;
  await assert.rejects(f.service.invoke('page/ask',{...f.p,text:'Bad policy',chatId:null,permissionMode:'bad'}),/permission mode/);
  assert.equal(f.board.nodes.length,count);
});
