import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { stat, access } from 'node:fs/promises';
import { DocumentMcpBridge } from '../electron/document-mcp.mjs';

const tools = [{ type: 'function', name: 'create_document', description: 'Create a document',
  inputSchema: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'], additionalProperties: false } }];

function relay(config, t) {
  const definition = config.mcp_servers.tangent_canvas;
  const child = spawn(definition.command, definition.args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...definition.env } });
  let buffer = ''; let nextId = 0; const pending = new Map();
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => {
    buffer += chunk; let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      const request = pending.get(value.id); if (!request) continue;
      clearTimeout(request.timer); pending.delete(value.id); request.resolve(value);
    }
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = new Promise(resolve => child.once('exit', resolve)); child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1000); await done; clearTimeout(timer);
  };
  t.after(close);
  return { child, close, request(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Relay response timed out')); }, 3000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  } };
}

test('private Unix bridge and real stdio relay route document call to bound card', async t => {
  const calls = [];
  const bridge = new DocumentMcpBridge({ tools, onToolCall: async (...args) => { calls.push(args); return { id: 'doc-1', saved: true }; } });
  await bridge.start(); t.after(() => bridge.close());
  assert.equal(typeof bridge.server.address(), 'string');
  assert.equal((await stat(bridge.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(bridge.socketPath)).mode & 0o777, 0o600);
  const config = bridge.configFor('card-one');
  assert.equal(config.mcp_servers.tangent_canvas.tools.create_document.approval_mode, 'approve');
  const client = relay(config, t);
  assert.equal((await client.request('initialize', { protocolVersion: '2025-03-26' })).result.protocolVersion, '2025-03-26');
  const catalog = (await client.request('tools/list')).result;
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['create_document']);
  const result = (await client.request('tools/call', { name: 'create_document', arguments: { markdown: 'Hello canvas' } })).result;
  assert.deepEqual(calls, [['card-one', 'create_document', { markdown: 'Hello canvas' }]]);
  assert.deepEqual(JSON.parse(result.content[0].text), { id: 'doc-1', saved: true });
  await client.close(); const directory = bridge.directory; await bridge.close(); await assert.rejects(access(directory));
});

test('unknown tools, wrong capability and revoked card cannot invoke handler', async t => {
  let calls = 0;
  const bridge = new DocumentMcpBridge({ tools, onToolCall: () => { calls++; return {}; } });
  await bridge.start(); t.after(() => bridge.close());
  const config = bridge.configFor('card-two'); const client = relay(config, t);
  const unknown = (await client.request('tools/call', { name: 'delete_everything', arguments: {} })).result;
  assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /Unknown canvas document tool/);
  bridge.revoke('card-two');
  const revoked = (await client.request('tools/call', { name: 'create_document', arguments: {} })).result;
  assert.equal(revoked.isError, true); assert.match(revoked.content[0].text, /authorization expired/);
  assert.equal(calls, 0);
  const rejected = await new Promise(resolve => {
    const socket = net.createConnection(bridge.socketPath); let buffer = '';
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, token: 'wrong', method: 'tools/list' })}\n`));
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { resolve(JSON.parse(buffer.trim())); socket.destroy(); } });
  });
  assert.match(rejected.error, /authorization expired/);
});

test('tool callback failure is returned as explicit MCP error without taking down bridge', async t => {
  const bridge = new DocumentMcpBridge({ tools, onToolCall: () => { throw new Error('Document no longer exists'); } });
  await bridge.start(); t.after(() => bridge.close()); const client = relay(bridge.configFor('card-three'), t);
  const failed = (await client.request('tools/call', { name: 'create_document', arguments: {} })).result;
  assert.equal(failed.isError, true); assert.equal(failed.content[0].text, 'Document no longer exists');
  assert.equal((await client.request('tools/list')).result.tools.length, 1);
});
