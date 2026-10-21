import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';

const clone = value => structuredClone(value);
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return {promise,resolve,reject}; }
const tick = () => new Promise(resolve => setImmediate(resolve));

// A deterministic protocol double. Each thread owns a separate transcript;
// no canvas code gets to fake a model response or concatenate model context.
class FakeRuntime extends EventEmitter {
  constructor() {
    super(); this.calls=[];this.threads=new Map();this.counter=0;
    this.connection={connected:true,model:'test-model',effort:'medium',models:[{id:'test-model',model:'test-model',isDefault:true},{id:'other',model:'other'}]};
  }
  record(method,...args) { this.calls.push({method,args:clone(args)}); }
  async start() { this.record('start');return clone(this.connection); }
  async close() { this.record('close'); }
  async newThread(options) {
    this.record('newThread',options);if(this.newGate)await this.newGate.promise;
    const thread={id:`thread-${++this.counter}`,cwd:options.cwd,turns:[]};this.threads.set(thread.id,thread);return clone(thread);
  }
  async readThread(id) { this.record('readThread',id);return clone(this.threads.get(id)); }
  async resumeThread(id,options) { this.record('resumeThread',id,options);return clone(this.threads.get(id)); }
  async forkThread(id,options={}) {
    this.record('forkThread',id,options);if(this.forkGate)await this.forkGate.promise;
    const source=this.threads.get(id),index=options.turnId?source.turns.findIndex(t=>t.id===options.turnId):source.turns.length-1;
    if(options.turnId)assert.notEqual(index,-1,'Fake native fork must be passed an actual source turn');
    const thread={...clone(source),id:`thread-${++this.counter}`,turns:clone(source.turns.slice(0,index+1))};this.threads.set(thread.id,thread);return clone(thread);
  }
  async sendTurn(threadId,text,options) {
    this.record('sendTurn',threadId,text,options);this.onBeforeSend?.();
    if(this.sendError)throw this.sendError;
    const turn={id:`turn-${++this.counter}`,status:'inProgress',items:[{id:`user-${this.counter}`,type:'userMessage',content:[{type:'text',text}]}]};
    this.threads.get(threadId).turns.push(turn);
    this.emit('notification',{method:'turn/started',params:{threadId,turn:clone(turn)}});
    if(this.completeBeforeReply)this.complete(threadId,turn.id,'instant answer');
    if(this.sendGate)await this.sendGate.promise;
    return clone(turn);
  }
  complete(threadId,turnId,text,status='completed') {
    const turn=this.threads.get(threadId).turns.find(t=>t.id===turnId);turn.status=status;
    if(text!==undefined){const item={id:`assistant-${turnId}`,type:'agentMessage',text};turn.items.push(item);this.emit('notification',{method:'item/completed',params:{threadId,turnId,item:clone(item)}});}
    this.emit('notification',{method:'turn/completed',params:{threadId,turn:clone(turn)}});
  }
  async interrupt(threadId,turnId) { this.record('interrupt',threadId,turnId);this.complete(threadId,turnId,undefined,'interrupted'); }
  respond(id,result) { this.record('respond',id,result); }
  reject(id,message) { this.record('reject',id,message); }
  async listThreads() { return {data:[...this.threads.values()].map(clone)}; }
}

async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'tangent-service-'));
  const store=new CanvasStore(directory),runtime=new FakeRuntime(),service=new CanvasService(store,runtime);
  await service.connect();
  const board=store.state.boards[0];
  const create=(kind='chat')=>service.makeNode(board,kind);
  const send=(node,text)=>service.send({boardId:board.id,nodeId:node.id,text});
  const finish=(node,text)=>runtime.complete(node.threadId,node.activeTurnId,text);
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  return {directory,store,runtime,service,board,create,send,finish};
}

