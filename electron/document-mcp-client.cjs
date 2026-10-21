// The official Codex runtime launches this small stdio MCP adapter. It has no
// document or filesystem authority of its own: a card-bound Unix capability
// forwards the whitelisted operation to the running Tangent desktop process.
const net = require('node:net');
const socketPath = process.env.TANGENT_DOCUMENT_SOCKET;
const token = process.env.TANGENT_DOCUMENT_TOKEN;
const MAX_BYTES = 8 * 1024 * 1024;
const pending = new Map(); let socket; let connection; let counter = 0; let stdinBuffer = ''; let socketBuffer = '';

function output(frame) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`); }
function failAll(message) { for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error(message)); } pending.clear(); }

function connect() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    if (!socketPath || !token) { reject(new Error('Canvas document connection is unavailable. Reconnect Codex.')); return; }
    socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.once('connect', resolve);
    socket.on('error', () => { reject(new Error('Tangent Canvas is not available. Reconnect Codex.')); failAll('Tangent Canvas is not available. Reconnect Codex.'); });
    socket.on('close', () => { connection = null; failAll('Canvas document connection closed. Reconnect Codex.'); });
    socket.on('data', chunk => {
      socketBuffer += chunk;
      if (Buffer.byteLength(socketBuffer, 'utf8') > MAX_BYTES) { socket.destroy(); failAll('Canvas document response is too large.'); return; }
      let newline;
      while ((newline = socketBuffer.indexOf('\n')) >= 0) {
        const line = socketBuffer.slice(0, newline); socketBuffer = socketBuffer.slice(newline + 1);
        let result; try { result = JSON.parse(line); } catch { failAll('Invalid canvas document response.'); socket.destroy(); return; }
        const task = pending.get(result.id); if (!task) continue;
        pending.delete(result.id); clearTimeout(task.timer);
        if (result.error) task.reject(new Error(result.error)); else task.resolve(result.result);
      }
    });
  });
  return connection;
}

async function request(method, params) {
  await connect(); const id = ++counter;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Canvas document operation timed out.')); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    socket.write(`${JSON.stringify({ id, token, method, params })}\n`);
  });
}

async function handle(frame) {
  if (frame.id === undefined || frame.id === null) return;
  try {
    let result;
    if (frame.method === 'initialize') {
      await connect();
      result = { protocolVersion: frame.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} }, serverInfo: { name: 'Tangent Canvas documents', version: '0.1.0' } };
    } else if (frame.method === 'ping') result = {};
    else if (frame.method === 'tools/list') result = await request('tools/list', {});
    else if (frame.method === 'tools/call') {
      try {
        const value = await request('tools/call', frame.params);
        result = value && Array.isArray(value.content) ? value : { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? {}) }] };
      } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else { output({ id: frame.id, error: { code: -32601, message: 'Unsupported canvas document MCP method.' } }); return; }
    output({ id: frame.id, result });
  } catch (error) { output({ id: frame.id, error: { code: -32603, message: error.message } }); }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  stdinBuffer += chunk;
  if (Buffer.byteLength(stdinBuffer, 'utf8') > MAX_BYTES) { process.exitCode = 1; process.stdin.destroy(); socket?.destroy(); return; }
  let newline;
  while ((newline = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, newline); stdinBuffer = stdinBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    try { void handle(JSON.parse(line)); }
    catch { output({ id: null, error: { code: -32700, message: 'Invalid MCP JSON.' } }); }
  }
});
process.stdin.on('end', () => { socket?.destroy(); failAll('Canvas document client closed.'); });
process.on('SIGTERM', () => { socket?.destroy(); process.exit(0); });
