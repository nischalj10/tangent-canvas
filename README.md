# Tangent Canvas

An infinite canvas for Codex: conversations, branches, floating side chats, and editable ChatGPT Pages.

## Run locally

Requires **macOS**, **Node.js 22.12+**, and a Codex account. Tested on Apple Silicon with Codex CLI 0.162.1.

**1. Install Codex and sign in with your own ChatGPT account.** Skip this if your CLI is already signed in. [Official setup](https://learn.chatgpt.com/docs/codex/cli) · [Authentication](https://learn.chatgpt.com/docs/auth)

```sh
npm install -g @openai/codex
codex login
codex login status
```

**2. Clone and run Tangent.**

```sh
git clone https://github.com/nischalj10/tangent-canvas.git
cd tangent-canvas
npm ci
npm run build
npm start
```

Tangent automatically starts a local `codex app-server` and reuses your CLI login. No API key or separate Tangent account is needed with ChatGPT sign-in. Codex does not need to be running beforehand.

If the app shows **Offline**, check `codex login status`, then open the top-right **Codex → Reconnect**. The `codex` executable must be on your `PATH` or installed in a standard Homebrew location.

## Use it

- **Chat** starts a conversation. Select a reply to ask a side question or branch from that point.
- Drag and resize cards; pinch to zoom. Open chats or Pages full screen, or keep floating chats over a Page.
- **Page** links a ChatGPT Page. Rich edits sync to the original; **Local page** stays on your Mac. Pages and image generation require those tools to be available to your Codex account.
- Choose model, effort, and permissions in each chat. Permissions default to **Full access**; change them in the composer if needed. Choose a folder from the Codex menu to work on local files.
- **⌘F** searches the current view; **⌘K** jumps to a card.

Canvas state and drafts stay in `~/Library/Application Support/Tangent Canvas`. Authentication stays with Codex.

## Develop

```sh
npm test          # Unit tests; live account tests are opt-in
npm run package  # Apple Silicon .app in release/mac-arm64/
```

Electron UI tests live in `tests/*.e2e.mjs`. Some Page scenarios require a local Page export via `TANGENT_PAGE_FIXTURE_DIR`; private exports and test recordings are not included.

Independent project; not an official OpenAI application.
