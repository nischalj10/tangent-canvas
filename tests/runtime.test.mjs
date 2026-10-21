import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { CodexClient, threadMessages } from '../electron/codex.mjs';

const fixtureSource = `#!${process.execPath}
import readline from 'node:readline';
const lines = readline.createInterface({input:process.stdin});
function send(frame){process.stdout.write(JSON.stringify(frame)+'\\n')}
const thread=(id,turns=[])=>({id,turns,historyMode:'legacy',createdAt:123,cwd:process.cwd()});
const turns=[{id:'turn-first',status:'completed',startedAt:123,items:[{type:'userMessage',id:'u1',content:[{type:'text',text:'MARBLE'}]},{type:'agentMessage',id:'a1',text:'MARBLE'}]},{id:'turn-later',status:'completed',startedAt:124,items:[{type:'agentMessage',id:'a2',text:'ORBIT'}]}];
lines.on('line',line=>{const f=JSON.parse(line);if(!f.method){if(f.id==='approval')send({method:'approval-result',params:f});return;}if(f.id===undefined)return;
 if(f.method==='initialize')return send({id:f.id,result:{userAgent:'test'}});
 if(f.method==='account/read')return send({id:f.id,result:{account:{type:'chatgpt',planType:'pro'},requiresOpenaiAuth:true}});
 if(f.method==='model/list')return send({id:f.id,result:{data:[{id:'m',model:'test-model',displayName:'Test model',isDefault:true,defaultReasoningEffort:'low'}]}});
 if(f.method==='thread/start')return send({id:f.id,result:{thread:thread('new-thread'),params:f.params}});
 if(f.method==='thread/resume')return send({id:f.id,result:{thread:thread(f.params.threadId),params:f.params}});
 if(f.method==='thread/read')return send({id:f.id,result:{thread:{...thread(f.params.threadId,f.params.threadId==='paginated'?[]:turns),historyMode:f.params.threadId==='paginated'?'paginated':'legacy'}}});
 if(f.method==='thread/turns/list')return send({id:f.id,result:{data:f.params.cursor?[turns[1]]:[turns[0]],nextCursor:f.params.cursor?null:'page-two'}});
 if(f.method==='thread/fork'){if(f.params.lastTurnId==='invalid')return send({id:f.id,error:{code:-32602,message:'turn not found'}});return send({id:f.id,result:{thread:thread('fork-thread',f.params.lastTurnId?turns.slice(0,1):turns),params:f.params}})}
 if(f.method==='thread/goal/get')return send({id:f.id,result:{goal:{threadId:f.params.threadId,objective:'inherited task',status:'active'}}});
 if(f.method==='thread/goal/clear')return send({id:f.id,result:{}});
 if(f.method==='turn/start'){send({method:'turn/started',params:{threadId:f.params.threadId,turn:{id:'running',status:'inProgress'}}});send({id:f.id,result:{turn:{id:'running',status:'inProgress'}}});const text=JSON.stringify({method:'item/agentMessage/delta',params:{threadId:f.params.threadId,turnId:'running',itemId:'out',delta:'hello'}})+'\\n';process.stdout.write(text.slice(0,21));queueMicrotask(()=>{process.stdout.write(text.slice(21));send({method:'turn/completed',params:{threadId:f.params.threadId,turn:{id:'running',status:'completed'}}});});return;}
 if(f.method==='turn/steer'){if(f.params.expectedTurnId!=='active-test')return send({id:f.id,error:{code:-32602,message:'Expected turn does not match active turn'}});send({id:f.id,result:{turnId:'active-test'}});send({method:'item/completed',params:{threadId:f.params.threadId,turnId:'active-test',item:{type:'userMessage',id:'steered-user',clientId:f.params.clientUserMessageId,content:f.params.input}}});return;}
 if(f.method==='approval-test'){send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'new-thread',command:'ls'}});return send({id:f.id,result:{}})}
 if(f.method==='echo')return setTimeout(()=>send({id:f.id,result:f.params}),f.params.delay||0);
 if(f.method==='environment-test')return send({id:f.id,result:{sessionKeys:Object.keys(process.env).filter(n=>/^CODEX_(THREAD_ID|SESSION_ID|INTERNAL_ORIGINATOR_OVERRIDE|APP_TOOLS_PIPE_PATH)$/.test(n))}});
 if(f.method==='exit-test')return process.exit(7);
 if(f.method==='timeout-test')return;
 if(f.method==='invalid-frame')return process.stdout.write('not-json\\n');
 return send({id:f.id,error:{code:-32601,message:'unknown method'}});
});
`;

