import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanvasStore } from '../electron/store.mjs';
import { CardSummaries, cardSummarySource, summarySettings, normalizeCardSummary, MAX_SUMMARY_SOURCE_CHARS } from '../electron/card-summaries.mjs';

const clone = value => structuredClone(value);
const tick = () => new Promise(resolve => setImmediate(resolve));
const catalog = [{ model:'gpt-6-luna', id:'gpt-6-luna', supportedReasoningEfforts:[{reasoningEffort:'minimal'},{reasoningEffort:'low'},{reasoningEffort:'medium'}], serviceTiers:[{id:'priority',name:'Fast'}] }];
class Peer extends EventEmitter {
  constructor() { super(); this.calls=[];this.next=0;this.turns=new Map();this.active=0;this.peak=0;this.catalog=clone(catalog); }
  async start() { this.calls.push({method:'start'}); return {connected:true}; }
  async request(method,params={}) {
    this.calls.push({method,params:clone(params)});
    if(method==='model/list')return {data:clone(this.catalog)};
    if(method==='thread/start')return {thread:{id:`summary-${++this.next}`},model:this.wrongModel||params.model,serviceTier:params.serviceTier};
    if(method==='turn/start') {
      const turn={id:`turn-${params.threadId}`,status:'inProgress',items:[]};
      this.turns.set(params.threadId,{turn,params});this.active++;this.peak=Math.max(this.peak,this.active);
      this.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn:clone(turn)}});
      if(this.instant)this.complete(params.threadId);
      return {turn:clone(turn)};
    }
    if(method==='thread/unsubscribe')return {};
    throw Error(`Unexpected method ${method}`);
  }
  complete(id,output=`A concise summary for ${id}.`,status='completed') {
    const entry=this.turns.get(id);if(!entry||entry.turn.status!=='inProgress')return;
    this.active--;entry.turn.status=status;
    const item={id:`reply-${id}`,type:'agentMessage',text:output};entry.turn.items=[item];
    this.emit('notification',{method:'item/agentMessage/delta',params:{threadId:id,turnId:entry.turn.id,itemId:item.id,delta:output.slice(0,4)}});
    this.emit('notification',{method:'item/completed',params:{threadId:id,turnId:entry.turn.id,item}});
    this.emit('notification',{method:'turn/completed',params:{threadId:id,turn:clone(entry.turn)}});
  }
  reject(id,message) { this.calls.push({method:'reject',id,message}); }
  async interrupt(threadId,turnId) { this.calls.push({method:'interrupt',threadId,turnId}); const entry=this.turns.get(threadId);if(entry&&entry.turn.status==='inProgress'){entry.turn.status='interrupted';this.active--;} }
  async close() { this.calls.push({method:'close'});this.emit('exit'); }
}
async function setup(t,{count=1,instant=true,timeoutMs=1000}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'tangent-summary-')),store=new CanvasStore(directory),runtime=new Peer();runtime.instant=instant;
  const board=store.state.boards[0];board.nodes=Array.from({length:count},(_,i)=>({id:`card-${i}`,kind:'chat',title:`Card ${i}`,position:{x:i*200,y:0},messages:[{id:`message-${i}`,role:'user',text:`Substantive card ${i}`}],activities:[],status:'running',activeTurnId:`user-turn-${i}`,threadId:`original-${i}`,draft:`Unsent ${i}`,queue:[{id:`q-${i}`,status:'queued',text:`Later ${i}`}],queuePaused:true,inheritedCount:0,permissionMode:'full',model:'existing-model',effort:'high'}));
  const changes=[];const manager=new CardSummaries({store,runtime,changed:b=>{store.touch();changes.push(clone(b||store.state.boards[0]))},timeoutMs});
  t.after(async()=>{await manager.close();await rm(directory,{recursive:true,force:true})});
  return {directory,store,runtime,board,manager,changes,p:nodeId=>({boardId:board.id,nodeId:nodeId||board.nodes[0].id})};
}
async function waitTurns(peer,count) { for(let i=0;i<200;i++){if(peer.turns.size>=count)return;await tick()}assert.fail(`Expected ${count} turns, got ${peer.turns.size}`); }
const nonSummary = node => { const value=clone(node);delete value.summary;return value; };