test('historical branch includes exactly the selected reply and never contaminates its parent',async t=>{
  const f=await fixture(t),main=f.create();
  await f.send(main,'Remember main_marker=MARBLE-83');f.finish(main,'Main marker MARBLE-83.');
  const first=main.messages.find(m=>m.role==='assistant');
  await f.send(main,'Remember main_marker=ORBIT-29');f.finish(main,'Main marker ORBIT-29.');
  const before=clone(f.runtime.threads.get(main.threadId));
  const child=await f.service.branch({boardId:f.board.id,nodeId:main.id,messageId:first.id,text:'Remember side_marker=BRONZE-61'});
  const forkCall=f.runtime.calls.find(c=>c.method==='forkThread');
  assert.equal(forkCall.args[1].turnId,first.turnId);
  assert.notEqual(child.threadId,main.threadId);
  assert.equal(child.inheritedCount,2);
  assert.deepEqual(child.messages.slice(0,2),main.messages.slice(0,2));
  const history=JSON.stringify(f.runtime.threads.get(child.threadId));
  assert.match(history,/MARBLE-83/);assert.doesNotMatch(history,/ORBIT-29/);
  assert.match(history,/Earlier messages are reference context/);
  assert.deepEqual(f.runtime.threads.get(main.threadId),before);
  assert.doesNotMatch(JSON.stringify(main),/BRONZE-61/);
  f.runtime.complete(child.threadId,child.activeTurnId,'Side marker BRONZE-61.');
  assert.doesNotMatch(JSON.stringify(main),/BRONZE-61/);
  const edge=f.board.edges.find(e=>e.target===child.id);assert.equal(edge.sourceMessageId,first.id);
});

test('quoted comment forks and sends automatically once, retaining exact quote and clean parent',async t=>{
  const f=await fixture(t),main=f.create();await f.send(main,'Explain gradients');f.finish(main,'A gradient describes local change.');
  const source=main.messages.at(-1),before=clone(main);
  const child=await f.service.branch({boardId:f.board.id,nodeId:main.id,kind:'comment',messageId:source.id,quote:'local change',text:'Why local?'});
  const sends=f.runtime.calls.filter(c=>c.method==='sendTurn'&&c.args[0]===child.threadId);
  assert.equal(sends.length,1);assert.match(sends[0].args[1],/Comment on this passage:\n\nlocal change\n\nWhy local\?/);
  assert.equal(child.kind,'comment');assert.equal(child.sourceMessageId,source.id);assert.deepEqual(main,before);
  f.runtime.complete(child.threadId,child.activeTurnId,'It concerns nearby inputs.');
  const stored=f.store.node(f.board.id,child.id).node;
  assert.equal(stored.messages.at(-1).text,'It concerns nearby inputs.');assert.equal(main.messages.length,2);
});

test('different cards run concurrently while a second send to the same busy card is rejected',async t=>{
  const f=await fixture(t),a=f.create(),b=f.create();
  await Promise.all([f.send(a,'Task A'),f.send(b,'Task B')]);
  assert.notEqual(a.threadId,b.threadId);assert.equal(a.status,'running');assert.equal(b.status,'running');
  await assert.rejects(f.send(a,'Do not queue this'),/already working/);
  f.finish(b,'B answer');assert.equal(b.status,'idle');assert.equal(a.status,'running');assert.equal(a.messages.length,1);
  f.finish(a,'A answer');assert.equal(a.messages.at(-1).text,'A answer');
});

test('a queued branch permits at most one pending user send while the native fork is unresolved',async t=>{
  const f=await fixture(t),main=f.create();await f.send(main,'Parent');f.finish(main,'Parent answer');
  f.runtime.forkGate=deferred();
  const branching=f.service.branch({boardId:f.board.id,nodeId:main.id});await tick();
  const child=f.board.nodes.find(n=>n.parentId===main.id);
  const first=f.send(child,'One pending question');await tick();
  const second=f.send(child,'Duplicate pending question');const rejected=assert.rejects(second,/already working|pending|creating/i);
  f.runtime.forkGate.resolve();await branching;await first;await rejected;
  assert.equal(f.runtime.calls.filter(c=>c.method==='sendTurn'&&c.args[0]===child.threadId).length,1);
});

test('stop during a pending comment fork cancels its automatic question',async t=>{
  const f=await fixture(t),main=f.create();await f.send(main,'Parent');f.finish(main,'Parent answer');
  f.runtime.forkGate=deferred();
  const branching=f.service.branch({boardId:f.board.id,nodeId:main.id,kind:'comment',text:'Cancel this comment'});await tick();
  const child=f.board.nodes.find(n=>n.parentId===main.id);
  await f.service.invoke('node/stop',{boardId:f.board.id,nodeId:child.id});
  f.runtime.forkGate.resolve();await branching.catch(()=>{});await tick();
  assert.equal(f.runtime.calls.filter(c=>c.method==='sendTurn').length,1,'Only the original parent turn should have been sent');
  assert.equal(child.status,'interrupted');
});

