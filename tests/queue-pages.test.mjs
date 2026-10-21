import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CanvasService} from '../electron/service.mjs';
import {CanvasStore} from '../electron/store.mjs';
import {canonicalPageUrl} from '../electron/pages.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
class Peer extends EventEmitter{
 constructor(){super();this.turn=0;this.calls=[];this.connection={connected:true,model:'alpha',effort:'medium',models:[{id:'alpha',model:'alpha',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'},{id:'beta',model:'beta',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}]}}
 async start(){return this.connection}
 async close(){}
 async newThread(){return{id:'thread-'+Math.random()}}
 async resumeThread(){}
 async sendTurn(threadId,text,options){this.calls.push({method:'start',threadId,text,options});this.beforeStart?.();if(this.startError)throw Error(this.startError);const turn={id:'turn-'+(++this.turn)};this.emit('notification',{method:'turn/started',params:{threadId,turn}});if(this.instant)this.finish(threadId,turn.id);if(this.startGate)await this.startGate;return turn}
 async steerTurn(threadId,text,options){this.calls.push({method:'steer',threadId,text,options});this.beforeSteer?.();if(this.steerError)throw Error(this.steerError);return{turnId:options.expectedTurnId}}
 respond(requestId,result){this.calls.push({method:'respond',requestId,result})}
 reject(requestId,message){this.calls.push({method:'reject',requestId,message})}
 finish(threadId,turnId,status='completed'){this.emit('notification',{method:'turn/completed',params:{threadId,turn:{id:turnId,status}}})}
 async interrupt(threadId,turnId){this.finish(threadId,turnId,'interrupted')}
}
async function setup(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'tangent-queue-'));const store=new CanvasStore(directory),peer=new Peer(),service=new CanvasService(store,peer);await service.connect();const board=store.state.boards[0],node=service.makeNode(board,'chat');const p={boardId:board.id,nodeId:node.id};t.after(async()=>{await service.close();fs.rmSync(directory,{recursive:true,force:true})});return{directory,store,peer,service,board,node,p}}

test('queue persists before acknowledgement, dispatches FIFO once and keeps cards separate',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'first'});
 await f.service.enqueue({...f.p,text:'second'});await f.service.enqueue({...f.p,text:'third'});
 assert.equal(f.peer.calls.length,1);assert.equal(JSON.parse(fs.readFileSync(f.store.file)).boards[0].nodes[0].queue.length,2);
 const other=f.service.makeNode(f.board,'chat');await f.service.send({...f.p,nodeId:other.id,text:'unrelated'});
 f.peer.finish(f.node.threadId,f.node.activeTurnId);await tick();await tick();
 assert.deepEqual(f.peer.calls.filter(c=>c.threadId===f.node.threadId).map(c=>c.text),['first','second']);assert.equal(f.node.queue.length,1);
 f.peer.finish(f.node.threadId,f.node.activeTurnId);await tick();await tick();
 assert.deepEqual(f.peer.calls.filter(c=>c.threadId===f.node.threadId).map(c=>c.text),['first','second','third']);assert.equal(other.status,'running');assert.equal(f.node.queue.length,0);
});
test('edit, reorder and remove queued work determine actual delivery order',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});
 const a=await f.service.enqueue({...f.p,text:'a'}),b=await f.service.enqueue({...f.p,text:'b'}),c=await f.service.enqueue({...f.p,text:'remove'});
 await f.service.queueAction('queue/update',{...f.p,queueId:b.id,text:'edited b'});
 await f.service.queueAction('queue/reorder',{...f.p,queueIds:[b.id,a.id,c.id]});await f.service.queueAction('queue/remove',{...f.p,queueId:c.id});
 await assert.rejects(f.service.queueAction('queue/reorder',{...f.p,queueIds:[a.id,a.id]}),/queue changed/);
 f.peer.finish(f.node.threadId,f.node.activeTurnId);await tick();await tick();assert.equal(f.peer.calls.at(-1).text,'edited b');assert.equal(f.node.queue[0].id,a.id);
});
test('native steering stays in same turn with durable client identity and never starts a new one',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});const turnId=f.node.activeTurnId;
 f.peer.beforeSteer=()=>{const n=JSON.parse(fs.readFileSync(f.store.file)).boards[0].nodes[0];assert.equal(n.messages.at(-1).deliveryStatus,'sending');assert.equal(n.messages.at(-1).text,'new direction')};
 f.node.draft='new direction';await f.service.steer({...f.p,text:'new direction'});
 assert.equal(f.node.activeTurnId,turnId);assert.equal(f.peer.calls.filter(c=>c.method==='start').length,1);assert.equal(f.peer.calls.at(-1).options.expectedTurnId,turnId);assert.equal(f.peer.calls.at(-1).options.clientUserMessageId,f.node.messages.at(-1).id);assert.equal(f.node.messages.at(-1).deliveryStatus,'accepted');assert.equal(f.node.draft,'');
});
test('a stale steering rejection remains visibly unsent, preserves draft and never starts another turn',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});f.node.draft='do not lose';f.peer.steerError='turn no longer active';await assert.rejects(f.service.steer({...f.p,text:'do not lose'}),/no longer/);
 assert.equal(f.node.draft,'do not lose');assert.equal(f.node.messages.at(-1).deliveryStatus,'failed');assert.equal(f.peer.calls.filter(c=>c.method==='start').length,1);
 f.peer.finish(f.node.threadId,f.node.activeTurnId);await assert.rejects(f.service.steer({...f.p,text:'late'}),/already finished/);assert.equal(f.peer.calls.length,2);
});
test('stop and disconnect pause backlog until explicit resume',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});await f.service.enqueue({...f.p,text:'later'});await f.service.invoke('node/stop',f.p);await tick();assert.equal(f.node.queuePaused,true);assert.equal(f.peer.calls.length,1);
 await f.service.queueAction('queue/resume',f.p);await tick();await tick();assert.equal(f.peer.calls.length,2);
 await f.service.enqueue({...f.p,text:'after disconnect'});f.peer.emit('exit');await tick();assert.equal(f.node.queuePaused,true);assert.equal(f.node.queue.length,1);
});
test('stop still interrupts the native agent when saving the paused queue fails',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});await f.service.enqueue({...f.p,text:'later'});
 const threadId=f.node.threadId,turnId=f.node.activeTurnId,interrupt=f.peer.interrupt.bind(f.peer),flush=f.store.flush.bind(f.store);let stopped;
 f.peer.interrupt=async(thread,turn)=>{stopped={thread,turn};return interrupt(thread,turn)};
 f.store.flush=()=>{throw Error('disk full')};
 try{await assert.rejects(f.service.invoke('node/stop',f.p),/disk full/)}finally{f.store.flush=flush}
 await tick();assert.deepEqual(stopped,{thread:threadId,turn:turnId});assert.equal(f.node.status,'interrupted');assert.equal(f.node.queuePaused,true);assert.equal(f.node.activeTurnId,undefined);assert.equal(f.peer.calls.length,1);assert.equal(f.node.queue[0].text,'later');
});
test('failed queued delivery pauses later messages without silently replaying',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});await f.service.enqueue({...f.p,text:'failed'});await f.service.enqueue({...f.p,text:'later'});f.peer.startError='offline';f.peer.finish(f.node.threadId,f.node.activeTurnId);await tick();await tick();assert.equal(f.node.queue[0].status,'failed');assert.equal(f.node.queuePaused,true);await assert.rejects(f.service.queueAction('queue/resume',f.p),/failed messages/);assert.equal(f.peer.calls.length,2);
});
test('instant completion before start acknowledgement drains next message only once',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});await f.service.enqueue({...f.p,text:'instant 1'});await f.service.enqueue({...f.p,text:'instant 2'});f.peer.instant=true;f.peer.finish(f.node.threadId,f.node.activeTurnId);for(let i=0;i<10;i++)await tick();assert.deepEqual(f.peer.calls.map(c=>c.text),['active','instant 1','instant 2']);assert.equal(f.node.queue.length,0);assert.equal(f.node.status,'idle');
});
test('send-now steers queued text without duplicating queue or starting another turn',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});const q=await f.service.enqueue({...f.p,text:'urgent'});await f.service.queueAction('queue/send-now',{...f.p,queueId:q.id});assert.equal(f.peer.calls.at(-1).method,'steer');assert.equal(f.node.queue.length,0);assert.equal(f.peer.calls.filter(c=>c.method==='start').length,1);
});
test('restart pauses pending work and marks unacknowledged delivery uncertain',async t=>{
 const f=await setup(t);f.node.queue=[{id:'pending',text:'a',status:'queued'},{id:'inflight',text:'b',status:'sending'}];f.node.messages.push({id:'steering',text:'c',role:'user',deliveryStatus:'sending'});f.store.touch();f.store.flush();const recovered=new CanvasStore(f.directory).state.boards[0].nodes[0];assert.equal(recovered.queuePaused,true);assert.equal(recovered.queue[0].status,'queued');assert.equal(recovered.queue[1].status,'uncertain');assert.equal(recovered.messages[0].deliveryStatus,'uncertain');
});
test('per-chat model and effort apply at next turn without changing another chat or global default',async t=>{
 const f=await setup(t),other=f.service.makeNode(f.board,'chat');await f.service.nodeSettings({...f.p,model:'beta',effort:'low'});assert.equal(f.node.effort,'high');assert.equal(f.service.options(f.board,f.node).model,'beta');assert.equal(f.service.options(f.board,other).model,'alpha');assert.equal(f.service.connection.model,'alpha');await f.service.send({...f.p,text:'use beta'});assert.equal(f.peer.calls.at(-1).options.model,'beta');assert.equal(f.peer.calls.at(-1).options.effort,'high');await assert.rejects(Promise.resolve().then(()=>f.service.nodeSettings({...f.p,model:'unknown'})),/catalog/);
});
test('rich Page tool creates a durable linked card once and page discussions retain exact original URL',async t=>{
 const f=await setup(t);const url='https://chatgpt.com/space/page_QueueFixture123456';const result=f.service.pageTool(f.board,f.node,{action:'attach',url,title:'Biology'});const again=f.service.pageTool(f.board,f.node,{action:'attach',url});assert.equal(result.nodeId,again.nodeId);assert.equal(f.board.nodes.filter(n=>n.kind==='page').length,1);assert.equal(f.board.edges.length,1);const page=f.board.nodes.find(n=>n.id===result.nodeId);assert.equal(page.pageUrl,url);assert.equal(new CanvasStore(f.directory).state.boards[0].nodes.find(n=>n.id===page.id).pageUrl,url);
 const comment=await f.service.invoke('page/ask',{boardId:f.board.id,nodeId:page.id,text:'Explain this Page'});assert.equal(comment.pageTargetId,page.id);assert.match(f.peer.calls.at(-1).text,/page_QueueFixture123456/);assert.match(f.peer.calls.at(-1).text,/Do not create a replacement/);
});
test('Page links reject foreign origins, credentials and guessed paths, stripping optional tracking only',()=>{
 assert.equal(canonicalPageUrl('https://chatgpt.com/space/page_abcdefgh/?source=test#x'),'https://chatgpt.com/space/page_abcdefgh');for(const url of ['http://chatgpt.com/space/page_a','https://evil.test/space/page_a','https://chatgpt.com.evil.test/space/page_a','https://user:pass@chatgpt.com/space/page_a','https://chatgpt.com/c/a','https://chatgpt.com:444/space/page_a'])assert.throws(()=>canonicalPageUrl(url));
});
test('assistant Page link auto-attaches for older threads without explicit new tool',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'create a page'});f.peer.emit('notification',{method:'item/completed',params:{threadId:f.node.threadId,turnId:f.node.activeTurnId,item:{type:'agentMessage',id:'reply',text:'Created [Page](https://chatgpt.com/space/page_example01)'}}});assert.equal(f.board.nodes.filter(n=>n.kind==='page').length,1);const appContext=f.peer.calls[0].options.additionalContext;assert.match(appContext.tangent_canvas_surface.value,/canvas_page/);assert.doesNotMatch(f.peer.calls[0].text,/app context/);
});

