import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { imageMessage } from './inline-images.mjs';

const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class CodexRpcError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message || 'Codex request failed'}`);
    this.name = 'CodexRpcError';
    this.code = error?.code;
    this.data = error?.data;
    this.method = method;
  }
}

/** Locate the user's CLI without invoking a shell or changing their configuration. */
export async function findCodexBinary(explicit) {
  if (explicit) return explicit;
  const candidates = [
    ...String(process.env.PATH || '').split(delimiter).filter(Boolean).map(p => join(p, 'codex')),
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    join(homedir(), '.local/bin/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  ];
  for (const candidate of [...new Set(candidates)]) {
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next location */ }
  }
  throw new Error('Codex CLI was not found. Install Codex and sign in with ChatGPT, then reconnect.');
}

/**
 * A private stdio connection to the official local Codex app-server. It reuses
 * the existing login; it never reads tokens, edits config, or exposes a port.
 */
export class CodexClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.cwd = resolve(options.cwd || process.cwd());
    this.connection = { connected: false, models: [] };
    this.pending = new Map();
    this.serverRequests = new Map();
    this.contexts = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.child = null;
    this.startPromise = null;
    this.closePromise = null;
    this.generation = 0;
    this.closing = false;
    // Error remains observable without EventEmitter's default process crash.
    this.on('error', () => {});
  }

  async start() {
    // A reconnect may arrive while the previous initialize RPC is being
    // closed. Never hand it that cancelled startup or spawn beside its child.
    if (this.closePromise) { await this.closePromise; return this.start(); }
    if (this.startPromise) return this.startPromise;
    if (this.connection.connected && this.child && !this.child.killed && this.child.exitCode === null && this.child.signalCode === null && this.child.stdin.writable) return this.connection;
    if (this.child) { await this.close(); return this.start(); }
    this.closing = false;
    const generation = ++this.generation;
    const starting = this._start(generation).finally(() => {
      if (this.startPromise === starting) this.startPromise = null;
    });
    this.startPromise = starting;
    return starting;
  }

  async _start(generation) {
    this.buffer = '';
    const binary = await findCodexBinary(this.options.binary);
    if (generation !== this.generation || this.closing) throw new Error('Codex connection closed');
    const environment = { ...process.env };
    // A CLI launched while building/testing inside another Codex chat must not
    // inherit that chat's identity or private desktop tool channel. Auth/home
    // and ordinary tool locations remain the user's existing configuration.
    for (const name of Object.keys(environment)) {
      if (/^CODEX_(?:THREAD_ID|SESSION_ID|INTERNAL_ORIGINATOR_OVERRIDE|APP_TOOLS_PIPE_PATH|TASK_WORKSPACE_VERIFYING_IDENTITY)$/.test(name) ||
          /^CODEX_(?:PARENT|ACTIVE|AGENT)_/.test(name)) delete environment[name];
    }
    const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { ...environment, PATH: [...new Set([
        '/opt/homebrew/bin', '/usr/local/bin', ...String(process.env.PATH || '').split(delimiter),
      ])].join(delimiter) },
    });
    this.child = child;
    const current = () => this.child === child && this.generation === generation;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (current()) this._receive(chunk, child, generation); });
    // App-server diagnostics may contain user paths or provider data; drain
    // rather than copying them into canvas state or logs.
    child.stderr.resume();
    child.stdin.on('error', error => {
      if (current() && !this.closing) this._fail(new Error(`Codex connection could not write: ${error.code || 'pipe closed'}`));
    });
    child.on('error', error => { if (current()) this._fail(new Error(`Could not start Codex: ${error.code || error.message}`)); });
    child.on('exit', (code, signal) => {
      if (!current()) return;
      this.child = null;
      this.connection = { ...this.connection, connected: false,
        ...(this.closing ? {} : { error: `Codex stopped${signal ? ` (${signal})` : ` (exit ${code})`}. Reconnect to continue.` }) };
      this._rejectPending(new Error(this.closing ? 'Codex connection closed' : this.connection.error));
      this.serverRequests.clear();
      this.emit('exit', { code, signal });
    });
    try {
      await this.request('initialize', {
        clientInfo: { name: 'tangent_canvas', title: 'Tangent Canvas', version: '0.4.1' },
        capabilities: { experimentalApi: true, requestAttestation: false, explicitGatewayOauth: true },
      });
      if (!current()) throw new Error('Codex connection closed');
      this.notify('initialized', {});
      const [accountResult, modelsResult] = await Promise.all([
        this.request('account/read', { refreshToken: false }),
        this.request('model/list', { includeHidden: false, limit: 100 }),
      ]);
      if (!current()) throw new Error('Codex connection closed');
      const models = (modelsResult.data || []).map(m => ({
        id: m.id, model: m.model, displayName: m.displayName, description: m.description,
        isDefault: m.isDefault, supportedReasoningEfforts: m.supportedReasoningEfforts,
        defaultReasoningEffort: m.defaultReasoningEffort,
      }));
      const selected = models.find(m => m.isDefault) || models[0];
      this.connection = {
        connected: true, account: accountResult.account || undefined, models,
        model: selected?.model, effort: selected?.defaultReasoningEffort || 'medium',
        ...(!accountResult.account && accountResult.requiresOpenaiAuth
          ? { error: 'Codex is not signed in. Run codex login, then reconnect.' } : {}),
      };
      return this.connection;
    } catch (error) {
      // A retired startup must not close a replacement started by reconnect.
      if (generation === this.generation) {
        this.connection = { connected: false, models: [], error: error.message };
        await this.close();
      }
      throw error;
    }
  }

  request(method, params = {}) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return Promise.reject(new Error('Codex is disconnected. Reconnect to continue.'));
    }
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. Codex may be busy; try reconnecting.`));
      }, this.options.requestTimeoutMs || 120_000);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      try { this._write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this._write({ method, params }); }

  respond(id, result) {
    this.serverRequests.delete(id);
    this._write({ id, result });
  }

  reject(id, message = 'This request is not supported by Tangent Canvas.', code = -32601) {
    this.serverRequests.delete(id);
    this._write({ id, error: { code, message } });
  }

  _write(frame) {
    if (!this.child?.stdin.writable) throw new Error('Codex connection is closed.');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  _receive(chunk, child = this.child, generation = this.generation) {
    if (child !== this.child || generation !== this.generation) return;
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES && !this.buffer.includes('\n')) {
      this._fail(new Error('Codex sent an oversized protocol message. Reconnect to continue.'));
      child?.kill();
      return;
    }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      if (child !== this.child || generation !== this.generation) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); }
      catch { this._fail(new Error('Codex sent an invalid protocol message. Reconnect to continue.')); child?.kill(); return; }
      if (frame.method) {
        if (frame.id !== undefined && frame.id !== null) {
          this.serverRequests.set(frame.id, frame.method);
          if (this.listenerCount('serverRequest')) {
            this.emit('serverRequest', { id: frame.id, method: frame.method, params: frame.params || {} });
          } else {
            this.reject(frame.id);
          }
        } else {
          if (frame.method === 'serverRequest/resolved') this.serverRequests.delete(frame.params?.requestId);
          this.emit('notification', { method: frame.method, params: frame.params || {} });
        }
      } else if (frame.id !== undefined && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error) entry.reject(new CodexRpcError(entry.method, frame.error));
        else entry.resolve(frame.result);
      }
    }
  }

  _rejectPending(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }

  _fail(error) {
    this.connection = { ...this.connection, connected: false, error: error.message };
    this._rejectPending(error); this.serverRequests.clear(); this.emit('error', error);
  }

  _threadConfig({ cwd, model, effort, sandbox, approvalPolicy, approvalsReviewer, developerInstructions, config } = {}) {
    const hasProject = typeof cwd === 'string' && cwd.length > 0;
    if (sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
      throw new Error('Unknown Codex sandbox mode.');
    }
    if (approvalsReviewer && !['user', 'auto_review'].includes(approvalsReviewer)) throw new Error('Unknown Codex approval reviewer.');
    return {
      cwd: hasProject ? resolve(cwd) : this.cwd,
      model: model || this.connection.model,
      approvalPolicy: approvalPolicy || 'on-request', approvalsReviewer: approvalsReviewer || 'user', sandbox: sandbox || (hasProject ? 'workspace-write' : 'read-only'),
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(config || effort ? { config: { ...(config || {}), ...(effort ? { model_reasoning_effort: effort } : {}) } } : {}),
    };
  }

  async newThread(options = {}) {
    const config = this._threadConfig(options);
    if (options.dynamicTools !== undefined && !Array.isArray(options.dynamicTools)) {
      throw new Error('Dynamic tools must be an array of tool definitions.');
    }
    const result = await this.request('thread/start', {
      ...config, ephemeral: false, ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
    });
    this.contexts.set(result.thread.id, { ...options, cwd: options.cwd || null });
    return result.thread;
  }

  async readThread(threadId) {
    const { thread } = await this.request('thread/read', { threadId, includeTurns: true });
    if (thread.historyMode === 'paginated') {
      const turns = [];
      let cursor;
      const seen = new Set();
      do {
        const page = await this.request('thread/turns/list', {
          threadId, limit: 100, sortDirection: 'asc', itemsView: 'full', ...(cursor ? { cursor } : {}),
        });
        turns.push(...page.data);
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Codex returned repeated history pages.');
        seen.add(cursor);
      } while (cursor);
      thread.turns = turns;
    }
    return thread;
  }

  async resumeThread(threadId, options = {}) {
    const result = await this.request('thread/resume', {
      threadId, ...this._threadConfig(options), excludeTurns: false,
    });
    this.contexts.set(result.thread.id, { ...options, cwd: options.cwd || null });
    return result.thread.historyMode === 'paginated' ? this.readThread(result.thread.id) : result.thread;
  }

  async forkThread(threadId, options = {}) {
    const { turnId, ...configOptions } = options;
    const result = await this.request('thread/fork', {
      threadId, ...(turnId ? { lastTurnId: turnId } : {}),
      ...this._threadConfig(configOptions), excludeTurns: false, ephemeral: false,
      // A branch is an explicit side question, never an automatic parent goal continuation.
      deferGoalContinuation: true,
    });
    if (result.thread.id === threadId) throw new Error('Codex did not create a separate branch.');
    // Native forks may carry an active goal. Defer its continuation first,
    // then remove it from the NEW child before it can accept a side question.
    // The source goal and source thread are never changed.
    const childGoal = await this.request('thread/goal/get', { threadId: result.thread.id });
    if (childGoal.goal) {
      await this.request('thread/goal/clear', { threadId: result.thread.id, origin: 'user' });
    }
    this.contexts.set(result.thread.id, { ...configOptions, cwd: configOptions.cwd || null });
    const thread = result.thread.historyMode === 'paginated' ? await this.readThread(result.thread.id) : result.thread;
    if (turnId && thread.turns?.at(-1)?.id !== turnId) {
      throw new Error('Codex could not confirm the selected reply as the branch boundary.');
    }
    return thread;
  }

  async sendTurn(threadId, text, options = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Write a message before sending.');
    const previous = this.contexts.get(threadId) || {};
    const requestedSandbox = options.sandbox ?? previous.sandbox;
    const hasProject = requestedSandbox !== 'read-only' &&
      typeof (options.cwd ?? previous.cwd) === 'string' && Boolean(options.cwd ?? previous.cwd);
    if (options.sandboxPolicy && !['readOnly', 'workspaceWrite', 'dangerFullAccess'].includes(options.sandboxPolicy.type)) {
      throw new Error('Unknown Codex sandbox policy.');
    }
    if (requestedSandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(requestedSandbox)) throw new Error('Unknown Codex sandbox mode.');
    const approvalsReviewer = options.approvalsReviewer ?? previous.approvalsReviewer ?? 'user';
    if (!['user', 'auto_review'].includes(approvalsReviewer)) throw new Error('Unknown Codex approval reviewer.');
    const result = await this.request('turn/start', {
      threadId, input: [{ type: 'text', text, text_elements: [] }],
      ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
      ...(options.additionalContext !== undefined ? { additionalContext: options.additionalContext } : {}),
      model: options.model || this.connection.model,
      effort: options.effort || this.connection.effort || 'medium',
      ...(options.cwd ? { cwd: resolve(options.cwd) } : {}),
      approvalPolicy: options.approvalPolicy ?? previous.approvalPolicy ?? 'on-request', approvalsReviewer,
      sandboxPolicy: options.sandboxPolicy || (requestedSandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : hasProject
        ? { type: 'workspaceWrite', writableRoots: [resolve(options.cwd || previous.cwd)], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true }
        : { type: 'readOnly', networkAccess: false }),
    });
    this.contexts.set(threadId, { ...previous, ...options });
    return result.turn;
  }

  interrupt(threadId, turnId) { return this.request('turn/interrupt', { threadId, turnId }); }

  /** Add a user direction to the currently active native turn, never a new turn. */
  async steerTurn(threadId, text, { expectedTurnId, clientUserMessageId, additionalContext } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Write a message before steering.');
    if (typeof expectedTurnId !== 'string' || !expectedTurnId.trim()) {
      throw new Error('Choose the active turn before steering.');
    }
    if (clientUserMessageId !== undefined && (typeof clientUserMessageId !== 'string' || !clientUserMessageId)) {
      throw new Error('The steering message ID must be a nonempty string.');
    }
    return this.request('turn/steer', {
      threadId, expectedTurnId, input: [{ type: 'text', text, text_elements: [] }],
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(additionalContext !== undefined ? { additionalContext } : {}),
    });
  }

  listThreads({ search, cursor } = {}) {
    return this.request('thread/list', {
      limit: 50, sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [],
      ...(search?.trim() ? { searchTerm: search.trim() } : {}), ...(cursor ? { cursor } : {}),
    });
  }

  threadMessages(thread) { return threadMessages(thread); }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    ++this.generation;
    this.connection = { ...this.connection, connected: false };
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.buffer = '';
    this._rejectPending(new Error('Codex connection closed'));
    this.serverRequests.clear();
    const closing = this._closeChild(child).finally(() => {
      if (this.closePromise === closing) this.closePromise = null;
    });
    this.closePromise = closing;
    return closing;
  }

  async _closeChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolveClose => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); clearTimeout(hardTimer); resolveClose(); } };
      const timer = setTimeout(() => child.kill('SIGTERM'), 750);
      const hardTimer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 3000);
      timer.unref?.(); hardTimer.unref?.();
      child.once('exit', finish);
      try { child.stdin.end(); } catch { child.kill('SIGTERM'); }
    });
  }
}

/** Preserve Codex item IDs and exact turn IDs for historical fork actions. */
export function threadMessages(thread, { imageAsset } = {}) {
  const messages = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (item.type === 'imageGeneration' && imageAsset && item.status !== 'failed' && !item.failure) {
        try {
          const asset = imageAsset(item);
          if (asset) messages.push(imageMessage(item, turn.id, asset,
            new Date((turn.startedAt || thread.createdAt || 0) * 1000).toISOString()));
        } catch { /* Preserve the text history if an old image is no longer available. */ }
        continue;
      }
      if (item.type !== 'userMessage' && item.type !== 'agentMessage') continue;
      const text = item.type === 'agentMessage' ? item.text : (item.content || [])
        .map(input => input.type === 'text' ? input.text : input.type === 'image' || input.type === 'localImage' ? '[Image]' : '')
        .filter(Boolean).join('\n');
      if (!text) continue;
      messages.push({ id: item.id, role: item.type === 'userMessage' ? 'user' : 'assistant',
        text, turnId: turn.id,
        createdAt: new Date((turn.startedAt || thread.createdAt || 0) * 1000).toISOString(),
        status: turn.status,
      });
    }
  }
  return messages;
}