async function clientFor(t, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-rpc-'));
  const binary = join(folder, 'codex-fixture.mjs');
  await writeFile(binary, fixtureSource); await chmod(binary, 0o700);
  const client = new CodexClient({ binary, cwd: folder, ...options });
  t.after(async () => { await client.close(); await rm(folder, { recursive: true, force: true }); });
  await client.start();
  return client;
}

test('initializes a single stdio child and normalizes account/catalog', async t => {
  const client = await clientFor(t);
  const [first, second] = await Promise.all([client.start(), client.start()]);
  assert.equal(first, second);
  assert.equal(first.account.type, 'chatgpt'); assert.equal(first.model, 'test-model');
  assert.equal(first.effort, 'low'); assert.equal(client.pending.size, 0);
});

test('matches concurrent responses and streams split JSON frames', async t => {
  const client = await clientFor(t);
  const results = await Promise.all([client.request('echo', { order: 1, delay: 15 }), client.request('echo', { order: 2 })]);
  assert.deepEqual(results.map(r => r.order), [1, 2]);
  const notifications = [];
  client.on('notification', n => notifications.push(n));
  const completed = new Promise(resolve => client.on('notification', n => { if (n.method === 'turn/completed') resolve(n); }));
  assert.equal((await client.sendTurn('new-thread', 'hello')).id, 'running');
  await completed;
  assert.equal(notifications.find(n => n.method === 'item/agentMessage/delta').params.delta, 'hello');
});

test('steers the expected native active turn and preserves client message identity', async t => {
  const client = await clientFor(t); const calls = [];
  const request = client.request.bind(client);
  client.request = (method, params) => { calls.push({ method, params }); return request(method, params); };
  const userItem = new Promise(resolve => client.on('notification', event => { if (event.params.item?.id === 'steered-user') resolve(event.params); }));
  const result = await client.steerTurn('thread', 'Change direction now.', { expectedTurnId: 'active-test', clientUserMessageId: 'local-steer-id' });
  assert.deepEqual(result, { turnId: 'active-test' });
  assert.deepEqual(calls, [{ method: 'turn/steer', params: { threadId: 'thread', expectedTurnId: 'active-test',
    clientUserMessageId: 'local-steer-id', input: [{ type: 'text', text: 'Change direction now.', text_elements: [] }] } }]);
  const item = await userItem; assert.equal(item.turnId, 'active-test'); assert.equal(item.item.clientId, 'local-steer-id');
  assert.ok(!calls.some(call => call.method === 'turn/start'));
});

test('rejects missing/stale steering preconditions without starting another turn', async t => {
  const client = await clientFor(t); const methods = [];
  const request = client.request.bind(client); client.request = (method, params) => { methods.push(method); return request(method, params); };
  await assert.rejects(client.steerTurn('thread', 'hello'), /active turn/);
  await assert.rejects(client.steerTurn('thread', '   ', { expectedTurnId: 'active-test' }), /Write a message/);
  await assert.rejects(client.steerTurn('thread', 'hello', { expectedTurnId: 'stale-turn' }), /does not match/);
  assert.deepEqual(methods, ['turn/steer']);
});

test('app context travels separately on start and steer without overriding developer config', async t => {
  const client = await clientFor(t); const calls = [];
  const request = client.request.bind(client); client.request = (method, params) => { calls.push({ method, params }); return request(method, params); };
  const additionalContext = { tangent_canvas_instructions: { kind: 'application', value: 'Create local canvas documents by default.' } };
  await client.sendTurn('thread', 'Create a page.', { additionalContext, clientUserMessageId: 'start-id' });
  const start = calls.find(call => call.method === 'turn/start');
  assert.deepEqual(start.params.additionalContext, additionalContext); assert.equal(start.params.clientUserMessageId, 'start-id');
  assert.equal(start.params.developerInstructions, undefined); assert.equal(start.params.config, undefined);
  await client.steerTurn('thread', 'Keep it local.', { expectedTurnId: 'active-test', additionalContext });
  const steer = calls.find(call => call.method === 'turn/steer');
  assert.deepEqual(steer.params.additionalContext, additionalContext); assert.equal(steer.params.developerInstructions, undefined);
});