test('requires exact GPT-6 Luna, Low and advertised Fast instead of substituting a model or effort',()=>{
  assert.deepEqual(summarySettings(catalog),{model:'gpt-6-luna',effort:'low',fast:true,serviceTier:'priority'});
  assert.throws(()=>summarySettings([{...catalog[0],model:'gpt-6.1-luna'}]),/No other model/);
  assert.throws(()=>summarySettings([{...catalog[0],supportedReasoningEfforts:['minimal']}]),/Low reasoning/);
  assert.throws(()=>summarySettings([{...catalog[0],serviceTiers:[]}]),/No slower mode/);
});

test('all card kinds use substantive local text; source is bounded and fingerprint ignores geometry and summary',()=>{
  const kinds=[['chat',{messages:[{role:'user',text:'User source'},{role:'assistant',text:'Answer'}],draft:'Draft',queue:[{text:'Later'}]}],['comment',{messages:[{role:'user',text:'Side question'}],quote:'Quoted passage'}],['note',{noteText:'Note source'}],['document',{documentMarkdown:'# Document source'}],['page',{pageSnapshot:{blocks:[{markdown:'Page source'}],comments:[{messages:[{body:'A comment'}]}]},pageDrafts:{b:{markdown:'Unsaved Page edit'}}}]];
  for(const [kind,fields]of kinds){const node={kind,title:'A title',...fields};const first=cardSummarySource(node);assert.equal(first.empty,false);assert.equal(cardSummarySource({...node,position:{x:900},summary:{text:'Old'},status:'other'}).fingerprint,first.fingerprint);assert.match(first.content,/source|question/i)}
  const huge={kind:'note',title:'Huge',noteText:'x'.repeat(100000)+'Final substantive source'};const source=cardSummarySource(huge);
  assert.ok(source.content.length<=MAX_SUMMARY_SOURCE_CHARS);assert.equal(source.truncated,true);assert.match(source.content,/Final substantive source/);assert.match(source.content,/Middle source omitted/);
  assert.notEqual(cardSummarySource({...huge,noteText:huge.noteText+' changed'}).fingerprint,source.fingerprint);
});

test('summary output is restricted to two sentences and 55 words',()=>{
  assert.equal(normalizeCardSummary('Summary: First sentence. Second sentence. Third sentence.'),'First sentence. Second sentence.');
  assert.equal(normalizeCardSummary('Word '.repeat(80)).split(/\s+/).length,55);
});

test('isolated ephemeral request explicitly uses Low/Fast/read-only and never changes original card work',async t=>{
  const f=await setup(t),before=nonSummary(f.board.nodes[0]);
  f.manager.startNode(f.p());await f.manager.idle();
  assert.equal(f.board.nodes[0].summary.status,'ready');assert.equal(f.board.nodes[0].summary.fast,true);
  assert.deepEqual(nonSummary(f.board.nodes[0]),before);
  const created=f.runtime.calls.find(c=>c.method==='thread/start').params,turn=f.runtime.calls.find(c=>c.method==='turn/start').params;
  assert.equal(created.ephemeral,true);assert.equal(created.model,'gpt-6-luna');assert.equal(created.allowProviderModelFallback,false);assert.equal(created.serviceTier,'priority');assert.equal(created.sandbox,'read-only');assert.equal(created.approvalPolicy,'never');assert.deepEqual(created.dynamicTools,[]);assert.deepEqual(created.environments,[]);assert.deepEqual(created.runtimeWorkspaceRoots,[]);assert.equal(created.config.features.shell_tool,false);assert.deepEqual(created.config.mcp_servers,{});
  assert.equal(turn.model,'gpt-6-luna');assert.equal(turn.effort,'low');assert.equal(turn.serviceTierForTurn,'priority');assert.equal(turn.sandboxPolicy.type,'readOnly');assert.equal(turn.sandboxPolicy.networkAccess,false);assert.notEqual(turn.threadId,before.threadId);assert.match(turn.input[0].text,/untrusted_card_source/);assert.equal(turn.maxOutputTokens,undefined);
  const disk=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(disk.boards[0].nodes[0].summary.status,'ready');
});

