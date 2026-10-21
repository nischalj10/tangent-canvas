import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient } from '../electron/codex.mjs';
import { DocumentMcpBridge } from '../electron/document-mcp.mjs';

const live = process.env.TANGENT_BRIDGE_TEST === '1';
const documentTool = { type: 'function', name: 'create_canvas_document', description: 'Create a native document on this canvas.',
  inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } },
    required: ['title', 'markdown'], additionalProperties: false } };

async function finishedTurn(client, threadId, text) {
  let listener; let timer;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Bridge verification turn timed out')), 120_000);
    listener = ({ method, params }) => {
      if (params.threadId !== threadId || method !== 'turn/completed') return;
      if (params.turn.status === 'failed') reject(new Error(params.turn.error?.message || 'Turn failed'));
      else resolve(params.turn);
    };
    client.on('notification', listener);
  });
  try { await client.sendTurn(threadId, text, { model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only' }); return await done; }
  finally { clearTimeout(timer); client.off('notification', listener); }
}

test('LIVE dynamic document tools survive native fork and process restart', { skip: !live, timeout: 300_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-dynamic-'));
  const client = new CodexClient({ cwd: folder }); const owned = []; const calls = [];
  const attachHandler = () => client.on('serverRequest', request => {
    if (request.method === 'item/tool/call' && request.params.tool === documentTool.name) {
      calls.push(request.params);
      client.respond(request.id, { success: true, contentItems: [{ type: 'inputText', text: 'Document saved successfully.' }] });
    } else client.reject(request.id);
  });
  t.after(async () => { for (const threadId of owned.reverse()) { try { await client.request('thread/archive', { threadId }); } catch {} } await client.close(); await rm(folder, { recursive: true, force: true }); });
  await client.start(); attachHandler();
  const parent = await client.newThread({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only', dynamicTools: [documentTool] }); owned.push(parent.id);
  const first = await finishedTurn(client, parent.id, 'Use create_canvas_document to create a document titled Parent check with exactly the text PARENT-PREFIX. Use no other tool.');
  assert.equal(calls.length, 1);
  const child = await client.forkThread(parent.id, { turnId: first.id, sandbox: 'read-only', model: 'gpt-6.1-sol' }); owned.push(child.id);
  await finishedTurn(client, child.id, 'Use create_canvas_document to create a separate document titled Child check with exactly the text CHILD-ONLY. Use no other tool.');
  assert.equal(calls.length, 2); assert.equal(calls[1].threadId, child.id);
  await client.close(); await client.start();
  await client.resumeThread(child.id, { sandbox: 'read-only', model: 'gpt-6.1-sol' });
  await finishedTurn(client, child.id, 'Use create_canvas_document to create a separate document titled Restart check with exactly the text RESTART-OK. Use no other tool.');
  assert.equal(calls.length, 3); assert.equal(calls[2].threadId, child.id);
  t.diagnostic('Native dynamic document tool persisted through fork and app-server restart/resume.');
});

test('LIVE per-thread MCP can attach document tools to an imported native fork', { skip: !live, timeout: 300_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-import-tools-'));
  const script = join(folder, 'fixture-mcp.cjs'); const marker = join(folder, 'document.json');
  await writeFile(script, `const rl=require('node:readline').createInterface({input:process.stdin});const fs=require('node:fs');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');rl.on('line',line=>{const f=JSON.parse(line);if(f.id===undefined)return;
if(f.method==='initialize')return send({jsonrpc:'2.0',id:f.id,result:{protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'tangent-verification',version:'1.0.0'}}});
if(f.method==='tools/list')return send({jsonrpc:'2.0',id:f.id,result:{tools:[{name:'create_document',description:'Create a native document on this canvas.',inputSchema:{type:'object',properties:{title:{type:'string'},markdown:{type:'string'}},required:['title','markdown'],additionalProperties:false}}]}});
if(f.method==='tools/call'){fs.writeFileSync(process.env.TANGENT_VERIFICATION_OUTPUT,JSON.stringify(f.params.arguments));return send({jsonrpc:'2.0',id:f.id,result:{content:[{type:'text',text:'Document saved successfully.'}]}})}
return send({jsonrpc:'2.0',id:f.id,error:{code:-32601,message:'Unsupported method'}});});`);
  const client = new CodexClient({ cwd: folder }); const owned = [];
  t.after(async () => { for (const threadId of owned.reverse()) { try { await client.request('thread/archive', { threadId }); } catch {} } await client.close(); await rm(folder, { recursive: true, force: true }); });
  await client.start();
  client.on('serverRequest', request => {
    t.diagnostic(JSON.stringify({ verificationRequest: request.method, server: request.params.serverName, mode: request.params.mode }));
    if (request.method === 'mcpServer/elicitation/request' && request.params.serverName === 'tangent_verify') {
      client.respond(request.id, { action: 'accept', content: {} });
    } else client.reject(request.id, 'Only the explicitly requested local verification document tool is permitted.');
  });
  const parent = await client.newThread({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only' }); owned.push(parent.id);
  const first = await finishedTurn(client, parent.id, 'Remember imported_marker=CANVAS-MCP-83. Use no tools. Reply exactly CANVAS-MCP-83.');
  const child = await client.forkThread(parent.id, { turnId: first.id, model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only',
    config: { mcp_servers: { tangent_verify: { command: process.execPath, args: [script], enabled: true, required: true,
      env: { TANGENT_VERIFICATION_OUTPUT: marker }, startup_timeout_sec: 20 } } } }); owned.push(child.id);
  const inventory = await client.request('mcpServerStatus/list', { threadId: child.id, serverName: 'tangent_verify', detail: 'toolsAndAuthOnly' });
  t.diagnostic(JSON.stringify({ verificationMcp: inventory.data.map(s => ({ name: s.name, runtimeStatus: s.runtimeStatus, toolNames: Object.keys(s.tools || {}), toolsError: s.toolsError })) }));
  await finishedTurn(client, child.id,
    'Use the tangent_verify MCP server create_document tool to create a document titled Imported context check containing exactly the imported_marker value from the inherited conversation. Its function name is mcp__tangent_verify__create_document. It is available and connected. If tools are deferred, discover it first. Do not guess and do not use shell or files.');
  const childRead = await client.readThread(child.id);
  t.diagnostic(JSON.stringify({ verificationTurn: childRead.turns.at(-1).items.filter(i => ['agentMessage', 'mcpToolCall'].includes(i.type)).map(i => ({ type: i.type, text: i.text, server: i.server, tool: i.tool, error: i.error })) }));
  const result = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(result.markdown, 'CANVAS-MCP-83');
  assert.equal((await client.readThread(parent.id)).turns.length, 1);
  t.diagnostic('Per-thread MCP override attached a document tool to a native fork without altering source history or global config.');
});

test('LIVE production Unix document bridge works on imported fork with scoped tool policy', { skip: !live, timeout: 300_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-production-bridge-'));
  const calls = []; const owned = [];
  const bridge = new DocumentMcpBridge({ tools: [{ ...documentTool, name: 'create_document' }],
    onToolCall: async (contextId, name, args) => { calls.push({ contextId, name, args }); return { id: 'production-verification-doc', saved: true }; } });
  await bridge.start();
  const client = new CodexClient({ cwd: folder }); let approvals = 0;
  t.after(async () => { for (const threadId of owned.reverse()) { try { await client.request('thread/archive', { threadId }); } catch {} } await client.close(); await bridge.close(); await rm(folder, { recursive: true, force: true }); });
  await client.start();
  client.on('serverRequest', request => { approvals++; client.reject(request.id, 'This test never approves unconfigured tools or sandbox escalation.'); });
  const parent = await client.newThread({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only' }); owned.push(parent.id);
  const first = await finishedTurn(client, parent.id, 'Remember import_marker=NATIVE-UNIX-42. Use no tools. Reply exactly NATIVE-UNIX-42.');
  const child = await client.forkThread(parent.id, { turnId: first.id, model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only', config: bridge.configFor('verification-canvas-card') }); owned.push(child.id);
  await finishedTurn(client, child.id,
    'Use the tangent_canvas MCP server create_document tool to create a document titled Native import verification. Its markdown must contain exactly the import_marker value from inherited context. Discover the tool if needed. Do not use shell, files or any other tool.');
  assert.equal(calls.length, 1); assert.equal(calls[0].contextId, 'verification-canvas-card');
  assert.equal(calls[0].args.markdown, 'NATIVE-UNIX-42'); assert.equal(approvals, 0);
  assert.equal((await client.readThread(parent.id)).turns.length, 1);
  t.diagnostic('Production private Unix bridge created an imported-fork document with inherited context; only owned doc tool auto-approved; no general approval or global config changes.');
});
