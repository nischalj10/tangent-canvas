import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('recovery controls share immediate pending state, surface failures and disappear while connected', { timeout: 30000 }, async t => {
  // Source-only browser test: no bundled build, native app, authentication,
  // Codex subprocess, or user profile is opened by this fixture.
  const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  await server.listen();
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const chat = { id: 'chat-recovery', kind: 'chat', title: 'Keep my conversation', position: { x: 30, y: 20 }, width: 560, height: 640, messages: [{ id: 'reply', role: 'assistant', text: 'Existing answer', turnId: 'finished' }], activities: [], draft: 'My unsent draft', queue: [{ id: 'later', text: 'A paused question', status: 'queued' }], queuePaused: true, permissionMode: 'full', inheritedCount: 0, status: 'error', error: 'The previous response was interrupted.' };
    const board = { id: 'board-recovery', title: 'Recovery fixture', projectPath: null, nodes: [chat], edges: [], viewport: { x: 30, y: 40, zoom: 1 } };
    const state = { version: 1, activeBoardId: board.id, boards: [board] };
    let connection = { connected: true, model: 'fixture', effort: 'medium', models: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['medium'] }] };
    const listeners = new Set(), calls = [];
    let resolveReconnect, rejectReconnect;
    window.recoveryFixture = {
      calls, state,
      disconnect() { connection = { ...connection, connected: false, error: 'Codex connection closed' }; for (const listener of listeners) listener({ type: 'connection', connection }); },
      finish(value) { connection = { ...connection, ...value }; if (value.connected) delete connection.error; resolveReconnect(structuredClone(connection)); },
      fail() { rejectReconnect(new Error("Error invoking remote method 'tangent:invoke': Error: Native connection could not reopen.")); },
    };
    window.tangent = {
      invoke(command, payload = {}) {
        calls.push({ command, payload });
        if (command === 'app/state') return Promise.resolve(structuredClone(state));
        if (command === 'app/connection') return Promise.resolve(structuredClone(connection));
        if (command === 'app/reconnect') return new Promise((resolve, reject) => { resolveReconnect = resolve; rejectReconnect = reject; });
        if (command === 'node/update') Object.assign(chat, payload);
        return Promise.resolve();
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      onAction() { return () => {}; },
    };
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
  const card = page.getByTestId('card-chat-recovery'), cardReconnect = page.getByTestId('reconnect-chat-recovery'), footerReconnect = page.getByTestId('reconnect-codex');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('composer-chat-recovery')).toHaveValue('My unsent draft');
  await page.getByTestId('connection-settings').click();
  await expect(page.getByTestId('connection-healthy')).toHaveText('Connected');
  await expect(cardReconnect).toHaveCount(0); await expect(footerReconnect).toHaveCount(0);
  await page.evaluate(() => window.recoveryFixture.disconnect());
  await expect(cardReconnect).toBeEnabled(); await expect(footerReconnect).toBeEnabled();
  const clicks = async () => page.evaluate(() => {
    const card = document.querySelector('[data-testid="reconnect-chat-recovery"]');
    const footer = document.querySelector('[data-testid="reconnect-codex"]');
    // Same-task clicks also exercise the ref guard before React commits disabled.
    card.click(); footer.click(); card.click(); footer.click();
  });
  const count = () => page.evaluate(() => window.recoveryFixture.calls.filter(call => call.command === 'app/reconnect').length);
  const pending = async countValue => {
    await expect.poll(count).toBe(countValue);
    await expect(cardReconnect).toBeDisabled(); await expect(footerReconnect).toBeDisabled();
    await expect(cardReconnect).toHaveText('Connecting…'); await expect(footerReconnect).toHaveText('Connecting…');
    await expect(page.getByTestId('connection-settings')).toContainText('Connecting…');
  };
  await clicks(); await pending(1);
  await page.evaluate(() => window.recoveryFixture.finish({ connected: false, error: 'Codex connection closed' }));
  await expect(footerReconnect).toBeEnabled();
  await expect(page.locator('.connection-error')).toHaveText('Codex connection closed');
  await clicks(); await pending(2);
  await page.evaluate(() => window.recoveryFixture.fail());
  await expect(footerReconnect).toBeEnabled();
  await expect(page.locator('.connection-error')).toHaveText('Native connection could not reopen.');
  await expect(page.getByTestId('connection-popover')).not.toContainText('Error invoking remote method');
  await clicks(); await pending(3);
  await page.evaluate(() => window.recoveryFixture.finish({ connected: true }));
  await expect(page.getByTestId('connection-healthy')).toHaveText('Connected');
  await expect(cardReconnect).toHaveCount(0); await expect(footerReconnect).toHaveCount(0);
  await expect(page.getByTestId('codex-connection-status')).toContainText('connected');
  await expect(page.getByTestId('composer-chat-recovery')).toHaveValue('My unsent draft');
  assert.equal(await count(), 3);
  const saved = await page.evaluate(() => window.recoveryFixture.state.boards[0].nodes[0]);
  assert.deepEqual(saved.messages, [{ id: 'reply', role: 'assistant', text: 'Existing answer', turnId: 'finished' }]);
  assert.deepEqual(saved.queue, [{ id: 'later', text: 'A paused question', status: 'queued' }]);
  assert.deepEqual(errors, []);
});
