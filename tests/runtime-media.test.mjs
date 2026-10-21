import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CodexClient } from '../electron/codex.mjs';

const live = process.env.TANGENT_MEDIA_TEST === '1';

test('LIVE native image generation and dynamic document tool use existing subscription', { skip: !live, timeout: 600_000 }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tangent-media-'));
  const client = new CodexClient({ cwd: folder }); let thread;
  const documents = []; const images = [];
  const proofPath = resolve(process.env.TANGENT_IMAGE_PROOF || 'work/tangent-native-image-proof.png');
  t.after(async () => {
    if (thread) { try { await client.request('thread/archive', { threadId: thread.id }); } catch {} }
    await client.close(); await rm(folder, { recursive: true, force: true });
  });
  const connection = await client.start();
  assert.equal(connection.account?.type, 'chatgpt');
  const capabilities = await client.request('modelProvider/capabilities/read', {});
  assert.equal(capabilities.imageGeneration, true);
  const tool = { type: 'function', name: 'create_canvas_document',
    description: 'Create a native document on the current canvas. Markdown may contain inline generated image links.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } },
      required: ['title', 'markdown'], additionalProperties: false } };
  thread = await client.newThread({ model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only', dynamicTools: [tool] });
  client.on('serverRequest', request => {
    if (request.method === 'item/tool/call' && request.params.tool === tool.name) {
      documents.push(request.params.arguments);
      client.respond(request.id, { success: true, contentItems: [{ type: 'inputText',
        text: JSON.stringify({ id: 'verification-document', saved: true, title: request.params.arguments.title }) }] });
    } else client.reject(request.id, 'Only the native document verification tool is available in this test.');
  });
  const finished = new Promise((resolveTurn, rejectTurn) => {
    const timeout = setTimeout(() => rejectTurn(new Error('Native image turn timed out')), 540_000);
    client.on('notification', ({ method, params }) => {
      if (params.threadId !== thread.id) return;
      if (method === 'item/completed' && params.item?.type === 'imageGeneration') images.push(params.item);
      if (method === 'turn/completed') {
        clearTimeout(timeout);
        if (params.turn.status === 'failed') rejectTurn(new Error(params.turn.error?.message || 'Native image turn failed'));
        else resolveTurn(params.turn);
      }
    });
  });
  await client.sendTurn(thread.id,
    'This is a native canvas app integration verification. First create one very simple small square illustration using your BUILT-IN image generation tool: a single violet circle centered on a warm off-white background, with no text. Do not use shell, Python, SVG or an API-key fallback. After the real generated image exists, call create_canvas_document to create a short document titled Canvas media verification containing one sentence and the generated image inline in Markdown using its saved image path. Do not claim to create a document without calling that tool. Then reply with one brief sentence.',
    { model: 'gpt-6.1-sol', effort: 'low', sandbox: 'read-only' });
  await finished;
  assert.ok(images.length > 0, 'Codex must emit a real native imageGeneration item');
  const image = images.find(item => item.result || item.savedPath);
  assert.ok(image, `Native image generation must succeed; statuses: ${images.map(i => i.status).join(',')}`);
  const bytes = image.result ? Buffer.from(image.result, 'base64') : await readFile(image.savedPath);
  assert.ok(bytes.length > 1000);
  assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
  await writeFile(proofPath, bytes, { mode: 0o600 });
  assert.equal(documents.length, 1); assert.match(documents[0].markdown, /!\[[^\]]*\]\([^)]+\)/);
  t.diagnostic(`Native imageGeneration succeeded (${bytes.length} bytes, savedPath=${Boolean(image.savedPath)}); app-owned document tool called successfully. Proof: ${proofPath}`);
});
