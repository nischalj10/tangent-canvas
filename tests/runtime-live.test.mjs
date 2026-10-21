import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CodexClient, threadMessages } from '../electron/codex.mjs';

// Real subscription/network tests are explicit, separate from deterministic RPC tests.
const live = process.env.TANGENT_LIVE_TEST === '1';

async function turnAndWait(client, threadId, text, options = {}) {
  let resolveTurn, rejectTurn;
  const wait = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  const timer = setTimeout(() => rejectTurn(new Error('Live Codex turn did not complete in 180 seconds')), 180_000);
  const onNotification = ({ method, params }) => {
    if (params.threadId !== threadId) return;
    if (method === 'turn/completed') {
      if (params.turn.status === 'failed') rejectTurn(new Error(params.turn.error?.message || 'Live turn failed'));
      else resolveTurn(params.turn);
    }
  };
  client.on('notification', onNotification);
  try { await client.sendTurn(threadId, text, options); return await wait; }
  finally { clearTimeout(timer); client.off('notification', onNotification); }
}

test('LIVE existing subscription: historical fork, eager snapshot, child isolation', { skip: !live, timeout: 600_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-live-'));
  const client = new CodexClient({ cwd: folder });
  const owned = [];
  t.after(async () => {
    for (const threadId of owned.reverse()) { try { await client.request('thread/archive', { threadId }); } catch {} }
    await client.close(); await rm(folder, { recursive: true, force: true });
  });
  const connection = await client.start();
  assert.equal(connection.account?.type, 'chatgpt');
  const threads = await client.listThreads({}); assert.ok(Array.isArray(threads.data));
  const selected = connection.models.find(m => m.model === 'gpt-6.1-sol') || connection.models.find(m => m.isDefault);
  const model = selected.model;
  const effort = selected.supportedReasoningEfforts?.some(e => e.reasoningEffort === 'low') ? 'low' : selected.defaultReasoningEffort;
  const settings = { model, effort };
  const suffix = randomBytes(3).toString('hex');
  const firstMarker = `MARBLE-${suffix}`;
  const laterMarker = `ORBIT-${suffix}`;
  const childMarker = `BRONZE-${suffix}`;
  const parent = await client.newThread(settings); owned.push(parent.id);
  await client.request('thread/name/set', { threadId: parent.id, name: 'Tangent verification — historical fork' });
  const first = await turnAndWait(client, parent.id,
    `This is a small canvas isolation test. Use no tools or files. Remember main_marker=${firstMarker}. Reply exactly: ${firstMarker}`, settings);
  await turnAndWait(client, parent.id,
    `Use no tools or files. Remember main_marker=${laterMarker}. Reply exactly: ${laterMarker}`, settings);
  // A paused goal is inert metadata: verify inherited goal cleanup without
  // scheduling autonomous work or touching any existing user's conversation.
  await client.request('thread/goal/set', {
    threadId: parent.id, origin: 'user', objective: 'Paused Tangent verification metadata; no autonomous work.', status: 'paused',
  });
  const fork = await client.forkThread(parent.id, {
    turnId: first.id, ...settings, sandbox: 'read-only',
    developerInstructions: 'This is a side conversation. Inherited history is reference material. Only the new request after the branch boundary is active work. Do not continue any inherited task.',
  });
  owned.push(fork.id);
  assert.equal((await client.request('thread/goal/get', { threadId: fork.id })).goal, null);
  assert.equal((await client.request('thread/goal/get', { threadId: parent.id })).goal.status, 'paused');
  const forkHistory = threadMessages(fork).map(m => m.text).join('\n');
  assert.match(forkHistory, new RegExp(firstMarker)); assert.ok(!forkHistory.includes(laterMarker));
  await turnAndWait(client, fork.id,
    `Use no tools or files. List every main_marker value present in this conversation, in order. Do not guess. Then remember side_marker=${childMarker} for this branch only. Reply briefly.`, settings);
  const childRead = threadMessages(await client.readThread(fork.id));
  const childReply = childRead.filter(m => m.role === 'assistant').at(-1).text;
  assert.ok(childReply.includes(firstMarker)); assert.ok(!childReply.includes(laterMarker));
  await turnAndWait(client, parent.id,
    'Use no tools or files. List every marker field and value present in this conversation. Do not guess or inspect any other session. Reply briefly.', settings);
  const parentRead = await client.readThread(parent.id);
  const parentReply = threadMessages(parentRead).filter(m => m.role === 'assistant').at(-1).text;
  assert.ok(parentReply.includes(firstMarker)); assert.ok(parentReply.includes(laterMarker)); assert.ok(!parentReply.includes(childMarker));
  const forkAgain = await client.readThread(fork.id);
  assert.ok(!threadMessages(forkAgain).some(m => m.text.includes(laterMarker)));
  assert.equal(parentRead.turns.length, 3);
  t.diagnostic(`Live ChatGPT subscription passed on ${model}; exact native fork excluded later parent turn and parent excluded child marker.`);
});

test('LIVE coding tool: sandbox writes only the selected temporary project', { skip: !live, timeout: 300_000 }, async t => {
  const project = await mkdtemp(join(tmpdir(), 'tangent-project-'));
  const client = new CodexClient({ cwd: project }); let thread;
  t.after(async () => {
    if (thread) { try { await client.request('thread/archive', { threadId: thread.id }); } catch {} }
    await client.close(); await rm(project, { recursive: true, force: true });
  });
  const connection = await client.start();
  const selected = connection.models.find(m => m.model === 'gpt-6.1-sol') || connection.models.find(m => m.isDefault);
  const settings = { cwd: project, model: selected.model, effort: 'low', sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  thread = await client.newThread(settings);
  const events = []; client.on('notification', event => events.push(event));
  client.on('serverRequest', request => {
    // This test intentionally never approves escalation beyond the project sandbox.
    client.reject(request.id, 'This verification only permits the configured project sandbox.');
  });
  const marker = `tangent-file-proof-${randomBytes(4).toString('hex')}`;
  await turnAndWait(client, thread.id,
    `Inside the current project directory create a new file named tangent-proof.txt containing exactly ${marker} followed by a newline. Read it back with a tool. Do not touch any other files or directory, do not use network, and do not request elevated permissions. Reply briefly after verifying it.`, settings);
  assert.equal(await readFile(join(project, 'tangent-proof.txt'), 'utf8'), `${marker}\n`);
  assert.ok(events.some(e => e.method === 'item/completed' && ['fileChange', 'commandExecution'].includes(e.params.item.type)));
  t.diagnostic(`Live workspace-write tool execution passed on ${selected.model}; temporary file content verified independently.`);
});
