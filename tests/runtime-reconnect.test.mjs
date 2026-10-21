import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient } from '../electron/codex.mjs';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';

const fixtureSource = `#!${process.execPath}
import readline from 'node:readline';
const lines = readline.createInterface({input:process.stdin});
const send=frame=>process.stdout.write(JSON.stringify(frame)+'\\n');
lines.on('line',line=>{const f=JSON.parse(line);if(f.id===undefined)return;
 if(f.method==='initialize'){send({method:'fixture/initializing'});return setTimeout(()=>send({id:f.id,result:{}}),40)}
 if(f.method==='account/read')return send({id:f.id,result:{account:{type:'chatgpt'}}});
 if(f.method==='model/list')return send({id:f.id,result:{data:[{id:'m',model:'m',isDefault:true,defaultReasoningEffort:'medium'}]}});
 if(f.method==='echo')return setTimeout(()=>send({id:f.id,result:f.params}),20);
});
`;

async function fixture(t, { start = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tangent-reconnect-'));
  const binary = join(directory, 'codex-fixture.mjs');
  await writeFile(binary, fixtureSource); await chmod(binary, 0o700);
  const client = new CodexClient({ binary, cwd: directory, requestTimeoutMs: 1000 });
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); await client.close(); await rm(directory, { recursive: true, force: true }); });
  if (start) await client.start();
  return { directory, client, cleanups };
}

function initializing(client) {
  return new Promise(resolve => {
    const listener = event => { if (event.method === 'fixture/initializing') { client.off('notification', listener); resolve(); } };
    client.on('notification', listener);
  });
}

test('close before binary lookup completes prevents a late subprocess from reconnecting', async t => {
  const { client } = await fixture(t, { start: false });
  const starting = client.start(); const result = Promise.allSettled([starting]);
  await client.close();
  assert.equal((await result)[0].status, 'rejected');
  assert.equal(client.connection.connected, false);
  assert.equal(client.child, null);
});

test('start during a cancelled handshake waits for close and creates a fresh connection', async t => {
  const { client } = await fixture(t, { start: false });
  const handshake = initializing(client);
  const first = client.start(); const cancelled = assert.rejects(first, /connection closed/i);
  await handshake;
  const oldChild = client.child;
  const closing = client.close();
  const replacement = client.start();
  await closing;
  assert.equal((await replacement).connected, true);
  await cancelled;
  assert.notEqual(client.child, oldChild);
  assert.equal((await client.request('echo', { ready: true })).ready, true);
});

test('late frames, pipe errors, and exit from a retired child cannot poison its replacement', async t => {
  const { client } = await fixture(t);
  const retired = client.child;
  await client.close(); await client.start();
  const replacement = client.child, errors = [], notifications = [];
  client.on('error', error => errors.push(error.message));
  client.on('notification', event => notifications.push(event));
  const pending = client.request('echo', { replacement: true });
  retired.stdin.emit('error', Object.assign(new Error('old pipe'), { code: 'EPIPE' }));
  retired.emit('error', Object.assign(new Error('old process'), { code: 'OLD' }));
  retired.stdout.emit('data', '{"method":"stale/notification"}\nnot-json\n');
  retired.emit('exit', 7, null);
  assert.deepEqual(await pending, { replacement: true });
  assert.equal(client.child, replacement);
  assert.equal(client.connection.connected, true);
  assert.deepEqual(errors, []); assert.deepEqual(notifications, []);
});

test('a live pipe failure marks the connection down and start replaces the failed child', async t => {
  const { client } = await fixture(t);
  const failed = client.child;
  failed.stdin.emit('error', Object.assign(new Error('pipe'), { code: 'EPIPE' }));
  assert.equal(client.connection.connected, false);
  assert.equal((await client.start()).connected, true);
  assert.notEqual(client.child, failed);
});

test('repeated reconnect during handshake shares one replacement and preserves canvas drafts and queues', async t => {
  const { client, directory, cleanups } = await fixture(t, { start: false });
  const store = new CanvasStore(join(directory, 'profile')), service = new CanvasService(store, client);
  cleanups.push(() => service.close());
  await service.connect();
  const board = store.state.boards[0];
  const chat = service.makeNode(board, 'chat');
  chat.draft = 'Keep my next question'; chat.queue = [{ id: 'queued', text: 'Send only when I resume', status: 'queued' }]; chat.queuePaused = true;
  chat.messages = [{ id: 'answer', role: 'assistant', text: 'Keep my history', turnId: 'finished' }]; chat.threadId = 'existing-native-thread';
  const before = structuredClone(chat);
  let handshakes = 0;
  client.on('notification', event => { if (event.method === 'fixture/initializing') handshakes++; });
  const handshake = initializing(client);
  const first = service.invoke('app/reconnect');
  await handshake;
  const second = service.invoke('app/reconnect');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.connected), [true, true]);
  assert.deepEqual(results.map(result => result.error), [undefined, undefined]);
  assert.equal(handshakes, 1, 'All clicks share one replacement subprocess');
  assert.deepEqual(chat, before);
  assert.deepEqual(await client.request('echo', { usable: true }), { usable: true });
});

test('reconnect during first app connection cannot let its cancelled startup overwrite recovery', async t => {
  const { client, directory, cleanups } = await fixture(t, { start: false });
  const service = new CanvasService(new CanvasStore(join(directory, 'profile')), client);
  cleanups.push(() => service.close());
  const handshake = initializing(client), initial = service.connect();
  await handshake;
  const recovered = service.invoke('app/reconnect'), joined = service.connect();
  await initial;
  assert.equal((await recovered).connected, true);
  assert.equal((await joined).connected, true);
  assert.equal(service.connection.error, undefined);
});

test('app shutdown during reconnect closes its pending handshake without starting another child', async t => {
  const { client, directory, cleanups } = await fixture(t, { start: false });
  const service = new CanvasService(new CanvasStore(join(directory, 'profile')), client);
  cleanups.push(() => service.close());
  await service.connect();
  const handshake = initializing(client), reconnecting = service.reconnect();
  await handshake;
  await service.close(); await reconnecting;
  assert.equal(client.child, null);
  assert.equal(client.connection.connected, false);
  assert.equal(service.connection.connected, false);
});
