import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("composer uses native model and effort settings and protects drafts while delivery is pending", { timeout: 45_000 }, async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "tangent-composer-controls-"));
  const control = path.join(folder, "steer-control.json");
  await fs.writeFile(control, JSON.stringify({ delayMs: 650, mode: "reject" }));
  let app, page;
  const errors = [];
  const proofDirectory = path.resolve(root, "../../work/composer-controls-smoke");
  await fs.mkdir(proofDirectory, { recursive: true });
  t.after(async () => {
    if (app) {
      const timer = setTimeout(() => app.process()?.kill("SIGKILL"), 6000);
      try { await app.close(); } finally { clearTimeout(timer); }
    }
    await fs.rm(folder, { recursive: true, force: true });
  });
  app = await electron.launch({ args: [".", "--background"], cwd: root, env: {
    ...process.env, TANGENT_E2E: "1", TANGENT_ALLOW_MULTIPLE: "1",
    TANGENT_DATA_DIR: path.join(folder, "data"),
    TANGENT_TEST_CODEX_BINARY: path.join(root, "tests/fixtures/codex-appserver.mjs"),
    TANGENT_FIXTURE_STATE: path.join(folder, "peer.json"),
    TANGENT_FIXTURE_STEER_CONTROL: control,
  } });
  page = await app.firstWindow();
  page.setDefaultTimeout(7000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("canvas-surface").waitFor();
  await expect.poll(() => page.evaluate(() => window.tangent.invoke("app/connection"))).toMatchObject({ connected: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 900));
  const board = async () => {
    const state = await page.evaluate(() => window.tangent.invoke("app/state"));
    return state.boards.find((item) => item.id === state.activeBoardId);
  };
  await page.getByTestId("new-chat").click();
  let chat;
  await expect.poll(async () => { chat = (await board()).nodes.find((item) => item.kind === "chat"); return !!chat; }).toBe(true);
  const node = async () => (await board()).nodes.find((item) => item.id === chat.id);
  await page.evaluate(({ boardId, nodeId }) => window.tangent.invoke("node/update", { boardId, nodeId, width: 360, height: 580 }), { boardId: (await board()).id, nodeId: chat.id });
  const card = page.getByTestId(`card-${chat.id}`);
  const composer = card.getByTestId(`composer-${chat.id}`);
  const trigger = card.getByTestId(`node-settings-${chat.id}-trigger`);
  const popup = page.getByTestId(`node-settings-${chat.id}-popover`);
  // Let the existing new-card navigation/autofocus finish before opening a
  // nonmodal chooser, which intentionally closes when focus moves elsewhere.
  await page.waitForTimeout(350);
  await composer.focus();
  await expect(page.getByTestId(`node-model-${chat.id}`)).toHaveCount(0);
  await trigger.click();
  await expect(popup).toBeVisible();
  const range = page.getByTestId(`node-effort-${chat.id}`);
  await expect(range).toHaveAttribute("type", "range");
  await expect(range).toHaveAttribute("max", "2");
  await range.press("End");
  await expect.poll(async () => (await node()).effort).toBe("high");
  await page.getByRole("button", { name: "Reset to model default effort" }).click();
  await expect.poll(async () => (await node()).effort).toBe("low");
  await page.getByTestId(`node-model-${chat.id}`).selectOption("gpt-6-sol");
  await expect(trigger).toContainText("GPT-6 Sol");
  await expect(range).toBeEnabled();
  await range.press("End");
  await expect.poll(async () => (await node()).effort).toBe("high");
  const bounds = await popup.boundingBox();
  const anchor = await trigger.boundingBox();
  assert.ok(bounds.x >= 12 && bounds.y >= 12 && bounds.x + bounds.width <= 1280 - 12);
  assert.ok(bounds.y + bounds.height <= anchor.y, "The chooser opens above the composer");
  await page.screenshot({ path: path.join(proofDirectory, "popover.png") });
  await range.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const geometry = await card.evaluate((element) => {
    const surface = element.querySelector(".composer");
    const footer = element.querySelector(".composer-bottom");
    const input = element.querySelector("textarea");
    return { height: surface.getBoundingClientRect().height, inputHeight: input.getBoundingClientRect().height, footerWidth: footer.clientWidth, footerScroll: footer.scrollWidth, font: getComputedStyle(input).fontSize, permissionBackground: getComputedStyle(element.querySelector(".permission-chooser-trigger")).backgroundColor };
  });
  assert.ok(geometry.height <= 135 && geometry.height >= 120);
  assert.ok(geometry.inputHeight >= 76);
  assert.equal(geometry.font, "13px");
  assert.equal(geometry.permissionBackground, "rgba(0, 0, 0, 0)");
  assert.ok(geometry.footerScroll <= geometry.footerWidth + 1, "360px composers must not overflow");

  // Hold the actual IPC request before native acceptance. Clearing must happen
  // in the renderer immediately, and a successor draft must survive its reply.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get("tangent:invoke");
    globalThis.composerTestHold = { held: false, release: null };
    ipcMain.removeHandler("tangent:invoke");
    ipcMain.handle("tangent:invoke", async (...args) => {
      if (args[1] === "node/send" && !globalThis.composerTestHold.held) {
        globalThis.composerTestHold.held = true;
        await new Promise((resolve) => { globalThis.composerTestHold.release = resolve; });
      }
      return handler(...args);
    });
  });
  await composer.fill("SLOW_TEST");
  await card.getByTestId(`send-${chat.id}`).click();
  await expect.poll(() => app.evaluate(() => globalThis.composerTestHold.held)).toBe(true);
  assert.equal(await composer.inputValue(), "", "Sending clears before the held native acknowledgement");
  await composer.fill("A new draft typed while the send is pending.");
  await app.evaluate(() => globalThis.composerTestHold.release());
  await expect.poll(async () => (await node()).status).toBe("running");
  await expect(composer).toHaveValue("A new draft typed while the send is pending.");
  await expect.poll(async () => (await node()).draft).toBe("A new draft typed while the send is pending.");
  const runningGeometry = await card.locator(".composer-bottom").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(runningGeometry.scroll <= runningGeometry.width + 1, "Queue, steer, and stop fit 360px composers");
  await page.screenshot({ path: path.join(proofDirectory, "running.png") });

  const rejectSteer = async (text, successor) => {
    await composer.fill(text);
    await card.getByTestId(`steer-${chat.id}`).click();
    assert.equal(await composer.inputValue(), "", "Steering clears before the native acknowledgement");
    await expect.poll(async () => (await node()).messages.find((message) => message.text === text)?.deliveryStatus).toBe("sending");
    if (successor !== undefined) {
      await composer.fill(successor || "A successor that is then deliberately emptied.");
      if (!successor) await composer.fill("");
    }
    await expect.poll(async () => (await node()).messages.find((message) => message.text === text)?.deliveryStatus).toBe("failed");
    await expect(composer).toHaveValue(successor === undefined ? text : successor);
    await expect.poll(async () => (await node()).draft).toBe(successor === undefined ? text : successor);
  };
  await rejectSteer("Restore this rejected steering draft.");
  await rejectSteer("Do not overwrite the next draft on rejection.", "This successor belongs to the user.");
  await rejectSteer("Do not restore text after the user deliberately empties their successor.", "");
  await card.getByTestId(`stop-${chat.id}`).click();
  await expect.poll(async () => (await node()).status).toBe("interrupted");
  assert.deepEqual(errors, []);
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows()[0].isVisible(), focused: BrowserWindow.getAllWindows()[0].isFocused() })), { visible: false, focused: false });
  t.diagnostic("Native popup keyboard/default settings, 360px geometry, immediate clearing, successor preservation, and rejected steering restoration passed in a hidden isolated profile.");
});