test('forwards approval requests and transports explicit user decision', async t => {
  const client = await clientFor(t);
  const result = new Promise(resolve => client.on('notification', n => { if (n.method === 'approval-result') resolve(n.params); }));
  client.on('serverRequest', request => { assert.equal(request.id, 'approval'); client.respond(request.id, { decision: 'decline' }); });
  await client.request('approval-test');
  assert.deepEqual((await result).result, { decision: 'decline' });
  assert.equal(client.serverRequests.size, 0);
});

test('rejects unsupported server requests instead of hanging them', async t => {
  const client = await clientFor(t);
  const result = new Promise(resolve => client.on('notification', n => { if (n.method === 'approval-result') resolve(n.params); }));
  await client.request('approval-test');
  assert.equal((await result).error.code, -32601);
});

test('historical fork uses inclusive native boundary and never reverts parent', async t => {
  const client = await clientFor(t);
  const methods = [];
  const request = client.request.bind(client);
  client.request = (method, params) => { methods.push({ method, params }); return request(method, params); };
  const fork = await client.forkThread('parent', { turnId: 'turn-first', sandbox: 'read-only', approvalPolicy: 'on-request' });
  assert.notEqual(fork.id, 'parent');
  assert.deepEqual(fork.turns.map(turn => turn.id), ['turn-first']);
  assert.deepEqual(methods.map(call => call.method), ['thread/fork', 'thread/goal/get', 'thread/goal/clear']);
  assert.equal(methods[0].params.lastTurnId, 'turn-first');
  assert.equal(methods[0].params.sandbox, 'read-only');
  assert.equal(methods[0].params.deferGoalContinuation, true);
  assert.deepEqual(methods[1].params, { threadId: 'fork-thread' });
  assert.deepEqual(methods[2].params, { threadId: 'fork-thread', origin: 'user' });
  assert.equal(threadMessages(fork).at(-1).turnId, 'turn-first');
  const parent = await client.readThread('parent'); assert.equal(parent.turns.length, 2);
  await assert.rejects(client.forkThread('parent', { turnId: 'invalid' }), /turn not found/);
});

