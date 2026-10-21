import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const SERVER_NAME = 'tangent_canvas';

/**
 * App-owned document tools for imported native Codex threads. Each canvas card
 * receives its own capability token, bound to a context ID known before the
 * native thread is created. No TCP listener or shared Codex config is used.
 */
export class DocumentMcpBridge {
  constructor({ tools = [], onToolCall } = {}) {
    this.tools = tools.filter(tool => !tool.type || tool.type === 'function').map(tool => ({
      name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: /^(?:read|list|get)_/.test(tool.name), destructiveHint: false,
        idempotentHint: /^(?:read|list|get|update)_/.test(tool.name), openWorldHint: false, ...tool.annotations },
    }));
    if (!this.tools.length) throw new Error('At least one canvas document tool is required.');
    if (new Set(this.tools.map(tool => tool.name)).size !== this.tools.length ||
        this.tools.some(tool => !/^[a-zA-Z0-9_-]{1,128}$/.test(tool.name) || !tool.inputSchema)) {
      throw new Error('Canvas document tool definitions must have unique valid names and input schemas.');
    }
    this.onToolCall = onToolCall;
    this.contextTokens = new Map(); this.tokens = new Map(); this.sockets = new Set();
    this.server = null; this.directory = null; this.socketPath = null;
  }

  async start(onToolCall) {
    if (onToolCall) this.onToolCall = onToolCall;
    if (typeof this.onToolCall !== 'function') throw new Error('A canvas document handler is required.');
    if (this.server) return this;
    // /tmp keeps the Unix socket below macOS's short sun_path limit. The
    // containing directory and socket are private to this user.
    this.directory = await mkdtemp('/tmp/tangent-mcp-');
    await chmod(this.directory, 0o700);
    this.socketPath = join(this.directory, 'canvas.sock');
    this.server = net.createServer(socket => this._connection(socket));
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.socketPath, () => { this.server.off('error', reject); resolve(); });
      });
      await chmod(this.socketPath, 0o600);
      // Keep unexpected OS socket errors contained; individual relay requests
      // receive their own explicit connection failure.
      this.server.on('error', () => {});
      return this;
    } catch (error) { await this.close(); throw error; }
  }

  configFor(contextId) {
    if (!this.server || !this.socketPath) throw new Error('Canvas document bridge is not running.');
    if (typeof contextId !== 'string' || !contextId) throw new Error('A canvas conversation context is required.');
    let token = this.contextTokens.get(contextId);
    if (!token) { token = randomBytes(32).toString('hex'); this.contextTokens.set(contextId, token); this.tokens.set(token, contextId); }
    const approvals = Object.fromEntries(this.tools.map(tool => [tool.name, { approval_mode: 'approve' }]));
    return { mcp_servers: { [SERVER_NAME]: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./document-mcp-client.cjs', import.meta.url))],
      env: { ELECTRON_RUN_AS_NODE: '1', TANGENT_DOCUMENT_SOCKET: this.socketPath, TANGENT_DOCUMENT_TOKEN: token },
      enabled: true, required: true, startup_timeout_sec: 15, tool_timeout_sec: 30,
      // Only these app-owned, reversible document operations are approved.
      // Shell, filesystem escalation and every other MCP server keep policy.
      tools: approvals,
    } } };
  }

  config(contextId) { return this.configFor(contextId); }

  revoke(contextId) {
    const token = this.contextTokens.get(contextId);
    if (token) this.tokens.delete(token);
    this.contextTokens.delete(contextId);
  }

  _connection(socket) {
    this.sockets.add(socket); socket.setEncoding('utf8');
    let buffer = ''; let inFlight = 0;
    const send = frame => { if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`); };
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) { socket.destroy(); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let request;
        try { request = JSON.parse(line); } catch { send({ id: null, error: 'Invalid canvas document request.' }); socket.end(); return; }
        const contextId = this.tokens.get(request.token);
        if (!contextId) { send({ id: request.id, error: 'Canvas document authorization expired. Reconnect Codex.' }); socket.end(); return; }
        if (inFlight >= 32) { send({ id: request.id, error: 'Too many concurrent canvas document operations.' }); continue; }
        inFlight++;
        this._dispatch(contextId, request).then(result => send({ id: request.id, result }),
          error => send({ id: request.id, error: error?.message || 'Canvas document operation failed.' })).finally(() => inFlight--);
      }
    });
  }

  async _dispatch(contextId, request) {
    if (request.method === 'tools/list') return { tools: this.tools };
    if (request.method !== 'tools/call') throw new Error('Unsupported canvas document operation.');
    const name = request.params?.name;
    if (!this.tools.some(tool => tool.name === name)) throw new Error('Unknown canvas document tool.');
    const args = request.params?.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Document tool arguments must be an object.');
    return this.onToolCall(contextId, name, args);
  }

  async close() {
    const server = this.server; this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear(); this.contextTokens.clear(); this.tokens.clear();
    if (server) await new Promise(resolve => server.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = null; this.socketPath = null;
  }
}

export { DocumentMcpBridge as DocumentMcpServer };