test('interrupted partial output cannot become a completed historical branch boundary',async t=>{
  const f=await fixture(t),main=f.create();await f.send(main,'Parent');const turn=main.activeTurnId;
  f.runtime.emit('notification',{method:'item/agentMessage/delta',params:{threadId:main.threadId,turnId:turn,itemId:'partial',delta:'Unfinished answer'}});
  await f.service.invoke('node/stop',{boardId:f.board.id,nodeId:main.id});
  await assert.rejects(f.service.branch({boardId:f.board.id,nodeId:main.id,messageId:'partial'}),/completed|unfinished|interrupted|still/);
  assert.equal(f.runtime.calls.filter(c=>c.method==='forkThread').length,0);
});

test('import forks the source without resuming it or changing its transcript',async t=>{
  const f=await fixture(t);const source={id:'external-original',cwd:'/original/project',name:'Original',turns:[{id:'source-turn',status:'completed',items:[{id:'source-user',type:'userMessage',content:[{type:'text',text:'Original question'}]},{id:'source-answer',type:'agentMessage',text:'Original answer'}]}]};
  f.runtime.threads.set(source.id,clone(source));
  const imported=await f.service.importThread({boardId:f.board.id,threadId:source.id});
  assert.notEqual(imported.threadId,source.id);assert.equal(imported.importedFrom,source.id);assert.equal(imported.messages.at(-1).turnId,'source-turn');
  assert.deepEqual(f.runtime.threads.get(source.id),source);
  assert.equal(f.runtime.calls.filter(c=>c.method==='resumeThread'&&c.args[0]===source.id).length,0);
  await f.send(f.store.node(f.board.id,imported.id).node,'Separate follow-up');
  assert.deepEqual(f.runtime.threads.get(source.id),source);
});

test('imported chats use the explicitly requested full-access default without changing the project choice',async t=>{
  const f=await fixture(t);f.runtime.threads.set('external',{id:'external',cwd:'/original/project',turns:[]});
  await f.service.importThread({boardId:f.board.id,threadId:'external'});
  assert.equal(f.board.projectPath,null,'Importing is not choosing a writable project');
  assert.equal(f.runtime.calls.find(c=>c.method==='forkThread').args[1].sandbox,'danger-full-access');
});

test('outbound request sees the user message already durable on disk',async t=>{
  const f=await fixture(t),node=f.create();f.store.flush();
  f.runtime.onBeforeSend=()=>{
    const disk=JSON.parse(fs.readFileSync(f.store.file,'utf8'));
    assert.equal(disk.boards[0].nodes[0].messages.at(-1)?.text,'Must survive a crash');
  };
  await f.send(node,'Must survive a crash');
});

test('stop during thread startup prevents a late outbound turn',async t=>{
  const f=await fixture(t),node=f.create();f.runtime.newGate=deferred();
  const sending=f.send(node,'A task that I cancel');await tick();
  assert.equal(node.status,'starting');await f.service.invoke('node/stop',{boardId:f.board.id,nodeId:node.id});
  f.runtime.newGate.resolve();await sending.catch(()=>{});await tick();
  assert.equal(f.runtime.calls.filter(c=>c.method==='sendTurn').length,0,'Stopping startup must cancel its pending send');
  assert.equal(node.status,'interrupted');
});

test('a completed notification arriving before send response does not resurrect an active turn',async t=>{
  const f=await fixture(t),node=f.create();f.runtime.completeBeforeReply=true;
  await f.send(node,'Answer instantly');
  assert.equal(node.status,'idle');assert.equal(node.activeTurnId,undefined);
  assert.equal(node.messages.at(-1).text,'instant answer');
});

test('stop while turn start response is pending interrupts it and cannot resurrect the card',async t=>{
  const f=await fixture(t),node=f.create();f.runtime.sendGate=deferred();
  const sending=f.send(node,'Cancel this pending response');await tick();
  const turn=node.activeTurnId;assert.ok(turn);
  await f.service.invoke('node/stop',{boardId:f.board.id,nodeId:node.id});
  f.runtime.sendGate.resolve();await sending.catch(()=>{});await tick();
  assert.equal(node.status,'interrupted');assert.equal(node.activeTurnId,undefined);
  assert.equal(f.runtime.calls.filter(c=>c.method==='interrupt'&&c.args[1]===turn).length,1);
});

