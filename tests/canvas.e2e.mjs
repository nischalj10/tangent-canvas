import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests/fixtures/codex-appserver.mjs");

// These tests drive the actual hidden Electron renderer, preload, service, store,
// and native RPC client. Only the Codex peer is deterministic. The production
// app never loads this peer, nor any synthetic model replies.
test(
  "hidden desktop canvas: conversations, isolated historical forks, comments, documents, and recovery",
  { timeout: 90_000 },
  async (t) => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "tangent-electron-e2e-"),
    );
    const dataDirectory = path.join(directory, "app-data");
    const peerState = path.join(directory, "codex-peer.json");
    const image = path.join(root, "assets/icon.png");
    const project = path.join(directory, "project");
    await fs.mkdir(project);
    const errors = [];
    let panProof = null;
    let application;
    let page;
    const closeApplication = async () => {
      const current = application;
      application = null;
      if (!current) return;
      let timeout;
      const forced = new Promise((resolve) => {
        timeout = setTimeout(() => {
          current.process().kill("SIGKILL");
          resolve();
        }, 6000);
      });
      await Promise.race([current.close().catch(() => {}), forced]);
      clearTimeout(timeout);
    };
    const environment = {
      ...process.env,
      TANGENT_DATA_DIR: dataDirectory,
      TANGENT_ALLOW_MULTIPLE: "1",
      TANGENT_E2E: "1",
      TANGENT_TEST_CODEX_BINARY: fixture,
      TANGENT_FIXTURE_STATE: peerState,
      TANGENT_TEST_IMAGE: image,
    };
    const launch = async () => {
      application = await electron.launch({
        args: [".", "--background"],
        cwd: root,
        env: environment,
      });
      page = await application.firstWindow();
      page.setDefaultTimeout(8000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.getByTestId("canvas-surface").waitFor();
      t.diagnostic(`Renderer at ${new Date().toISOString()}: ${await page.locator('script[type="module"]').getAttribute('src')}`);
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.tangent.invoke("app/connection")))
              .connected,
        )
        .toBe(true);
      assert.equal(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
        false,
        "Test window must stay hidden",
      );
    };
    const state = () => page.evaluate(() => window.tangent.invoke("app/state"));
    const activeBoard = async () => {
      const value = await state();
      return value.boards.find((board) => board.id === value.activeBoardId);
    };
    const card = async (nodeId) =>
      (await activeBoard()).nodes.find((node) => node.id === nodeId);
    const waitForIdle = async (nodeId) => {
      await expect
        .poll(async () => (await card(nodeId))?.status, { timeout: 15_000 })
        .toBe("idle");
    };
    const navigate = async (nodeId) => {
      const node = await card(nodeId);
      await page
        .locator(".outline-list > button")
        .filter({ hasText: node.title })
        .first()
        .click();
      await page.waitForTimeout(420);
    };
    const send = async (nodeId, text) => {
      await navigate(nodeId);
      await page.getByTestId(`composer-${nodeId}`).fill(text);
      await page.getByTestId(`send-${nodeId}`).click();
    };
    const create = async (kind) => {
      const before = (await activeBoard()).nodes.map((node) => node.id);
      await page.getByTestId(`new-${kind}`).click();
      let node;
      await expect
        .poll(async () => {
          node = (await activeBoard()).nodes.find(
            (node) => !before.includes(node.id),
          );
          return node?.kind;
        })
        .toBe(kind === "chat" ? "chat" : kind);
      await page.getByTestId(`card-${node.id}`).waitFor();
      await page.waitForTimeout(450);
      return node;
    };
    t.after(async () => {
      if (page && !page.isClosed()) {
        try {
          await page.screenshot({ path: path.resolve(root, "../../work/canvas-e2e-last-state.png") });
          if (panProof) await fs.writeFile(path.resolve(root, "../../work/canvas-pan-proof.json"), JSON.stringify(panProof, null, 2) + "\n");
        } catch {}
      }
      await closeApplication();
      await fs.rm(directory, { recursive: true, force: true });
    });

    await launch();
    await expect(
      page.getByText("Keep the thread.", { exact: false }),
    ).toBeVisible();
    await page.getByTestId("connection-settings").click();
    const effortOptions = await page
      .getByTestId("effort-select")
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value));
    assert.deepEqual(effortOptions, ["low", "medium", "high"]);
    await page.getByTestId("effort-select").selectOption("high");
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.tangent.invoke("app/connection")))
            .effort,
      )
      .toBe("high");
    await page
      .getByRole("button", { name: "Close connection settings" })
      .click();
    const firstBoard = (await activeBoard()).id;
    const main = await create("chat");
    await send(
      main.id,
      "Remember main_marker=MARBLE-83. Reply exactly: Main marker MARBLE-83.",
    );
    await waitForIdle(main.id);
    const firstReply = (await card(main.id)).messages.find(
      (message) => message.role === "assistant",
    );
    assert.equal(firstReply.text, "Main marker MARBLE-83.");
    await send(
      main.id,
      "Set main_marker=ORBIT-29. Reply exactly: Main marker ORBIT-29.",
    );
    await waitForIdle(main.id);
    assert.equal(
      (await card(main.id)).messages.at(-1).text,
      "Main marker ORBIT-29.",
    );
    await page.getByTestId(`collapse-${main.id}`).click();
    await expect.poll(async () => (await card(main.id)).collapsed).toBe(true);
    await expect(page.getByTestId(`composer-${main.id}`)).toHaveCount(0);
    await page.getByTestId(`collapse-${main.id}`).click();
    await expect.poll(async () => (await card(main.id)).collapsed).toBe(false);
    await page.getByTestId(`branch-${firstReply.id}`).scrollIntoViewIfNeeded();
    await page.getByTestId(`branch-${firstReply.id}`).click();
    let fork;
    await expect
      .poll(async () => {
        fork = (await activeBoard()).nodes.find(
          (node) => node.parentId === main.id && node.kind === "chat",
        );
        return !!fork?.threadId;
      })
      .toBe(true);
    assert.equal(fork.inheritedCount, 2);
    assert.match(JSON.stringify(fork.messages), /MARBLE-83/);
    assert.doesNotMatch(JSON.stringify(fork.messages), /ORBIT-29/);
    await expect(page.getByTestId(`inherited-${fork.id}`)).toBeVisible();
    await send(fork.id, "TEST_CONTEXT. Remember side_marker=BRONZE-61.");
    await waitForIdle(fork.id);
    assert.match((await card(fork.id)).messages.at(-1).text, /MARBLE-83/);
    assert.match((await card(fork.id)).messages.at(-1).text, /BRONZE-61/);
    assert.doesNotMatch((await card(fork.id)).messages.at(-1).text, /ORBIT-29/);
    await send(main.id, "TEST_CONTEXT");
    await waitForIdle(main.id);
    assert.match((await card(main.id)).messages.at(-1).text, /ORBIT-29/);
    assert.doesNotMatch(
      (await card(main.id)).messages.at(-1).text,
      /BRONZE-61/,
    );
    t.diagnostic(
      "Historical fork includes only the selected turn; branch marker never reaches the main thread.",
    );

    // Select an actual passage in the rendered reply, then use the canvas toolbar.
    await page
      .getByTestId(`card-${main.id}`)
      .getByTestId(`message-${firstReply.id}`)
      .scrollIntoViewIfNeeded();
    await page
      .getByTestId(`card-${main.id}`)
      .getByTestId(`message-${firstReply.id}`)
      .locator(".message-text")
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    await page.getByTestId("selection-comment").click();
    await page
      .getByTestId("comment-question")
      .fill("Why this marker? Reply exactly: The quoted comment was answered.");
    await page.getByTestId("submit-comment").click();
    let comment;
    await expect
      .poll(async () => {
        comment = (await activeBoard()).nodes.find(
          (node) => node.parentId === main.id && node.kind === "comment",
        );
        return comment?.status;
      })
      .toBe("idle");
    assert.equal(comment.quote, firstReply.text);
    assert.equal(
      comment.messages.at(-1).text,
      "The quoted comment was answered.",
    );
    assert.equal(
      comment.messages.filter((message) => message.role === "user").length,
      2,
    );
    assert.doesNotMatch(
      JSON.stringify((await card(main.id)).messages),
      /quoted comment/,
    );
    t.diagnostic(
      "A selected passage becomes an automatically answered comment on the same canvas.",
    );

    const note = await create("note");
    await page
      .getByTestId(`note-${note.id}`)
      .fill("A note that stays outside agent context.");
    await expect
      .poll(async () => (await card(note.id)).noteText)
      .toBe("A note that stays outside agent context.");
    await page.getByTestId(`title-${note.id}`).fill("Persistent note");
    await page.getByTestId(`title-${note.id}`).press("Enter");
    await expect
      .poll(async () => (await card(note.id)).title)
      .toBe("Persistent note");
    const originalPosition = (await card(note.id)).position;
    const header = page.getByTestId(`card-${note.id}`).locator(".card-header");
    const rect = await header.boundingBox();
    await page.mouse.move(rect.x + 8, rect.y + 8);
    await page.mouse.down();
    await page.mouse.move(rect.x + 78, rect.y + 58, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await card(note.id)).position.x)
      .not.toBe(originalPosition.x);
    await page
      .getByTestId(`card-${note.id}`)
      .click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(100);
    const sizeBefore = (await card(note.id)).width;
    const resize = page.getByTestId(`resize-se-${note.id}`);
    const resizeRect = await resize.boundingBox();
    assert.ok(resizeRect, "Selected note exposes its resize handle");
    await page.mouse.move(
      resizeRect.x + resizeRect.width / 2,
      resizeRect.y + resizeRect.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(resizeRect.x + 105, resizeRect.y + 65, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => (await card(note.id)).width)
      .toBeGreaterThan(sizeBefore);
    await page
      .getByTestId(`card-${note.id}`)
      .getByRole("button", { name: "Archive note" })
      .click();
    await expect.poll(async () => (await card(note.id)).archived).toBe(true);
    await page
      .locator(".toast")
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect.poll(async () => (await card(note.id)).archived).toBe(false);
    const panBefore = (await activeBoard()).viewport;
    panProof = await page.evaluate(() => {
      const canvas = document.querySelector(".canvas-surface").getBoundingClientRect();
      const pane = document.querySelector(".react-flow__pane");
      const header = document.querySelector(".workspace-topbar").getBoundingClientRect();
      const dock = document.querySelector(".canvas-dock")?.getBoundingClientRect();
      const left = Math.max(0, canvas.left) + 20, right = Math.min(innerWidth, canvas.right) - 20;
      const top = Math.max(canvas.top, header.bottom) + 24, bottom = Math.min(innerHeight, canvas.bottom, dock?.top ?? innerHeight) - 24;
      const describe = element => ({ tag: element?.tagName, className: typeof element?.className === "string" ? element.className : element?.className?.baseVal, testid: element?.closest("[data-testid]")?.dataset.testid, card: element?.closest('[data-testid^="card-"]')?.dataset.testid });
      const oldPoint = { x: canvas.left + 30, y: canvas.top + 140 };
      const candidates = [];
      let point = null;
      for (const y of [top, (top + bottom) / 2, bottom]) for (const x of [left, (left + right) / 2, right]) {
        const target = document.elementFromPoint(x, y);
        candidates.push({ x, y, pane: target === pane, target: describe(target) });
        if (!point && target === pane) point = { x, y };
      }
      window.__canvasWheel = [];
      window.addEventListener("wheel", event => window.__canvasWheel.push({ trusted: event.isTrusted, x: event.clientX, y: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY, pane: event.target === pane, target: describe(event.target) }), { capture: true, once: true });
      return { oldPoint: { ...oldPoint, target: describe(document.elementFromPoint(oldPoint.x, oldPoint.y)) }, point, candidates };
    });
    assert.ok(panProof.point, "The visible canvas exposes an actual empty React Flow pane among the nine bounded hit-test candidates");
    await page.mouse.move(panProof.point.x, panProof.point.y);
    await page.mouse.wheel(150, 100);
    await page.waitForFunction(() => window.__canvasWheel.length === 1);
    panProof.events = await page.evaluate(() => window.__canvasWheel);
    assert.ok(panProof.events[0].trusted && panProof.events[0].pane, "The actual trusted wheel must hit empty canvas, not a scrollable card or toolbar");
    panProof.before = panBefore;
    await fs.writeFile(path.resolve(root, "../../work/canvas-pan-proof.json"), JSON.stringify(panProof, null, 2) + "\n");
    await expect
      .poll(async () => JSON.stringify((await activeBoard()).viewport))
      .not.toBe(JSON.stringify(panBefore));
    panProof.after = (await activeBoard()).viewport;
    assert.equal(panProof.after.zoom, panBefore.zoom, "Ordinary wheel input pans without changing canvas zoom");
    const zoomBefore = (await activeBoard()).viewport.zoom;
    await page.getByTestId("zoom-in").click();
    await expect
      .poll(async () => (await activeBoard()).viewport.zoom)
      .toBeGreaterThan(zoomBefore);
    await page.getByTestId("toggle-minimap").click();
    await expect(page.locator(".react-flow__minimap")).toBeVisible();

    // A native image-generation item and a native document tool call create a real
    // canvas document. Its image is copied into protected managed storage.
    await send(main.id, "DOCUMENT_TEST");
    await waitForIdle(main.id);
    let document;
    await expect
      .poll(async () => {
        document = (await activeBoard()).nodes.find(
          (node) => node.kind === "document",
        );
        return !!document;
      })
      .toBe(true);
    assert.match(
      document.documentMarkdown,
      /tangent-asset:\/\/[a-f0-9]{64}\.png/,
    );
    await navigate(document.id);
    const renderedImage = page
      .getByTestId(`document-preview-${document.id}`)
      .locator("img");
    await expect(renderedImage).toBeVisible();
    await expect
      .poll(() =>
        renderedImage.evaluate(
          (image) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.getByTestId(`document-edit-tab-${document.id}`).click();
    const editor = page.getByTestId(`document-editor-${document.id}`);
    const editedText =
      document.documentMarkdown + "\n\nA user edit, safely persisted.";
    await editor.fill(editedText);
    await expect
      .poll(async () => (await card(document.id)).documentMarkdown)
      .toBe(editedText);
    assert.ok(
      (await card(document.id)).documentRevision > document.documentRevision,
    );
    await page.getByTestId(`document-preview-tab-${document.id}`).click();
    await expect(
      page.getByTestId(`document-preview-${document.id}`),
    ).toContainText("A user edit, safely persisted.");
    await expect(renderedImage).toBeVisible();

    await fs.mkdir(path.join(root, "screenshots"), { recursive: true });
    await page.screenshot({
      path: path.join(root, "screenshots", "local-page-inline-image.png"),
    });
    await page.getByTestId(`ask-document-${document.id}`).click();
    await page
      .getByTestId("comment-question")
      .fill("Reply exactly: The document comment was answered.");
    await page.getByTestId("submit-comment").click();
    let documentComment;
    await expect
      .poll(async () => {
        documentComment = (await activeBoard()).nodes.find(
          (node) => node.parentId === document.id,
        );
        return documentComment?.status;
      })
      .toBe("idle");
    const humanQuote = page
      .getByTestId(`card-${documentComment.id}`)
      .locator(".anchor-quote");
    await expect(humanQuote).toContainText("[Image: Canvas illustration]");
    await expect(humanQuote).not.toContainText("tangent-asset://");
    await expect(humanQuote).not.toContainText("# An illustrated document");
    assert.match(
      documentComment.quote,
      /tangent-asset:\/\//,
      "The full raw quote remains available to the agent",
    );
    const sourceDocument = await card(document.id);
    await page.evaluate(
      ({ boardId, nodeId, position }) =>
        window.tangent.invoke("node/update", { boardId, nodeId, position }),
      {
        boardId: firstBoard,
        nodeId: documentComment.id,
        position: {
          x: sourceDocument.position.x - 575,
          y: sourceDocument.position.y,
        },
      },
    );
    await page.getByTestId("fit-canvas").click();
    await page.waitForTimeout(450);
    const reversedEdge = (await activeBoard()).edges.find(
      (edge) =>
        edge.source === document.id && edge.target === documentComment.id,
    );
    const connector = page.locator(
      `.react-flow__edge[data-id="${reversedEdge.id}"] .react-flow__edge-path`,
    );
    const connectorBounds = await connector.evaluate((path) => {
      const box = path.getBBox();
      return { x: box.x, width: box.width };
    });
    assert.ok(
      connectorBounds.x >= sourceDocument.position.x - 117,
      "Reverse edge starts at the facing target side",
    );
    assert.ok(
      connectorBounds.x + connectorBounds.width <=
        sourceDocument.position.x + 2,
      "Reverse edge does not loop around either card",
    );
    await navigate(documentComment.id);
    await page.screenshot({
      path: path.resolve(root, "../../work/tangent-electron-quote-proof.png"),
    });
    await navigate(document.id);

    // External agent edits cannot overwrite a dirty user editor. This invokes the
    // same service revision guard an agent tool uses, while the user editor stays.
    await page.getByTestId(`document-edit-tab-${document.id}`).click();
    await editor.fill("# A local unsaved revision");
    const currentDocument = await card(document.id);
    await page.evaluate(
      ({ boardId, nodeId, revision }) =>
        window.tangent.invoke("document/save", {
          boardId,
          nodeId,
          markdown: "# An agent revision",
          expectedRevision: revision,
        }),
      {
        boardId: firstBoard,
        nodeId: document.id,
        revision: currentDocument.documentRevision,
      },
    );
    await expect(
      page.getByTestId(`document-conflict-${document.id}`),
    ).toBeVisible();
    await expect(editor).toHaveValue("# A local unsaved revision");
    await page.waitForTimeout(600);
    assert.equal(
      (await card(document.id)).documentMarkdown,
      "# An agent revision",
    );
    await page.getByText("Keep draft as new document", { exact: true }).click();
    await expect
      .poll(async () =>
        (await activeBoard()).nodes.some(
          (node) =>
            node.kind === "document" &&
            node.documentMarkdown === "# A local unsaved revision",
        ),
      )
      .toBe(true);
    t.diagnostic(
      "Real managed image renders, document revisions persist, and concurrent edits preserve the user draft.",
    );

    await send(main.id, "APPROVAL_MCP_TEST");
    await expect(page.getByTestId("approval-card")).toContainText(
      "chatgpt_space.create_page",
    );
    await expect(page.getByTestId("approval-card")).toContainText(
      "A deterministic private test Page",
    );
    await expect(page.getByTestId("approval-card")).not.toContainText(
      "fixture-secret-must-be-redacted",
    );
    await page.getByTestId("approval-accept").click();
    await waitForIdle(main.id);
    assert.equal(
      (await card(main.id)).messages.at(-1).text,
      "Connected tool permission accepted.",
    );
    await send(main.id, "APPROVAL_TEST");
    await expect(page.getByTestId("approval-card")).toBeVisible();
    await page.getByTestId("approval-accept").click();
    await waitForIdle(main.id);
    assert.equal(
      (await card(main.id)).messages.at(-1).text,
      "Permission accepted.",
    );
    await send(main.id, "QUESTION_TEST");
    await expect(page.getByTestId("agent-question")).toBeVisible();
    await page
      .getByTestId("agent-question")
      .locator("select")
      .selectOption("Explore");
    await page.getByRole("button", { name: "Send answer" }).click();
    await waitForIdle(main.id);
    assert.equal(
      (await card(main.id)).messages.at(-1).text,
      "Your answer was received.",
    );
    await send(main.id, "SLOW_TEST");
    await expect(page.getByTestId(`stop-${main.id}`)).toBeVisible();
    await page.getByTestId(`stop-${main.id}`).click();
    await expect
      .poll(async () => (await card(main.id)).status)
      .toBe("interrupted");
    await send(main.id, "THROW_TEST");
    await expect.poll(async () => (await card(main.id)).status).toBe("error");
    await expect(
      page.getByTestId(`card-${main.id}`).locator(".error-box"),
    ).toContainText("Simulated connection failure");
    await expect(page.getByTestId(`card-${main.id}`)).toContainText(
      "THROW_TEST",
    );

    const directComment = await create("comment");
    await send(
      directComment.id,
      "Reply exactly: A direct canvas comment was answered.",
    );
    await waitForIdle(directComment.id);
    assert.equal(
      (await card(directComment.id)).messages.at(-1).text,
      "A direct canvas comment was answered.",
    );
    await navigate(note.id);
    await page.getByTestId(`ask-note-${note.id}`).click();
    await page
      .getByTestId("comment-question")
      .fill("Reply exactly: The note question was answered.");
    await page.getByTestId("submit-comment").click();
    let noteComment;
    await expect
      .poll(async () => {
        noteComment = (await activeBoard()).nodes.find(
          (node) => node.parentId === note.id,
        );
        return noteComment?.status;
      })
      .toBe("idle");
    assert.equal(noteComment.inheritedCount, 0);
    assert.equal(noteComment.quote, "A note that stays outside agent context.");
    assert.equal(
      noteComment.messages.at(-1).text,
      "The note question was answered.",
    );
    t.diagnostic(
      "Collapse/expand, resize, archive undo, actual effort options, direct comments and note questions passed.",
    );
    // Model and reasoning choices belong to each chat, not the canvas.
    const queuedChat = await create("chat");
    await page.getByTestId(`node-settings-${queuedChat.id}-trigger`).click();
    await page
      .getByTestId(`node-model-${queuedChat.id}`)
      .selectOption("gpt-6-sol");
    await expect(page.getByTestId(`node-effort-${queuedChat.id}`)).toBeEnabled();
    await page.getByTestId(`node-effort-${queuedChat.id}`).press("Home");
    await expect
      .poll(async () => (await card(queuedChat.id)).model)
      .toBe("gpt-6-sol");
    await expect
      .poll(async () => (await card(queuedChat.id)).effort)
      .toBe("low");
    await page.getByTestId(`node-effort-${queuedChat.id}`).press("Escape");
    await navigate(main.id);
    await page.getByTestId(`node-settings-${main.id}-trigger`).click();
    await expect(page.getByTestId(`node-model-${main.id}`)).toHaveValue("gpt-6.1-sol");
    await expect(page.getByTestId(`node-effort-${main.id}`)).toHaveAttribute("aria-valuetext", "High");
    await page.getByTestId(`node-effort-${main.id}`).press("Escape");
    await send(queuedChat.id, "SLOW_TEST");
    await expect
      .poll(async () => !!(await card(queuedChat.id)).activeTurnId)
      .toBe(true);
    const activeQueueTurn = (await card(queuedChat.id)).activeTurnId;
    // Delay only the test peer's acknowledgement, after the real queue accepts
    // the message, to verify new typing survives an older submit continuation.
    await application.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get("tangent:invoke");
      globalThis.tangentOriginalTestHandler = handler;
      ipcMain.removeHandler("tangent:invoke");
      ipcMain.handle("tangent:invoke", async (...args) => {
        const result = await handler(...args);
        if (args[1] === "node/queue")
          await new Promise((resolve) => setTimeout(resolve, 350));
        return result;
      });
    });
    await page
      .getByTestId(`composer-${queuedChat.id}`)
      .fill("Reply exactly: Queued A.");
    await page.getByTestId(`queue-${queuedChat.id}`).click();
    assert.equal(await page.getByTestId(`composer-${queuedChat.id}`).inputValue(), "", "Queue acceptance clears the composer before the delayed IPC acknowledgement");
    await page
      .getByTestId(`composer-${queuedChat.id}`)
      .fill("Reply exactly: Queued B.");
    await expect(page.getByTestId(`queue-${queuedChat.id}`)).toBeEnabled();
    await expect(page.getByTestId(`composer-${queuedChat.id}`)).toHaveValue(
      "Reply exactly: Queued B.",
    );
    await application.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("tangent:invoke");
      ipcMain.handle("tangent:invoke", globalThis.tangentOriginalTestHandler);
      delete globalThis.tangentOriginalTestHandler;
    });
    const enqueue = async (text) => {
      await page.getByTestId(`composer-${queuedChat.id}`).fill(text);
      await page.getByTestId(`queue-${queuedChat.id}`).click();
      await expect(page.getByTestId(`composer-${queuedChat.id}`)).toHaveValue(
        "",
      );
    };
    await page.getByTestId(`queue-pause-${queuedChat.id}`).click();
    await enqueue("Reply exactly: Queued B.");
    await enqueue("Reply exactly: Remove me.");
    let waiting = (await card(queuedChat.id)).queue;
    const [entryA, entryB, entryC] = waiting;
    await page.getByTestId(`queue-edit-${entryB.id}`).click();
    await page
      .getByTestId(`queue-edit-text-${entryB.id}`)
      .fill("Reply exactly: Queued B edited.");
    await page.getByTestId(`queue-save-${entryB.id}`).click();
    await page.getByTestId(`queue-up-${entryB.id}`).click();
    await expect
      .poll(async () => (await card(queuedChat.id)).queue[0].id)
      .toBe(entryB.id);
    await page.getByTestId(`queue-remove-${entryC.id}`).click();
    await expect
      .poll(async () => (await card(queuedChat.id)).queue.length)
      .toBe(2);
    await page
      .getByTestId(`composer-${queuedChat.id}`)
      .fill("Reply exactly: Steered active turn.");
    await fs.mkdir(path.join(root, "screenshots"), { recursive: true });
    await expect(page.getByTestId(`queue-${queuedChat.id}`)).toBeEnabled();
    await page.waitForTimeout(60);
    await page.screenshot({
      path: path.join(root, "screenshots", "queue-composer.png"),
    });
    await page.getByTestId(`steer-${queuedChat.id}`).click();
    await waitForIdle(queuedChat.id);
    const steered = (await card(queuedChat.id)).messages.find(
      (message) => message.delivery === "steer",
    );
    assert.equal(steered.turnId, activeQueueTurn);
    assert.equal(steered.deliveryStatus, "accepted");
    assert.equal(
      (await card(queuedChat.id)).messages.at(-1).text,
      "Steered active turn.",
    );
    assert.equal((await card(queuedChat.id)).queue.length, 2);
    await page.getByTestId(`queue-resume-${queuedChat.id}`).click();
    await expect
      .poll(async () => (await card(queuedChat.id)).queue.length)
      .toBe(0);
    await waitForIdle(queuedChat.id);
    assert.deepEqual(
      (await card(queuedChat.id)).messages
        .filter((message) => message.role === "assistant")
        .slice(-2)
        .map((message) => message.text),
      ["Queued B edited.", "Queued A."],
    );
    assert.equal(
      JSON.parse(await fs.readFile(peerState, "utf8"))[
        (await card(queuedChat.id)).threadId
      ].turns.length,
      3,
      "Steering must not create another turn",
    );
    await send(queuedChat.id, "SLOW_TEST");
    const sendNowTurn = (await card(queuedChat.id)).activeTurnId;
    await enqueue("Reply exactly: Sent from queue now.");
    const sendNowEntry = (await card(queuedChat.id)).queue[0];
    await page.getByTestId(`queue-pause-${queuedChat.id}`).click();
    await page.getByTestId(`queue-now-${sendNowEntry.id}`).click();
    await waitForIdle(queuedChat.id);
    assert.equal(
      (await card(queuedChat.id)).messages.at(-1).text,
      "Sent from queue now.",
    );
    assert.equal(
      (await card(queuedChat.id)).messages
        .filter((message) => message.delivery === "steer")
        .at(-1).turnId,
      sendNowTurn,
    );
    await send(queuedChat.id, "THROW_TEST");
    await expect
      .poll(async () => (await card(queuedChat.id)).status)
      .toBe("error");
    await expect(page.getByTestId(`composer-${queuedChat.id}`)).toHaveValue(
      "THROW_TEST",
    );
    await expect
      .poll(async () => (await card(queuedChat.id)).draft)
      .toBe("THROW_TEST");
    await expect(
      page.getByTestId(`composer-error-${queuedChat.id}`),
    ).toContainText("Simulated connection failure");
    t.diagnostic(
      "Per-chat model/effort remain independent; queue edit, reorder, remove, pause/resume, drain, send-now, same-turn steer, and retained failed drafts passed.",
    );

    const sourceBefore = JSON.parse(await fs.readFile(peerState, "utf8"))[
      "external-source"
    ];
    await page.getByTestId("open-import").click();
    await page.getByTestId("import-search").fill("existing Codex");
    await page.getByTestId("import-thread-external-source").click();
    let imported;
    await expect
      .poll(async () => {
        imported = (await activeBoard()).nodes.find(
          (node) => node.importedFrom === "external-source",
        );
        return imported?.status;
      })
      .toBe("idle");
    assert.notEqual(imported.threadId, "external-source");
    assert.match(JSON.stringify(imported.messages), /EXTERNAL-42/);
    const sourceAfter = JSON.parse(await fs.readFile(peerState, "utf8"))[
      "external-source"
    ];
    assert.deepEqual(sourceAfter, sourceBefore);
    t.diagnostic(
      "Approval, agent input, stop, visible failure, and import-as-copy all passed.",
    );

    // Native directory chooser is deterministic only in this test process.
    await application.evaluate(({ dialog }, project) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [project],
      });
    }, project);
    await page.getByTestId("connection-settings").click();
    await page.getByTestId("choose-project").click();
    await expect
      .poll(async () => (await activeBoard()).projectPath)
      .toBe(project);
    await page.getByTestId("connection-settings").click();
    const originalCanvasName = (await activeBoard()).title;
    await page.getByTestId(`board-${firstBoard}`).dblclick();
    await page.getByTestId(`canvas-name-${firstBoard}`).fill("Cancel this rename");
    await page.getByTestId(`canvas-name-${firstBoard}`).press("Escape");
    await expect(page.getByTestId(`canvas-name-${firstBoard}`)).toHaveCount(0);
    assert.equal((await activeBoard()).title, originalCanvasName);
    await page.getByTestId(`board-${firstBoard}`).dblclick();
    await page.getByTestId(`canvas-name-${firstBoard}`).fill("Persistent canvas");
    await page.getByTestId(`canvas-name-${firstBoard}`).press("Enter");
    await page.getByTestId("new-board").click();
    await expect.poll(async () => (await state()).boards.length).toBe(2);
    await page.getByTestId(`board-${firstBoard}`).click();
    await expect(page.getByTestId(`board-${firstBoard}`)).toContainText(
      "Persistent canvas",
    );
    // Test-only HTTPS handler belongs to this isolated Page session. The real
    // native WebContentsView is exercised; production navigation is untouched.
    const hostedUrl = "https://chatgpt.com/space/page_E2ECanvas123456";
    await application.evaluate(async ({ session }) => {
      const profile = session.fromPartition("persist:tangent-chatgpt-pages");
      globalThis.tangentHostedFixtureRequests = [];
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="460" height="180"><rect width="460" height="180" rx="12" fill="#f9f9f9"/><path d="M40 140 L130 100 L220 125 L310 55 L420 35" fill="none" stroke="#0d0d0d" stroke-width="3"/><text x="30" y="32" font-family="system-ui" font-size="15" fill="#5d5d5d">Hosted image fixture</text></svg>',
      ).toString("base64");
      const frame = Buffer.from(
        `<button id="increment" onclick="document.querySelector('output').textContent=String(Number(document.querySelector('output').textContent)+1)">Increment value</button><output>0</output>`,
      ).toString("base64");
      await profile.protocol.handle("https", (request) => {
        if (new URL(request.url).pathname.startsWith("/space/page_"))
          globalThis.tangentHostedFixtureRequests.push(request.url);
        return new Response(
          `<!doctype html><html><head><title>Native Page fixture</title><style>body{font:14px/1.625 system-ui;background:#fcfcfc;color:#0d0d0d;margin:22px}h1{font-size:28px;line-height:1.2;margin:0 0 12px}p{margin:0 0 12px}img{width:100%;max-width:380px;max-height:145px;object-fit:contain}textarea,[contenteditable]{display:block;padding:9px;border:1px solid #ddd;border-radius:8px;min-height:45px;margin:10px 0;background:#fff}label{color:#5d5d5d}button{padding:8px 12px;border-radius:10px;background:#0d0d0d;color:white;border:0}</style></head><body><h1>A hosted Page, inside the canvas</h1><p>Deterministic native-editor test fixture. The renderer, images, and controls below belong to the isolated hosted surface.</p><img alt="Native hosted image" src="data:image/svg+xml;base64,${svg}"/><div contenteditable="true" data-testid="hosted-editor">Edit this original native document.</div><label>Comment<textarea data-testid="hosted-comment" placeholder="A comment in the hosted editor"></textarea></label><details open><summary>Interactive visualization</summary><label>Value <input type="range" data-testid="hosted-slider" min="0" max="100" value="40" oninput="document.querySelector('output').textContent=this.value"/><output>40</output></label></details><iframe title="Hosted interactive illustration" src="data:text/html;base64,${frame}" style="width:100%;height:90px;border:1px solid #dfdfdf;border-radius:8px;margin-top:15px"></iframe></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      });
    });
    await page.getByTestId("new-page").click();
    await page
      .getByTestId("page-link-url")
      .fill("https://example.com/not-a-page");
    await expect(page.getByTestId("page-link-submit")).toBeDisabled();
    await page.getByTestId("page-link-url").fill(hostedUrl);
    await page
      .getByTestId("page-link-title")
      .fill("Native hosted Page fixture");
    await page.getByTestId("page-link-submit").click();
    let hosted;
    await expect
      .poll(async () => {
        hosted = (await activeBoard()).nodes.find(
          (node) => node.kind === "page",
        );
        return !!hosted;
      })
      .toBe(true);
    await navigate(hosted.id);
    await page.getByTestId(`page-title-menu-${hosted.id}`).click();
    await page.getByTestId(`page-browser-${hosted.id}`).click();
    await page.getByTestId(`page-open-${hosted.id}`).click();
    await expect(page.locator(".app-shell")).not.toHaveClass(/is-page-focused/);
    await expect(page.locator(".page-reader-shell:not([hidden])")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.tangent.invoke("page/status")))
            ?.deferred,
      )
      .toBe(true);
    assert.equal(
      application
        .context()
        .pages()
        .some((candidate) => candidate.url() === hostedUrl),
      false,
      "A fully hidden app defers native Page creation",
    );
    t.diagnostic(
      "Hidden Page open is deferred without creating a native child.",
    );
    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setOpacity(0);
      window.setHasShadow(false);
      window.setIgnoreMouseEvents(true);
      window.showInactive();
    });
    await expect
      .poll(
        async () => {
          const status = await page.evaluate(() =>
            window.tangent.invoke("page/status"),
          );
          return status?.deferred === false && status.loading === false;
        },
        { timeout: 10000 },
      )
      .toBe(true);
    let nativePage;
    await expect
      .poll(() => {
        nativePage = application
          .context()
          .pages()
          .find((candidate) => candidate.url() === hostedUrl);
        return !!nativePage;
      })
      .toBe(true);
    nativePage.setDefaultTimeout(8000);
    const nativeGeometry = () =>
      application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const container = window.contentView.children.find((view) =>
          view.children?.some((child) =>
            child.webContents?.getURL().includes("page_E2ECanvas123456"),
          ),
        );
        const child = container?.children.find((child) => child.webContents);
        return container
          ? {
              visible: container.getVisible(),
              bounds: container.getBounds(),
              pageBounds: child.getBounds(),
              zoom: child.webContents.getZoomFactor(),
            }
          : null;
      });
    await expect(
      nativePage.getByRole("heading", {
        name: "A hosted Page, inside the canvas",
      }),
    ).toHaveText("A hosted Page, inside the canvas");
    const nodesBeforeReload = (await activeBoard()).nodes.map(
      (node) => node.id,
    );
    const requestsBeforeReload = await application.evaluate(
      () => globalThis.tangentHostedFixtureRequests.length,
    );
    await nativePage.evaluate(() => {
      history.replaceState({}, "", "/auth/login");
      document.body.innerHTML =
        '<h1>Connecting…</h1><input type="email" disabled><button disabled>Continue with Google</button>';
    });
    await expect(nativePage.getByRole("heading")).toHaveText("Connecting…");
    await page.getByTestId(`page-reload-${hosted.id}`).click();
    await expect(nativePage.getByRole("heading")).toHaveText(
      "A hosted Page, inside the canvas",
    );
    await expect.poll(() => nativePage.url()).toBe(hostedUrl);
    await expect
      .poll(() =>
        application.evaluate(
          () => globalThis.tangentHostedFixtureRequests.length,
        ),
      )
      .toBe(requestsBeforeReload + 1);
    assert.equal(
      await application.evaluate(() =>
        globalThis.tangentHostedFixtureRequests.at(-1),
      ),
      hostedUrl,
    );
    assert.deepEqual(
      (await activeBoard()).nodes.map((node) => node.id),
      nodesBeforeReload,
      "Reload keeps the original Page card and creates no conversations",
    );
    assert.equal((await card(hosted.id)).pageUrl, hostedUrl);
    await page.getByTestId("find-card").click();
    await expect.poll(async () => (await nativeGeometry()).visible).toBe(false);
    await page.evaluate(
      ({ boardId, nodeId }) =>
        window.tangent.invoke("page/reload", { boardId, nodeId }),
      { boardId: firstBoard, nodeId: hosted.id },
    );
    await expect(nativePage.getByRole("heading")).toHaveText(
      "A hosted Page, inside the canvas",
    );
    await expect
      .poll(() =>
        application.evaluate(
          () => globalThis.tangentHostedFixtureRequests.length,
        ),
      )
      .toBe(requestsBeforeReload + 2);
    await page.waitForTimeout(100);
    assert.equal(
      (await nativeGeometry()).visible,
      false,
      "Reload cannot reveal a native Page behind a canvas modal",
    );
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await nativeGeometry()).visible).toBe(true);
    t.diagnostic(
      "Reload recovers a stuck hosted login back to the same original Page and keeps native views hidden behind overlays.",
    );
    await nativePage
      .getByTestId("hosted-editor")
      .fill("Edited in the actual native child renderer.", { force: true });
    await expect(nativePage.getByTestId("hosted-editor")).toHaveText(
      "Edited in the actual native child renderer.",
    );
    await nativePage
      .getByTestId("hosted-comment")
      .fill("A comment in the hosted editor.", { force: true });
    await expect(nativePage.getByTestId("hosted-comment")).toHaveValue(
      "A comment in the hosted editor.",
    );
    await nativePage.getByTestId("hosted-slider").press("End");
    for (let step = 0; step < 27; step++)
      await nativePage.getByTestId("hosted-slider").press("ArrowLeft");
    await expect(nativePage.locator("output")).toHaveText("73");
    const visualization = nativePage.frameLocator(
      'iframe[title="Hosted interactive illustration"]',
    );
    await visualization
      .getByRole("button", { name: "Increment value" })
      .click({ force: true });
    await expect(visualization.locator("output")).toHaveText("1");
    await expect
      .poll(() =>
        nativePage
          .locator("img")
          .evaluate((image) => image.complete && image.naturalWidth === 460),
      )
      .toBe(true);
    assert.equal(
      await nativePage.evaluate(() => typeof window.tangent),
      "undefined",
      "Hosted Page cannot access the local preload bridge",
    );
    const bodyRect = await page
      .getByTestId(`page-body-${hosted.id}`)
      .boundingBox();
    const geometry = await nativeGeometry();
    assert.ok(
      Math.abs(geometry.pageBounds.width - Math.round(bodyRect.width)) <= 1,
      "Native child retains full card width while container clips",
    );
    assert.ok(
      geometry.bounds.x >= 236 && geometry.bounds.y >= 69,
      "Native Page cannot cover sidebar or topbar",
    );
    await expect(page.getByTestId(`page-body-${hosted.id}`)).toHaveAttribute(
      "data-native-visible",
      "true",
    );
    await page.getByTestId("find-card").click();
    await expect(page.getByTestId(`page-body-${hosted.id}`)).toHaveAttribute(
      "data-native-visible",
      "false",
    );
    await expect.poll(async () => (await nativeGeometry()).visible).toBe(false);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`page-body-${hosted.id}`)).toHaveAttribute(
      "data-native-visible",
      "true",
    );
    await expect.poll(async () => (await nativeGeometry()).visible).toBe(true);
    await page.getByTestId("connection-settings").click();
    await expect(page.getByTestId(`page-body-${hosted.id}`)).toHaveAttribute(
      "data-native-visible",
      "false",
    );
    await page
      .getByRole("button", { name: "Close connection settings" })
      .click();
    await expect(page.getByTestId(`page-body-${hosted.id}`)).toHaveAttribute(
      "data-native-visible",
      "true",
    );
    await page.getByTestId("zoom-out").click();
    await expect
      .poll(async () =>
        Math.abs(
          (await nativeGeometry()).zoom - (await activeBoard()).viewport.zoom,
        ),
      )
      .toBeLessThan(0.01);
    assert.deepEqual(
      await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { focused: window.isFocused(), opacity: window.getOpacity() };
      }),
      { focused: false, opacity: 0 },
      "Native checks must never expose or focus the test window",
    );
    await nativePage.waitForTimeout(120);
    await application.evaluate(
      async ({ BrowserWindow }, output) => {
        const window = BrowserWindow.getAllWindows()[0];
        const container = window.contentView.children.find((view) =>
          view.children?.some((child) =>
            child.webContents?.getURL().includes("page_E2ECanvas123456"),
          ),
        );
        const child = container.children.find((child) => child.webContents);
        const bounds = child.getBounds();
        const pixels = await child.webContents.capturePage(
          { x: 0, y: 0, width: bounds.width, height: bounds.height },
          { stayHidden: true, stayAwake: true },
        );
        process.getBuiltinModule("fs").writeFileSync(output, pixels.toPNG());
      },
      path.join(root, "screenshots", "hosted-page-full-app.png"),
    );
    await page.screenshot({
      path: path.join(root, "screenshots", "hosted-page-canvas-host.png"),
    });
    await page.getByTestId(`ask-page-${hosted.id}`).click();
    await expect(page.getByTestId(`page-body-${hosted.id}`)).toHaveAttribute(
      "data-native-visible",
      "false",
    );
    await page
      .getByTestId("comment-question")
      .fill("Reply exactly: The hosted Page question was answered.");
    await page.getByTestId("submit-comment").click();
    let hostedComment;
    await expect
      .poll(async () => {
        hostedComment = (await activeBoard()).nodes.find(
          (node) => node.parentId === hosted.id,
        );
        return hostedComment?.status;
      })
      .toBe("idle");
    assert.equal(hostedComment.pageTargetId, hosted.id);
    const hostedPeer = JSON.parse(await fs.readFile(peerState, "utf8"))[
      hostedComment.threadId
    ];
    assert.match(
      JSON.stringify(hostedPeer.turns[0].items[0].content),
      /https:\/\/chatgpt.com\/space\/page_E2ECanvas123456/,
    );
    assert.equal(
      hostedComment.messages.at(-1).text,
      "The hosted Page question was answered.",
    );
    t.diagnostic(
      "Hidden Page deferral, original native editor/image/iframe controls, URL-linked questions, native clipping/zoom and modal hiding passed without foreground focus.",
    );
    await navigate(document.id);
    await page.getByTestId(`document-preview-tab-${document.id}`).click();
    const proofDirectory = path.resolve(root, "../../work");
    await fs.mkdir(proofDirectory, { recursive: true });
    await page.screenshot({
      path: path.join(proofDirectory, "tangent-electron-e2e.png"),
    });
    await fs.mkdir(path.join(root, "screenshots"), { recursive: true });
    await page.screenshot({
      path: path.join(root, "screenshots", "canvas-e2e-neutral.png"),
    });
    await expect
      .poll(async () => (await state()).persistence.saving)
      .toBe(false);
    const beforeRelaunch = await state();
    await closeApplication();
    await launch();
    const restored = await state();
    assert.equal(restored.activeBoardId, firstBoard);
    assert.equal(restored.boards.length, beforeRelaunch.boards.length);
    const restoredBoard = restored.boards.find(
      (board) => board.id === firstBoard,
    );
    assert.equal(restoredBoard.title, "Persistent canvas");
    assert.equal(
      restoredBoard.nodes.find((node) => node.id === queuedChat.id).model,
      "gpt-6-sol",
    );
    assert.equal(
      restoredBoard.nodes.find((node) => node.id === queuedChat.id).effort,
      "low",
    );
    assert.equal(restoredBoard.projectPath, project);
    assert.equal(
      restoredBoard.nodes.find((node) => node.id === note.id).noteText,
      "A note that stays outside agent context.",
    );
    assert.equal(
      restoredBoard.nodes.find((node) => node.id === document.id)
        .documentMarkdown,
      "# An agent revision",
    );
    assert.equal(
      restoredBoard.edges.length,
      beforeRelaunch.boards.find((board) => board.id === firstBoard).edges
        .length,
    );
    assert.deepEqual(errors, [], "Renderer must not report runtime errors");
    t.diagnostic(
      "Boards, project choice, node layout, notes, documents, edges, and history survive a real app relaunch.",
    );
  },
);
