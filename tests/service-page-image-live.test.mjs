import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';
import { CodexClient } from '../electron/codex.mjs';
import { DocumentMcpBridge } from '../electron/document-mcp.mjs';
import { DOCUMENT_TOOL } from '../electron/documents.mjs';
import { PAGE_TOOL } from '../electron/pages.mjs';

const live = process.env.TANGENT_PAGE_IMAGE_LIVE === '1';
const values = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(values)
  : value && typeof value === 'object' ? Object.values(value).flatMap(values) : [];

test('LIVE new hosted Page uploads real generated PNG, edits with guards, attaches and cleans up', { skip: !live, timeout: 150_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tangent-hosted-image-live-'));
  const imagePath = resolve(process.env.TANGENT_PAGE_TEST_IMAGE || 'work/tangent-live-proof/native-generated-image.png');
  const imageBytes = await readFile(imagePath); assert.equal(imageBytes.subarray(1, 4).toString(), 'PNG');
  const imageDigest = createHash('sha256').update(imageBytes).digest('hex');
  const nonce = randomBytes(4).toString('hex'), title = `Tangent integration check — ${nonce}`;
  const first = `VERSION_ONE_${nonce}`, updated = `VERSION_TWO_${nonce}`, imageAlt = `Native generated integration image ${nonce}`;
  const idempotencyKey = randomUUID();
  const store = new CanvasStore(directory), runtime = new CodexClient({ cwd: directory, requestTimeoutMs: 30_000 });
  const service = new CanvasService(store, runtime), calls = [], approvals = [], approvalErrors = []; let node, createdPageId, createdUrl, cleanupComplete = false, closing = false;
  const bridge = new DocumentMcpBridge({ tools: [DOCUMENT_TOOL, PAGE_TOOL], onToolCall: (contextId, name, args) => service.documentToolForContext(contextId, name, args) });
  await bridge.start(); service.documentBridge = bridge;
  t.after(async () => {
    closing = true; service.closing = true;
    if (createdPageId && node?.threadId && runtime.connection.connected) {
      try {
        const result = await runtime.request('mcpServer/tool/call', { threadId: node.threadId, server: 'codex_apps', tool: 'chatgpt_space.trash_page', arguments: { page_id: createdPageId } });
        cleanupComplete = !result.isError && (result.structuredContent?.trashed === true || values(result).some(text => /"trashed"\s*:\s*true/.test(text)));
      } catch {}
      t.diagnostic(cleanupComplete ? `Cleaned up ONLY the test Page ${createdPageId}.` : `Test Page retained because cleanup was not confirmed: ${createdUrl || `https://chatgpt.com/space/${createdPageId}`}`);
    }
    if (node?.threadId) { try { await runtime.request('thread/archive', { threadId: node.threadId }); } catch {} }
    await service.close(); await rm(directory, { recursive: true, force: true });
  });
  runtime.on('notification', ({ method, params }) => {
    const item = params.item;
    if (method !== 'item/completed' || item?.type !== 'mcpToolCall') return;
    calls.push(item);
    if (item.server === 'codex_apps' && item.tool === 'chatgpt_space.create_page' && !item.error) {
      const result = item.result?.structuredContent;
      createdPageId = result?.metadata?.page_id || result?.content?.page_id || result?.page_id || createdPageId;
      if (createdPageId) createdUrl = `https://chatgpt.com/space/${createdPageId}`;
    }
  });
  runtime.on('serverRequest', request => {
    const p = request.params || {}, meta = p._meta || {}, args = meta.tool_params || {};
    const toolName = p.message?.match(/run tool "([^"]+)"/)?.[1];
    if (request.method === 'mcpServer/elicitation/request' && p.serverName === 'codex_apps' && meta.codex_approval_kind === 'mcp_tool_call') {
      const allowedCreate = toolName === 'chatgpt_space.create_page' && args.title === title && !args.space_id && !args.parent_page_id;
      const ownPage = Boolean(createdPageId && args.page_id === createdPageId);
      const allowedUpload = ownPage && toolName === 'chatgpt_space.write_page_reference' && args.file === imagePath;
      const allowedEditOrRead = ownPage && ['chatgpt_space.edit_page', 'chatgpt_space.read_page', 'chatgpt_space.read_page_reference'].includes(toolName);
      const allowedCleanup = closing && ownPage && toolName === 'chatgpt_space.trash_page';
      const decision = allowedCleanup || !closing && (allowedCreate || allowedUpload || allowedEditOrRead) ? 'accept' : 'decline';
      try {
        assert.equal(node.pendingApproval?.requestId, String(request.id), 'The production approval UI must hold this native request');
        assert.equal(node.pendingApproval?.kind, 'mcpServer/elicitation/request');
        service.approval({requestId:String(request.id),decision});
        approvals.push({tool:toolName,decision,cleanup:allowedCleanup});
      } catch(error) { approvalErrors.push(error.message); }
    }
  });
  await service.connect(); assert.equal(service.connection.account?.type, 'chatgpt');
  const board = store.state.boards[0]; node = service.makeNode(board, 'chat', { title: 'Hosted image integration verification' });
  service.nodeSettings({ boardId: board.id, nodeId: node.id, model: 'gpt-6.1-sol', effort: 'low' });
  let timer, listener;
  const finished = new Promise((resolveTurn, reject) => {
    timer = setTimeout(() => { closing = true; reject(new Error('Hosted Page image workflow exceeded 110 seconds')); }, 110_000);
    listener = () => { if (node.status === 'error') reject(new Error('Native hosted Page image turn failed')); else if (node.status === 'idle' && node.messages.some(message => message.role === 'assistant')) resolveTurn(); };
    service.on('event', listener);
  });
  try {
    await service.send({ boardId: board.id, nodeId: node.id, text:
      `Run this explicitly authorized, private, throwaway rich-Page integration test. Do not touch ANY pre-existing Page. Create exactly ONE NEW PRIVATE hosted ChatGPT Page titled "${title}" with idempotency_key "${idempotencyKey}" and one initial paragraph "${first}". Do not supply parent or Space IDs. Keep its returned exact page_id for every later operation.\n\n` +
      `Upload this already-generated real local PNG using chatgpt_space.write_page_reference with file="${imagePath}", page_id=the new Page ID, title="${imageAlt}". Do not generate another image, use shell, browse, read another file, or invent any file/reference. If the host file upload is unsupported, stop honestly and retain the new Page ID in your answer; do not use data URLs, localhost paths, tangent-asset URLs or a local Markdown substitute in the hosted Page.\n\n` +
      `After file_access_confirmed:true, use read_page on the NEW Page for current blocks, hashes, stream_kind and any sequence. In one guarded edit_page non-patch batch, replace its original paragraph with "${updated}" using the observed block ID/hash, and insert the returned native image Markdown at the actual Page end using adjacent observed blocks. Use the upload's exact library-file/project-file reference. Read back the NEW Page and verify the paragraph and native image reference. Inspect every edit receipt; if a save is uncertain, reread and reconcile instead of replaying applied operations.\n\n` +
      `Then attach THAT NEW Page's exact canonical URL to THIS canvas using canvas_page action attach and the exact title. Do not trash it yet; the test runner will independently verify it and trash only this known test Page afterward. Reply briefly with the new canonical Page URL and whether the uploaded image and updated paragraph were verified.` });
    await finished;
  } finally { clearTimeout(timer); service.off('event', listener); }
  const summary = calls.map(call => ({ server: call.server, tool: call.tool, failed: Boolean(call.error) }));
  assert.deepEqual(approvalErrors, [], 'Every hosted Page approval must pass through the production CanvasService');
  assert.ok(approvals.every(a=>a.decision==='accept'), 'Only the validated test Page actions may be approved');
  t.diagnostic(`${approvals.length} native approval request(s) handled through production CanvasService; existing tool policy may allow these actions without prompting.`);
  assert.ok(createdPageId, `No new Page ID observed; calls=${JSON.stringify(summary)}`);
  const upload = calls.find(call => call.tool === 'chatgpt_space.write_page_reference' && !call.error)?.result?.structuredContent;
  assert.ok(upload?.file_access_confirmed, `Host file upload was not confirmed; calls=${JSON.stringify(summary)}`);
  assert.equal(upload.page_id, createdPageId); assert.equal(upload.sha256, imageDigest);
  assert.equal(upload.byte_size, imageBytes.length); assert.ok(/^(?:library-file|project-file):/.test(upload.reference));
  const edits = calls.filter(call => call.tool === 'chatgpt_space.edit_page' && !call.error);
  assert.ok(edits.length > 0, 'A guarded edit receipt is required');
  const reads = calls.filter(call => call.tool === 'chatgpt_space.read_page' && !call.error);
  const lastRead = reads.at(-1)?.result?.structuredContent; const readText = values(lastRead).join('\n');
  assert.ok(readText.includes(updated)); assert.ok(readText.includes(upload.reference)); assert.ok(!readText.includes(first));
  const card = board.nodes.find(card => card.kind === 'page' && card.pageUrl === createdUrl);
  assert.ok(card); assert.equal(card.title, title);
  const persisted = JSON.parse(await readFile(store.file, 'utf8')).boards[0].nodes.find(card => card.pageUrl === createdUrl);
  assert.equal(persisted.title, title);
  assert.ok(calls.filter(call => /chatgpt_space\.(?:write_page_reference|edit_page|read_page)/.test(call.tool)).every(call => call.arguments?.page_id === createdPageId));
  t.diagnostic(`Rich hosted Page workflow passed: actual ${imageBytes.length}-byte generated PNG uploaded with matching SHA256, guarded paragraph update and native image reference read back, live Page attached and persisted. ${createdUrl}`);
});
