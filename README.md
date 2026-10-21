# Tangent Canvas

An infinite canvas for Codex: conversations, branches, floating side chats, and editable ChatGPT Pages.

## Download for Mac

[**Download Tangent Canvas 0.4.14 — Apple Silicon**](https://github.com/nischalj10/tangent-canvas/releases/download/v0.4.14/Tangent-Canvas-0.4.14-mac-arm64.dmg) · [All releases](https://github.com/nischalj10/tangent-canvas/releases)

Requires **macOS 13+** on an **Apple Silicon Mac (M1 or later)**. Open the DMG, drag **Tangent Canvas** into **Applications**, then open it. No Node.js or source build is needed to run the downloaded app.

This build is **not Apple-notarized**. If macOS blocks it, review [Apple's first-launch instructions](https://support.apple.com/en-us/102445); only if you trust this download, use **System Settings → Privacy & Security → Open Anyway** after attempting to open it.

## Connect your own Codex

Install the [official Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and sign in with your own ChatGPT account. With Homebrew:

```sh
brew install --cask codex
codex login
codex login status
```

Then open Tangent. It starts a local `codex app-server` and reuses your login; no separate Tangent account or API key is needed with ChatGPT sign-in. Already signed into Codex? You can skip login. [Official authentication documentation](https://learn.chatgpt.com/docs/auth).

If Tangent shows **Offline**, open **Codex → Reconnect**. Tangent finds Codex in standard Homebrew locations, `~/.local/bin`, its launch `PATH`, or `/Applications/Codex.app`. A custom npm/nvm installation may need a terminal launch so its `PATH` is inherited.

Canvas state and drafts stay on your Mac. The download includes no chats, credentials, or shared account.

## Run from source

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

Codex does not need to be running beforehand. Connection setup is the same as for the downloaded app.

## Use it

- **Chat** starts a conversation. Select a reply to ask a side question or branch from that point.
- Drag and resize cards; pinch to zoom. Open chats or Pages full screen, or keep floating chats over a Page.
- Ask Codex to bring a ChatGPT Page onto the canvas. Rich edits sync to the original. Pages and image generation require those tools to be available to your Codex account.
- **Note** adds a simple note to the canvas.
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