test('read-only defaults and project sandbox are explicit, never inherited', async t => {
  const client = await clientFor(t);
  const calls = [];
  const request = client.request.bind(client);
  client.request = (method, params) => { calls.push({ method, params }); return request(method, params); };
  await client.newThread({});
  assert.equal(calls.at(-1).params.sandbox, 'read-only');
  await client.newThread({ cwd: client.cwd });
  assert.equal(calls.at(-1).params.sandbox, 'workspace-write');
  await client.sendTurn('new-thread', 'hello', { cwd: client.cwd });
  assert.equal(calls.at(-1).params.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(calls.at(-1).params.sandboxPolicy.networkAccess, false);
  await client.sendTurn('new-thread', 'scratch hello', { cwd: client.cwd, sandbox: 'read-only' });
  assert.equal(calls.at(-1).params.sandboxPolicy.type, 'readOnly');
  await assert.rejects(client.newThread({ sandbox: 'invalid' }), /Unknown Codex sandbox/);
  await assert.rejects(client.sendTurn('new-thread', 'test', { sandboxPolicy: { type: 'invalid' } }), /Unknown Codex sandbox/);
});

test('hydrates paginated history in order instead of losing imported context', async t => {
  const client = await clientFor(t);
  const thread = await client.readThread('paginated');
  assert.deepEqual(thread.turns.map(turn => turn.id), ['turn-first', 'turn-later']);
  assert.equal(threadMessages(thread).at(-1).text, 'ORBIT');
});

test('does not inherit the hosting Codex chat identity or desktop tool channel', async t => {
  const client = await clientFor(t);
  assert.deepEqual((await client.request('environment-test')).sessionKeys, []);
});

test('registers app-owned document tools only on new thread initialization', async t => {
  const client = await clientFor(t);
  const calls = []; const request = client.request.bind(client);
  client.request = (method, params) => { calls.push({ method, params }); return request(method, params); };
  const tools = [{ type: 'function', name: 'create_document', description: 'Create a canvas document',
    inputSchema: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'], additionalProperties: false } }];
  await client.newThread({ dynamicTools: tools });
  assert.deepEqual(calls.at(-1).params.dynamicTools, tools);
  await assert.rejects(client.newThread({ dynamicTools: {} }), /must be an array/);
});

test('rejects pending RPCs when subprocess exits and reports disconnect', async t => {
  const client = await clientFor(t);
  const exited = once(client, 'exit');
  await assert.rejects(client.request('exit-test'), /Codex stopped/);
  const [status] = await exited;
  assert.equal(status.code, 7); assert.equal(client.connection.connected, false);
  await assert.rejects(client.request('echo'), /disconnected/);
});

test('times out requests without retaining pending promises', async t => {
  const client = await clientFor(t);
  client.options.requestTimeoutMs = 150;
  await assert.rejects(client.request('timeout-test'), /timed out/);
  assert.equal(client.pending.size, 0);
});

test('malformed protocol output becomes a useful error and terminates owned child', async t => {
  const client = await clientFor(t);
  const errors = []; client.on('error', error => errors.push(error));
  await assert.rejects(client.request('invalid-frame'), /invalid protocol/);
  assert.match(errors[0].message, /invalid protocol/);
});

test('message conversion keeps selected response IDs and ignores private reasoning', () => {
  const result = threadMessages({ turns: [{ id: 'turn', startedAt: 42, status: 'completed', items: [
    { id: 'reason', type: 'reasoning', summary: ['private'] },
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
    { id: 'a', type: 'agentMessage', text: 'Answer' },
  ] }] });
  assert.equal(result.length, 2); assert.equal(result[1].id, 'a'); assert.equal(result[1].turnId, 'turn');
});


test('per-chat native permission policy reaches start, resume, fork and every turn without global overrides', async t => {
  const { chatPermissionOptions } = await import('../electron/chat-permissions.mjs');
  const client = await clientFor(t); const calls = []; const request = client.request.bind(client);
  client.request = (method, params) => { calls.push({ method, params }); return request(method, params); };
  for (const mode of ['full', 'ask', 'auto']) {
    const options = { cwd: client.cwd, ...chatPermissionOptions(mode) };
    await client.newThread(options);
    await client.resumeThread('new-thread', options);
    await client.forkThread('parent', { turnId:'turn-first', ...options });
    await client.sendTurn('new-thread', 'A no-op fixture request', options);
    for (const method of ['thread/start', 'thread/resume', 'thread/fork', 'turn/start']) {
      const params = calls.filter(call => call.method === method).at(-1).params;
      assert.equal(params.approvalPolicy, options.approvalPolicy);
      assert.equal(params.approvalsReviewer, options.approvalsReviewer);
      if(method==='turn/start')assert.deepEqual(params.sandboxPolicy,options.sandboxPolicy);
      else assert.equal(params.sandbox,options.sandbox);
    }
  }
  await client.newThread({ ...chatPermissionOptions('auto') });
  await client.sendTurn('new-thread','Follow-up uses the same native policy');
  assert.equal(calls.at(-1).params.approvalsReviewer,'auto_review');
  assert.equal(calls.at(-1).params.sandboxPolicy.type,'readOnly');
  await client.sendTurn('new-thread','Switch only this thread',chatPermissionOptions('full'));
  await client.sendTurn('new-thread','Following turn retains the explicit override');
  assert.equal(calls.at(-1).params.sandboxPolicy.type,'dangerFullAccess');assert.equal(calls.at(-1).params.approvalPolicy,'never');
  await client.steerTurn('new-thread', 'Steering keeps the active permissions', { expectedTurnId:'active-test', ...chatPermissionOptions('full') });
  assert.equal(calls.at(-1).params.approvalsReviewer,undefined);assert.equal(calls.at(-1).params.sandboxPolicy,undefined);
  assert.ok(!calls.some(call=>call.method==='config/write'||call.method==='config/batchWrite'));
  await assert.rejects(client.newThread({approvalsReviewer:'accept-everything'}),/Unknown Codex approval reviewer/);
});