test('compaction refreshes scoped app routing without replacing inherited developer instructions',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'start'});const first=f.service.options(f.board,f.node).additionalContext.tangent_canvas_surface.value;
 f.peer.emit('notification',{method:'thread/compacted',params:{threadId:f.node.threadId}});const next=f.service.options(f.board,f.node);assert.match(next.additionalContext.tangent_canvas_surface.value,/Context refresh 1/);assert.notEqual(next.additionalContext.tangent_canvas_surface.value,first);assert.equal(next.developerInstructions,undefined);
});
test('a queue cannot secretly resume after offline submission',async t=>{
 const f=await setup(t);f.peer.emit('exit');await f.service.enqueue({...f.p,text:'when online'});assert.equal(f.node.queuePaused,true);await assert.rejects(f.service.queueAction('queue/resume',f.p),/Reconnect/);assert.equal(f.peer.calls.length,0);
});

test('failed Page attachment save rolls back card, edge, and existing document target',async t=>{
 const f=await setup(t);f.node.documentTargetId='keep-local';f.store.flush();const flush=f.store.flush.bind(f.store);f.store.flush=()=>{throw Error('disk full')};assert.throws(()=>f.service.linkPage({...f.p,url:'https://chatgpt.com/space/page_example01'}),/disk full/);assert.equal(f.board.nodes.length,1);assert.equal(f.board.edges.length,0);assert.equal(f.node.documentTargetId,'keep-local');assert.equal(f.node.pageTargetId,undefined);f.store.flush=flush;
});
test('attaching an existing Page to a different chat creates provenance without duplicating the Page',async t=>{
 const f=await setup(t);const url='https://chatgpt.com/space/page_example01';const linked=f.service.linkPage({...f.p,url});const other=f.service.makeNode(f.board,'chat');other.documentTargetId='old-local';f.service.linkPage({...f.p,nodeId:other.id,url});assert.equal(f.board.nodes.filter(n=>n.kind==='page').length,1);assert.equal(other.pageTargetId,linked.id);assert.equal(other.documentTargetId,undefined);assert.equal(f.board.edges.length,2);
});
const mcpRequest=(f,id,extra={})=>({id,method:'mcpServer/elicitation/request',params:{threadId:f.node.threadId,turnId:f.node.activeTurnId,serverName:'codex_apps',mode:'form',message:'Do you approve running tool "chatgpt_space.create_page"?',requestedSchema:{type:'object',properties:{}},_meta:{codex_approval_kind:'mcp_tool_call',tool_params:{title:'A private Page',api_key:'keep-this-secret',nested:{password:'also-secret'},url:'https://example.test/?access_token=private',markdown:'hidden contents'}},...extra}});
test('MCP Page approvals show a concrete redacted request and return native accept/decline actions',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'create a page'});
 for(const mode of ['form','openai/form','openaiForm']){
  const request=mcpRequest(f,'mcp-'+mode,{mode});f.peer.emit('serverRequest',request);
  assert.equal(f.node.status,'awaiting-approval');assert.match(f.node.pendingApproval.title,/chatgpt_space.create_page/);assert.match(f.node.pendingApproval.details,/A private Page/);assert.doesNotMatch(f.node.pendingApproval.details,/keep-this-secret|also-secret|access_token=private|hidden contents/);
  assert.match(f.node.pendingApproval.details,/redacted/);assert.equal(f.node.pendingApproval.kind,'mcpServer/elicitation/request');
  await f.service.invoke('approval/respond',{requestId:request.id,decision:'accept'});assert.deepEqual(f.peer.calls.at(-1),{method:'respond',requestId:request.id,result:{action:'accept',content:{},_meta:null}});assert.equal(f.node.status,'running');
 }
 f.peer.emit('serverRequest',mcpRequest(f,'decline'));await f.service.invoke('approval/respond',{requestId:'decline',decision:'decline'});assert.deepEqual(f.peer.calls.at(-1).result,{action:'decline',content:null,_meta:null});assert.equal(f.node.pendingApproval,undefined);
 await assert.rejects(f.service.invoke('approval/respond',{requestId:'decline',decision:'accept'}),/already/);
});
test('MCP approvals reject unsupported forms and stale or parallel requests without losing the visible approval',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});
 const unsupported=[{mode:'url',url:'https://example.test/'},{mode:'openai/userVerification'},{requestedSchema:{type:'object',properties:{name:{type:'string'}}}},{requestedSchema:{type:'object',properties:{},required:['missing']}},{_meta:{codex_approval_kind:'something_else'}},{turnId:'old-turn'}];
 for(let i=0;i<unsupported.length;i++){f.peer.emit('serverRequest',mcpRequest(f,'unsupported-'+i,unsupported[i]));assert.equal(f.peer.calls.at(-1).method,'reject');assert.equal(f.node.pendingApproval,undefined);assert.equal(f.service.pending.size,0)}
 f.peer.emit('serverRequest',mcpRequest(f,'visible'));f.peer.emit('serverRequest',mcpRequest(f,'parallel'));assert.equal(f.node.pendingApproval.requestId,'visible');assert.equal(f.peer.calls.at(-1).requestId,'parallel');assert.deepEqual([...f.service.pending.keys()],['visible']);
 f.peer.emit('notification',{method:'serverRequest/resolved',params:{requestId:'visible'}});assert.equal(f.node.pendingApproval,undefined);await assert.rejects(f.service.invoke('approval/respond',{requestId:'visible',decision:'accept'}),/already/);
 f.peer.emit('serverRequest',mcpRequest(f,'finished'));f.peer.finish(f.node.threadId,f.node.activeTurnId);await assert.rejects(f.service.invoke('approval/respond',{requestId:'finished',decision:'accept'}),/already/);
});
test('stop cancels pending MCP approval before interrupt and cannot authorize it even if interruption fails',async t=>{
 const f=await setup(t);await f.service.send({...f.p,text:'active'});f.peer.emit('serverRequest',mcpRequest(f,'stopped'));
 f.peer.interrupt=async()=>{assert.equal(f.node.pendingApproval,undefined);assert.equal(f.service.pending.size,0);assert.deepEqual(f.peer.calls.at(-1),{method:'respond',requestId:'stopped',result:{action:'cancel',content:null,_meta:null}});throw Error('connection lost')};
 await assert.rejects(f.service.invoke('node/stop',f.p),/connection lost/);assert.equal(f.node.status,'interrupted');assert.equal(f.node.queuePaused,true);await assert.rejects(f.service.invoke('approval/respond',{requestId:'stopped',decision:'accept'}),/already/);assert.equal(f.peer.calls.filter(c=>c.method==='respond').length,1);
});

test('changing defaults affects new chats while existing and legacy chats keep their effective selection',async t=>{
 const f=await setup(t);assert.equal(f.node.model,'alpha');assert.equal(f.node.effort,'medium');
 await f.service.invoke('codex/settings',{model:'beta',effort:'high'});const newer=f.service.makeNode(f.board,'chat');assert.equal(newer.model,'beta');assert.equal(newer.effort,'high');assert.equal(f.service.options(f.board,f.node).model,'alpha');assert.equal(f.node.effort,'medium');
 delete newer.model;delete newer.effort;await f.service.connect();assert.equal(newer.model,'beta');assert.equal(newer.effort,'high');await f.service.invoke('codex/settings',{model:'alpha',effort:'low'});assert.equal(newer.model,'beta');assert.equal(newer.effort,'high');
});
