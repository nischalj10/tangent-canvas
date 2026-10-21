import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexClient, threadMessages } from '../electron/codex.mjs';

const live = process.env.TANGENT_STEER_TEST === '1';

test('LIVE steering changes an active native turn, rejects stale IDs, preserves history', { skip: !live, timeout: 180_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-steer-'));
  const client = new CodexClient({ cwd: folder }); let thread; let heldRequest;
  t.after(async () => {
    if (heldRequest) { try { client.respond(heldRequest.id, { success: true, contentItems: [{ type: 'inputText', text: 'Verification canceled.' }] }); } catch {} }
    if (thread) { try { await client.request('thread/archive', { threadId: thread.id }); } catch {} }
    await client.close(); await rm(folder, { recursive: true, force: true });
  });
  await client.start();
  const gate = { type: 'function', name: 'wait_for_canvas_steer', description: 'A harmless integration-test synchronization gate. Call it once before the final answer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
  thread = await client.newThread({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only', dynamicTools: [gate] });
  let releaseHeld, rejectHeld; let resolveFinished, rejectFinished;
  const held = new Promise((resolve, reject) => { releaseHeld = resolve; rejectHeld = reject; });
  const finished = new Promise((resolve, reject) => { resolveFinished = resolve; rejectFinished = reject; });
  const timeout = setTimeout(() => { rejectHeld(new Error('Native steering gate did not start')); rejectFinished(new Error('Native steering turn did not complete')); }, 120_000);
  t.after(() => clearTimeout(timeout));
  client.on('serverRequest', request => {
    if (request.method === 'item/tool/call' && request.params.tool === gate.name) { heldRequest = request; releaseHeld(request); }
    else client.reject(request.id, 'Only the harmless steering verification gate is available.');
  });
  client.on('notification', ({ method, params }) => {
    if (params.threadId === thread.id && method === 'turn/completed') resolveFinished(params.turn);
  });
  const turn = await client.sendTurn(thread.id,
    'Call wait_for_canvas_steer exactly once, then reply exactly ORIGINAL-DIRECTION. Do not call any other tool.',
    { model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only' });
  await held;
  await assert.rejects(client.steerTurn(thread.id, 'This stale request must not be accepted.', { expectedTurnId: randomUUID() }), /turn|active|match/i);
  const clientUserMessageId = `steer-${randomUUID()}`;
  const result = await client.steerTurn(thread.id,
    'New direction for this active turn: ignore the earlier requested final wording. After the waiting tool returns, reply exactly STEERED-DIRECTION.',
    { expectedTurnId: turn.id, clientUserMessageId });
  assert.equal(result.turnId, turn.id);
  client.respond(heldRequest.id, { success: true, contentItems: [{ type: 'inputText', text: 'The controlled wait is complete.' }] }); heldRequest = null;
  const completed = await finished; clearTimeout(timeout);
  assert.equal(completed.status, 'completed'); assert.equal(completed.id, turn.id);
  const read = await client.readThread(thread.id); const messages = threadMessages(read);
  assert.equal(read.turns.length, 1); assert.equal(messages.filter(m => m.role === 'user').length, 2);
  assert.equal(messages.filter(m => m.role === 'assistant').at(-1).text.trim().replace(/\.$/, ''), 'STEERED-DIRECTION');
  const steeringItem = read.turns[0].items.find(item => item.type === 'userMessage' && item.clientId === clientUserMessageId);
  assert.ok(steeringItem, 'Native history must retain steering message identity');
  await assert.rejects(client.steerTurn(thread.id, 'This completed turn cannot be steered.', { expectedTurnId: turn.id }), /turn|active/i);
  assert.equal((await client.readThread(thread.id)).turns.length, 1);
  t.diagnostic('Real native turn/steer accepted mid-tool direction in the same turn; stale/completed preconditions rejected; original answer superseded and client message identity persisted.');
});

test('LIVE application routing context supplements original developer instructions', { skip: !live, timeout: 120_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-app-context-'));
  const client = new CodexClient({ cwd: folder }); let thread;
  t.after(async () => { if (thread) { try { await client.request('thread/archive', { threadId: thread.id }); } catch {} } await client.close(); await rm(folder, { recursive: true, force: true }); });
  await client.start();
  thread = await client.newThread({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only',
    developerInstructions: 'For routing verification, the original developer marker is BASELINE-KEPT-83. Return it unchanged when asked. Use no tools during routing verification.' });
  const additionalContext = { tangent_canvas_surface: { kind: 'application', value: 'In this app, a request for a Page defaults to a real ChatGPT Page: use connected ChatGPT Spaces create/read/update tools, then attach its canonical URL to the canvas with canvas_page. Use canvas_document only for an explicit request for local Markdown. This is routing guidance only; do not create a Page unless the user asks you to create one.' } };
  let listener, timer;
  const finished = new Promise((resolveTurn, rejectTurn) => {
    timer = setTimeout(() => rejectTurn(new Error('Application routing verification timed out')), 90_000);
    listener = ({ method, params }) => { if (params.threadId === thread.id && method === 'turn/completed') resolveTurn(params.turn); };
    client.on('notification', listener);
  });
  const prompt = 'This is only a routing check; do not create, read, or change anything and use no tools. Reply with a JSON object containing baseMarker (the original developer marker) and defaultPageDestination (the appropriate product for a default Page request).';
  try { await client.sendTurn(thread.id, prompt, { model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only', additionalContext }); await finished; }
  finally { clearTimeout(timer); client.off('notification', listener); }
  const read = await client.readThread(thread.id); const messages = threadMessages(read);
  const answer = messages.filter(m => m.role === 'assistant').at(-1).text;
  assert.match(answer, /BASELINE-KEPT-83/); assert.match(answer, /ChatGPT/i); assert.match(answer, /Page/i);
  assert.equal(messages.filter(m => m.role === 'user').length, 1);
  assert.equal(messages.find(m => m.role === 'user').text, prompt);
  t.diagnostic('Separate native application context supplied real ChatGPT Pages routing while preserving original developer marker and clean visible user input; no hosted write was performed.');
});
