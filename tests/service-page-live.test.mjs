import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasStore } from '../electron/store.mjs';
import { CanvasService } from '../electron/service.mjs';
import { CodexClient } from '../electron/codex.mjs';
import { DocumentMcpBridge } from '../electron/document-mcp.mjs';
import { DOCUMENT_TOOL } from '../electron/documents.mjs';
import { PAGE_TOOL } from '../electron/pages.mjs';
import { requireLivePageUrl } from '../scripts/live-page-target.mjs';

const live = process.env.TANGENT_PAGE_READ_LIVE === '1';

function resultText(result) {
  const strings = [];
  const visit = value => {
    if (typeof value === 'string') { strings.push(value); if (/^[{[]/.test(value.trim())) { try { visit(JSON.parse(value)); } catch {} } }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(result?.structuredContent);
  visit(result?.content);
  return strings.join('\n');
}

test('LIVE connected Pages read and production bridge attach original Page without hosted writes', { skip: !live, timeout: 240_000 }, async t => {
  const sourceUrl = requireLivePageUrl();
  const directory = await mkdtemp(join(tmpdir(), 'tangent-page-read-live-'));
  const store = new CanvasStore(directory); const runtime = new CodexClient({ cwd: directory });
  const service = new CanvasService(store, runtime); const cloudCalls = []; let node;
  const bridge = new DocumentMcpBridge({ tools: [DOCUMENT_TOOL, PAGE_TOOL],
    onToolCall: (contextId, name, args) => service.documentToolForContext(contextId, name, args) });
  await bridge.start(); service.documentBridge = bridge;
  t.after(async () => {
    service.closing = true;
    if (node?.threadId) { try { await runtime.request('thread/archive', { threadId: node.threadId }); } catch {} }
    await service.close(); await rm(directory, { recursive: true, force: true });
  });
  runtime.on('notification', ({ method, params }) => {
    if (method === 'item/completed' && params.item?.type === 'mcpToolCall' && params.item.server !== 'tangent_canvas') cloudCalls.push(params.item);
  });
  await service.connect(); assert.equal(service.connection.account?.type, 'chatgpt');
  const board = store.state.boards[0]; node = service.makeNode(board, 'chat', { title: 'Existing Page read verification' });
  service.nodeSettings({ boardId: board.id, nodeId: node.id, model: 'gpt-6.1-sol', effort: 'low' });
  let listener, timer;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Connected Page read/attach timed out')), 180_000);
    listener = () => {
      if (node.status === 'error') { clearTimeout(timer); reject(new Error('Native Page read turn failed.')); }
      else if (node.status === 'idle' && node.messages.some(message => message.role === 'assistant')) { clearTimeout(timer); resolve(); }
    };
    service.on('event', listener);
  });
  try {
    await service.send({ boardId: board.id, nodeId: node.id,
      text: `Read only this existing ChatGPT Page: ${sourceUrl}. Use the connected ChatGPT Pages/Spaces tools to obtain its original title and one actual image alt text. Then use canvas_page action attach to attach THAT EXACT existing canonical URL, with the original title, to THIS current canvas. Do not edit the Page, create a new cloud Page, change any external content, or run shell/filesystem tools. This is an authorized read-only integration verification plus a local canvas link. After attaching, reply with one JSON object containing pageTitle, imageAlt, and pageUrl. If the connected read is unavailable, say that honestly and do not guess title or image details.` });
    await done;
  } finally { clearTimeout(timer); service.off('event', listener); }
  const page = board.nodes.find(card => card.kind === 'page' && card.pageUrl === sourceUrl);
  const nativeSummary = cloudCalls.map(call => ({ server: call.server, tool: call.tool, status: call.status, failed: Boolean(call.error) }));
  const reply = node.messages.filter(message => message.role === 'assistant').at(-1)?.text || '';
  const denied = /auth|sign.?in|log.?in|unavailable|cannot access|could not access|permission/i.test(reply);
  assert.ok(page, `No live Page card was attached. Auth/access blocker indicated=${denied}; native tools=${JSON.stringify(nativeSummary)}`);
  const successfulReads = cloudCalls.filter(call => !call.error && /(?:read|get|fetch).*page|page.*(?:read|get|fetch)/i.test(call.tool));
  assert.ok(successfulReads.length, `No successful connected Page read was observed; native tools=${JSON.stringify(nativeSummary)}`);
  assert.ok(!cloudCalls.some(call => /(?:create|update|edit|write|delete|publish|upload|send)/i.test(call.tool)), 'No hosted mutation tool may be called by this verification');
  const rawReadText = successfulReads.map(call => resultText(call.result)).join('\n');
  const jsonMatch = reply.match(/\{[\s\S]*\}/); assert.ok(jsonMatch, 'Native reply must report the title and an actual image alt');
  const answer = JSON.parse(jsonMatch[0]);
  assert.equal(answer.pageUrl, sourceUrl); assert.equal(page.title, answer.pageTitle);
  assert.ok(typeof answer.imageAlt === 'string' && answer.imageAlt.trim().length > 0);
  assert.ok(rawReadText.includes(answer.pageTitle), 'Attached title must occur in actual connected read output');
  assert.ok(rawReadText.includes(answer.imageAlt), 'Image alt must occur in actual connected read output');
  assert.equal(node.pageTargetId, page.id);
  const persisted = JSON.parse(await readFile(store.file, 'utf8')).boards[0].nodes.find(card => card.id === page.id);
  assert.equal(persisted.pageUrl, sourceUrl); assert.equal(persisted.title, page.title);
  t.diagnostic(`Connected Page read and private app bridge succeeded; original URL and title persisted; no hosted mutation. Title: ${page.title}`);
});
