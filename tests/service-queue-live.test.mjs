import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';
import { CodexClient, threadMessages } from '../electron/codex.mjs';

const live = process.env.TANGENT_QUEUE_LIVE === '1';
const normalized = text => text.trim().replace(/\.$/, '');

function waitFor(service, check, label, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { clearTimeout(timer); service.off('event', inspect); error ? reject(error) : resolve(value); };
    const inspect = () => { try { const value = check(); if (value) finish(null, value); } catch (error) { finish(error); } };
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${label}`)), timeoutMs);
    service.on('event', inspect); inspect();
  });
}

test('LIVE CanvasService queue edits/order/removal and same-turn steer remain card-isolated', { skip: !live, timeout: 240_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tangent-service-queue-live-'));
  const store = new CanvasStore(directory); const runtime = new CodexClient({ cwd: directory });
  const service = new CanvasService(store, runtime); let heldRequest;
  const board = store.state.boards[0];
  t.after(async () => {
    service.closing = true;
    for (const node of board.nodes) node.queuePaused = true;
    if (heldRequest) { try { runtime.respond(heldRequest.id, { success: true, contentItems: [{ type: 'inputText', text: 'Verification canceled.' }] }); } catch {} }
    for (const threadId of new Set(board.nodes.map(node => node.threadId).filter(Boolean))) {
      try { await runtime.request('thread/archive', { threadId }); } catch {}
    }
    await service.close(); await rm(directory, { recursive: true, force: true });
  });
  await service.connect(); assert.equal(service.connection.account?.type, 'chatgpt');
  const main = service.makeNode(board, 'chat', { title: 'Queue and steering verification' });
  const other = service.makeNode(board, 'chat', { title: 'Independent card verification' });
  const p = { boardId: board.id, nodeId: main.id };
  const otherP = { boardId: board.id, nodeId: other.id };
  service.nodeSettings({ ...p, model: 'gpt-6.1-sol', effort: 'low' });
  service.nodeSettings({ ...otherP, model: 'gpt-6.1-sol', effort: 'low' });
  const gate = { type: 'function', name: 'wait_for_canvas_queue_test',
    description: 'Harmless integration-test synchronization gate. Call exactly once when explicitly requested, before the final answer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  const originalOptions = service.options.bind(service);
  service.options = (b, node) => { const options = originalOptions(b, node); return { ...options, dynamicTools: [...(options.dynamicTools || []), gate] }; };
  let resolveGate; const held = new Promise(resolve => { resolveGate = resolve; });
  const originalRequest = service.onRequest.bind(service);
  service.onRequest = request => {
    if (request.method === 'item/tool/call' && request.params.tool === gate.name) { heldRequest = request; resolveGate(request); }
    else originalRequest(request);
  };
  const starts = []; const originalSend = runtime.sendTurn.bind(runtime);
  runtime.sendTurn = (threadId, text, options) => { starts.push({ threadId, text }); return originalSend(threadId, text, options); };
  const suffix = randomBytes(3).toString('hex');
  const active = `ORIGINAL-${suffix}`, steered = `STEERED-${suffix}`;
  const first = `FIRST-${suffix}`, second = `SECOND-${suffix}`, stale = `STALE-${suffix}`, removed = `REMOVED-${suffix}`;
  await service.send({ ...p, text: `Use no tools except wait_for_canvas_queue_test, which you must call exactly once before answering. Remember active_marker=${active}. After the gate returns, reply exactly ${active}.` });
  await Promise.race([held, waitFor(service, () => { if (main.status === 'error') throw new Error(main.error); return Boolean(heldRequest); }, 'native gate')]);
  const originalTurnId = main.activeTurnId; assert.ok(originalTurnId);
  const a = await service.enqueue({ ...p, text: `Use no tools. Remember queue_marker=${first}. Reply exactly ${first}.` });
  const b = await service.enqueue({ ...p, text: `Use no tools. Remember queue_marker=${stale}. Reply exactly ${stale}.` });
  const c = await service.enqueue({ ...p, text: `Use no tools. Remember queue_marker=${removed}. Reply exactly ${removed}.` });
  await service.queueAction('queue/update', { ...p, queueId: b.id, text: `Use no tools. Remember queue_marker=${second}. Reply exactly ${second}.` });
  await service.queueAction('queue/reorder', { ...p, queueIds: [b.id, a.id, c.id] });
  await service.queueAction('queue/remove', { ...p, queueId: c.id });
  await service.queueAction('queue/pause', p);
  assert.equal(main.queuePaused, true); assert.equal(starts.filter(call => call.threadId === main.threadId).length, 1);
  const savedQueue = JSON.parse(await readFile(store.file, 'utf8')).boards[0].nodes.find(node => node.id === main.id).queue;
  assert.deepEqual(savedQueue.map(entry => entry.id), [b.id, a.id]);
  await service.send({ ...otherP, text: 'Use no tools. List any marker field and value present in this chat before this message. If there are none, reply exactly NONE.' });
  const steerResult = await service.steer({ ...p, text: `Change direction for this active turn: after the gate returns reply exactly ${steered}. Do not use other tools or the earlier final wording.` });
  assert.equal(steerResult.turnId, originalTurnId); assert.equal(main.activeTurnId, originalTurnId);
  assert.equal(main.messages.find(message => message.id === steerResult.messageId).deliveryStatus, 'accepted');
  assert.equal(starts.filter(call => call.threadId === main.threadId).length, 1);
  await service.queueAction('queue/resume', p);
  runtime.respond(heldRequest.id, { success: true, contentItems: [{ type: 'inputText', text: 'The controlled gate is complete. Follow the latest user direction.' }] }); heldRequest = null;
  await waitFor(service, () => {
    if (main.status === 'error' || other.status === 'error') throw new Error(main.error || other.error);
    return main.status === 'idle' && other.status === 'idle' && main.queue.length === 0 &&
      !service.sends.has(main.id) && !service.queueDrains.has(main.id);
  }, 'steered answer and both queued native turns');
  const nativeMain = await runtime.readThread(main.threadId); const nativeOther = await runtime.readThread(other.threadId);
  assert.equal(nativeMain.turns.length, 3); assert.equal(nativeOther.turns.length, 1);
  const nativeMessages = threadMessages(nativeMain); const userMessages = nativeMessages.filter(message => message.role === 'user');
  assert.equal(userMessages.length, 4); assert.equal(userMessages[0].turnId, userMessages[1].turnId);
  assert.equal(userMessages[0].turnId, originalTurnId);
  const replies = nativeMain.turns.map(turn => normalized(turn.items.filter(item => item.type === 'agentMessage').at(-1).text));
  assert.deepEqual(replies, [steered, second, first]);
  assert.equal(userMessages.filter(message => message.text.includes(first)).length, 1);
  assert.equal(userMessages.filter(message => message.text.includes(second)).length, 1);
  assert.ok(!userMessages.some(message => message.text.includes(stale) || message.text.includes(removed)));
  assert.equal(starts.filter(call => call.threadId === main.threadId).length, 3);
  const otherMessages = threadMessages(nativeOther);
  assert.equal(normalized(otherMessages.filter(message => message.role === 'assistant').at(-1).text), 'NONE');
  assert.ok(!otherMessages.some(message => [active, steered, first, second, stale, removed].some(marker => message.text.includes(marker))));
  assert.deepEqual(main.messages.filter(message => message.queueId).map(message => message.queueId), [b.id, a.id]);
  assert.equal(main.messages.filter(message => message.delivery === 'steer').length, 1);
  t.diagnostic('Full production CanvasService + real subscription passed: one turn steered mid-tool, persisted queue edited/reordered/removed/paused/resumed, two later turns delivered exactly once in order, separate card saw NONE.');
});