test('unchanged cached cards make no native calls; force and substantive edits regenerate',async t=>{
  const f=await setup(t);f.manager.startNode(f.p());await f.manager.idle();const firstCount=f.runtime.calls.length;
  assert.equal(f.manager.startNode(f.p()).cached,true);await f.manager.idle();assert.equal(f.runtime.calls.length,firstCount);
  f.board.nodes[0].position.x=77;assert.equal(f.manager.startNode(f.p()).cached,true);
  f.manager.startNode({...f.p(),force:true});await f.manager.idle();assert.equal(f.runtime.calls.filter(c=>c.method==='turn/start').length,2);
  f.board.nodes[0].messages[0].text+=' New finding';f.manager.startNode(f.p());await f.manager.idle();assert.equal(f.runtime.calls.filter(c=>c.method==='turn/start').length,3);
});

test('batch caps concurrency at four, persists out-of-order completions, counts cache/empty and skips archived',async t=>{
  const f=await setup(t,{count:7,instant:false});f.board.nodes[6].archived=true;
  const before=f.board.nodes.map(nonSummary),start=f.manager.startBoard({boardId:f.board.id});assert.equal(start.total,6);
  await waitTurns(f.runtime,4);assert.equal(f.runtime.active,4);assert.equal(f.runtime.peak,4);
  f.runtime.complete('summary-3','Third completed before the first.');await waitTurns(f.runtime,5);
  assert.equal(f.board.nodes[2].summary.status,'ready');assert.notEqual(f.board.nodes[0].summary.status,'ready');
  const disk=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(disk.boards[0].nodes[2].summary.text,'Third completed before the first.');
  f.runtime.complete('summary-2');await waitTurns(f.runtime,6);
  for(const id of f.runtime.turns.keys())f.runtime.complete(id);await f.manager.idle();
  assert.equal(f.runtime.peak,4);assert.equal(f.board.summaryRun.status,'completed');assert.equal(f.board.summaryRun.completed,6);assert.equal(f.board.nodes[6].summary,undefined);
  assert.deepEqual(f.board.nodes.map(nonSummary),before);
  f.board.nodes.push({id:'empty',kind:'note',title:'Blank',position:{x:0,y:0},messages:[],noteText:''});
  f.manager.startBoard({boardId:f.board.id});await f.manager.idle();assert.equal(f.board.summaryRun.completed,7);assert.equal(f.board.summaryRun.cached,6);assert.equal(f.board.summaryRun.skipped,1);assert.equal(f.board.summaryRun.total,7);
});

test('repeated card and batch triggers dedupe the same in-flight work',async t=>{
  const f=await setup(t,{instant:false});f.manager.startNode(f.p());await waitTurns(f.runtime,1);
  f.manager.startNode({...f.p(),force:true});const first=f.manager.startBoard({boardId:f.board.id}),second=f.manager.startBoard({boardId:f.board.id});assert.equal(first.id,second.id);
  await tick();assert.equal(f.runtime.calls.filter(c=>c.method==='thread/start').length,1);f.runtime.complete('summary-1');await f.manager.idle();assert.equal(f.board.summaryRun.completed,1);
});