test('stop interrupts only its own thread and leaves other running cards alone',async t=>{
  const f=await fixture(t),a=f.create(),b=f.create();await Promise.all([f.send(a,'A'),f.send(b,'B')]);
  const bTurn=b.activeTurnId,aTurn=a.activeTurnId;
  await f.service.invoke('node/stop',{boardId:f.board.id,nodeId:a.id});
  assert.equal(a.status,'interrupted');assert.equal(b.status,'running');assert.equal(b.activeTurnId,bTurn);
  assert.deepEqual(f.runtime.calls.find(c=>c.method==='interrupt').args,[a.threadId,aTurn]);
});

test('failed network send retains the question and produces a visible retryable error',async t=>{
  const f=await fixture(t),node=f.create();f.runtime.sendError=Error('Provider unavailable');
  await assert.rejects(f.send(node,'Keep this question'),/Provider unavailable/);
  assert.equal(node.status,'error');assert.equal(node.error,'Provider unavailable');assert.equal(node.messages.at(-1).text,'Keep this question');
  f.runtime.sendError=null;await f.send(node,'Try again');assert.equal(node.status,'running');
});

test('approval and user question events stay on their card and return structured choices',async t=>{
  const f=await fixture(t),a=f.create(),b=f.create();await Promise.all([f.send(a,'A'),f.send(b,'B')]);
  f.runtime.emit('serverRequest',{id:17,method:'item/commandExecution/requestApproval',params:{threadId:a.threadId,command:'npm test',reason:'Run checks',cwd:'/tmp/project'}});
  assert.equal(a.status,'awaiting-approval');assert.equal(b.pendingApproval,undefined);assert.match(a.pendingApproval.details,/npm test/);
  await f.service.invoke('approval/respond',{requestId:'17',decision:'decline'});
  assert.deepEqual(f.runtime.calls.at(-1).args,[17,{decision:'decline'}]);assert.equal(a.pendingApproval,undefined);
  f.runtime.emit('serverRequest',{id:'question',method:'item/tool/requestUserInput',params:{threadId:b.threadId,questions:[{id:'choice',question:'Choose'}]}});
  await f.service.invoke('question/respond',{requestId:'question',answers:{choice:'Option A'}});
  assert.deepEqual(f.runtime.calls.at(-1).args,['question',{answers:{choice:{answers:['Option A']}}}]);
  await assert.rejects(f.service.invoke('approval/respond',{requestId:17,decision:'accept'}),/already/);
});

test('parallel approval requests cannot leave an invisible unanswered request behind',async t=>{
  const f=await fixture(t),node=f.create();await f.send(node,'Task');
  for(const requestId of ['first-approval','second-approval'])f.runtime.emit('serverRequest',{id:requestId,method:'item/commandExecution/requestApproval',params:{threadId:node.threadId,command:`echo ${requestId}`}});
  const shown=new Set([node.pendingApproval?.requestId,...(node.pendingApprovals||[]).map(p=>p.requestId)]);
  for(const requestId of f.service.pending.keys())assert.ok(shown.has(requestId),`${requestId} needs a visible control or explicit rejection`);
});

test('disconnect invalidates unanswered approvals instead of allowing stale acceptance',async t=>{
  const f=await fixture(t),node=f.create();await f.send(node,'Task');
  f.runtime.emit('serverRequest',{id:'stale',method:'item/fileChange/requestApproval',params:{threadId:node.threadId,reason:'Edit file'}});
  f.runtime.emit('exit',{code:1});
  assert.equal(node.status,'interrupted');assert.equal(node.pendingApproval,undefined);assert.equal(f.service.connection.connected,false);
  await assert.rejects(f.service.invoke('approval/respond',{requestId:'stale',decision:'accept'}),/already|closed|disconnected|expired/);
  assert.equal(f.runtime.calls.filter(c=>c.method==='respond').length,0);
});

test('turn completion invalidates its outstanding approval',async t=>{
  const f=await fixture(t),node=f.create();await f.send(node,'Task');
  f.runtime.emit('serverRequest',{id:'late',method:'item/commandExecution/requestApproval',params:{threadId:node.threadId,turnId:node.activeTurnId,command:'echo test'}});
  f.finish(node,'Already finished');
  await assert.rejects(f.service.invoke('approval/respond',{requestId:'late',decision:'accept'}),/already|expired|finished/);
});

test('unknown thread requests and unsupported tools are rejected rather than hanging',async t=>{
  const f=await fixture(t),node=f.create();await f.send(node,'Task');
  f.runtime.emit('serverRequest',{id:'foreign',method:'item/commandExecution/requestApproval',params:{threadId:'unowned'}});
  f.runtime.emit('serverRequest',{id:'unsupported',method:'future/interactiveTool',params:{threadId:node.threadId}});
  assert.deepEqual(f.runtime.calls.filter(c=>c.method==='reject').map(c=>c.args[0]),['foreign','unsupported']);
  assert.equal(f.service.pending.size,0);assert.equal(node.activities.at(-1).status,'failed');
});

test('reconnect applies saved model and reasoning choices',async t=>{
  const f=await fixture(t);await f.service.invoke('codex/settings',{model:'other',effort:'high'});
  await f.service.invoke('app/reconnect');
  assert.equal(f.service.connection.model,'other');assert.equal(f.service.connection.effort,'high');
});

test('late completion of an old turn cannot finish a newer running turn',async t=>{
  const f=await fixture(t),node=f.create();await f.send(node,'First');const old=node.activeTurnId;f.finish(node,'First answer');
  await f.send(node,'Second');const current=node.activeTurnId;
  f.runtime.emit('notification',{method:'turn/completed',params:{threadId:node.threadId,turn:{id:old,status:'completed'}}});
  assert.equal(node.activeTurnId,current);assert.equal(node.status,'running');
});


test('per-chat permissions default to full, persist, and isolate siblings, branches and queued turns',async t=>{
  const f=await fixture(t),one=f.create(),two=f.create();
  assert.equal(one.permissionMode,'full');assert.equal(two.permissionMode,'full');
  await f.send(one,'First');f.finish(one,'First answer');
  assert.equal(f.runtime.calls.find(c=>c.method==='newThread').args[0].sandbox,'danger-full-access');
  assert.equal(f.runtime.calls.find(c=>c.method==='sendTurn').args[2].approvalPolicy,'never');
  const result=f.service.nodeSettings({boardId:f.board.id,nodeId:one.id,permissionMode:'ask'});
  assert.equal(result.permissionMode,'ask');assert.equal(two.permissionMode,'full');
  await f.send(one,'Ask first');assert.equal(one.activePermissionMode,'ask');
  let call=f.runtime.calls.filter(c=>c.method==='sendTurn').at(-1).args[2];
  assert.equal(call.sandbox,'read-only');assert.equal(call.approvalsReviewer,'user');
  const busy=f.service.nodeSettings({boardId:f.board.id,nodeId:one.id,permissionMode:'auto'});
  assert.equal(busy.effectiveNextTurn,true);assert.equal(one.permissionMode,'auto');assert.equal(one.activePermissionMode,'ask');
  await f.service.enqueue({boardId:f.board.id,nodeId:one.id,text:'Queued with the next policy'});
  f.finish(one,'Done');await tick();await tick();
  call=f.runtime.calls.filter(c=>c.method==='sendTurn').at(-1).args[2];
  assert.equal(call.approvalsReviewer,'auto_review');assert.equal(one.activePermissionMode,'auto');
  f.finish(one,'Queued answer');await tick();
  const child=await f.service.branch({boardId:f.board.id,nodeId:one.id,kind:'comment',text:'A new side question'});
  assert.equal(child.permissionMode,'auto');
  assert.equal(f.runtime.calls.filter(c=>c.method==='forkThread').at(-1).args[1].approvalsReviewer,'auto_review');
  assert.equal(two.permissionMode,'full');
  assert.throws(()=>f.service.nodeSettings({boardId:f.board.id,nodeId:one.id,permissionMode:'fake'}),/permission mode/);
  assert.equal(one.permissionMode,'auto');
  f.store.flush();const reopened=new CanvasStore(f.directory);assert.equal(reopened.node(f.board.id,one.id).node.permissionMode,'auto');
});

test('changing a permission while initial creation is waiting applies only to the following turn',async t=>{
  const f=await fixture(t),node=f.create();f.runtime.newGate=deferred();
  const pending=f.send(node,'Begin in full access');await tick();
  f.service.nodeSettings({boardId:f.board.id,nodeId:node.id,permissionMode:'ask'});
  assert.equal(node.activePermissionMode,'full');
  f.runtime.newGate.resolve();await pending;
  const first=f.runtime.calls.filter(c=>c.method==='sendTurn').at(-1).args[2];assert.equal(first.approvalPolicy,'never');
  f.finish(node,'Done');await f.send(node,'Now ask first');
  assert.equal(f.runtime.calls.filter(c=>c.method==='sendTurn').at(-1).args[2].approvalsReviewer,'user');
  assert.equal(f.runtime.calls.filter(c=>c.method==='sendTurn').at(-1).args[2].sandbox,'read-only');
});