test('native errors remain retryable, preserve prior summary and do not change other cards',async t=>{
  const f=await setup(t,{count:2});f.manager.startNode(f.p());await f.manager.idle();const previous=f.board.nodes[0].summary.text,other=clone(f.board.nodes[1]);
  f.runtime.instant=false;f.manager.startNode({...f.p(),force:true});await waitTurns(f.runtime,2);f.runtime.complete('summary-2','', 'failed');await f.manager.idle();
  assert.equal(f.board.nodes[0].summary.status,'error');assert.equal(f.board.nodes[0].summary.text,previous);assert.deepEqual(f.board.nodes[1],other);assert.ok(f.runtime.calls.some(c=>c.method==='interrupt'&&c.threadId==='summary-2'));
  f.runtime.instant=true;f.manager.startNode(f.p());await f.manager.idle();assert.equal(f.board.nodes[0].summary.status,'ready');
});

test('content edits during inference reject stale summaries instead of caching the old result',async t=>{
  const f=await setup(t,{instant:false});f.manager.startNode(f.p());await waitTurns(f.runtime,1);f.board.nodes[0].messages[0].text='Changed substantive source';f.runtime.complete('summary-1');await f.manager.idle();assert.equal(f.board.nodes[0].summary.status,'error');assert.match(f.board.nodes[0].summary.error,/changed/);assert.equal(f.board.nodes[0].summary.fingerprint,undefined);
});

test('unmapped notifications cannot contaminate summaries and tool attempts are rejected and privately interrupted',async t=>{
  const f=await setup(t,{instant:false});f.manager.startNode(f.p());await waitTurns(f.runtime,1);
  f.runtime.emit('notification',{method:'item/completed',params:{threadId:'original-0',item:{id:'foreign',type:'agentMessage',text:'Wrong chat'}}});
  f.runtime.emit('serverRequest',{id:'tool',method:'item/tool/call',params:{threadId:'summary-1'}});await f.manager.idle();assert.equal(f.board.nodes[0].summary.status,'error');assert.ok(f.runtime.calls.some(c=>c.method==='reject'&&c.id==='tool'));assert.ok(f.runtime.calls.some(c=>c.method==='interrupt'&&c.threadId==='summary-1'));assert.ok(!f.runtime.calls.some(c=>c.threadId==='original-0'));
});

test('model fallback, missing Fast and offline errors start no inference',async t=>{
  const f=await setup(t);f.runtime.catalog=[{...catalog[0],serviceTiers:[]}];f.manager.startNode(f.p());await f.manager.idle();assert.match(f.board.nodes[0].summary.error,/Fast mode is unavailable/);assert.equal(f.runtime.calls.filter(c=>c.method==='turn/start').length,0);
  f.runtime.catalog=clone(catalog);f.runtime.wrongModel='other';f.manager.startNode(f.p());await f.manager.idle();assert.match(f.board.nodes[0].summary.error,/did not select GPT/);assert.equal(f.runtime.calls.filter(c=>c.method==='turn/start').length,0);
  f.manager.isConnected=()=>false;f.manager.startNode(f.p());await f.manager.idle();assert.match(f.board.nodes[0].summary.error,/Reconnect/);
});

test('timeout and shutdown stop only private summary work and recover honest persisted state',async t=>{
  const f=await setup(t,{count:5,instant:false,timeoutMs:30});
  f.manager.startNode(f.p());await waitTurns(f.runtime,1);await new Promise(resolve=>setTimeout(resolve,50));await f.manager.idle();assert.match(f.board.nodes[0].summary.error,/too long/);assert.ok(f.runtime.calls.some(c=>c.method==='interrupt'));
  f.manager.startBoard({boardId:f.board.id});await waitTurns(f.runtime,5);await f.manager.close();assert.ok(f.board.nodes.every(n=>!['queued','running'].includes(n.summary?.status)));assert.ok(f.runtime.calls.filter(c=>c.method==='interrupt').every(c=>c.threadId.startsWith('summary-')));
});
