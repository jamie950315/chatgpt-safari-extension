# ChatGPT for Safari — native development port

Click the **ChatGPT** toolbar button on an HTTP/HTTPS page to open native side
chat beside Safari. Sign in once in that window. Its persistent WebKit profile
is separate from ordinary Safari, so Safari cookies and existing tabs stay intact.

Open `dist/ChatGPT for Safari.app` to enable the extension in Safari Settings.
This is a local Apple Development-signed build, not an official OpenAI Safari
extension or a notarized release.

## Side chat uses the original ChatGPT interface

The containing app hosts the original
`https://chatgpt.com/?surface=browser_side_chat` as a top-level WKWebView in an
AppKit sidecar window. It does not embed a blocked ChatGPT iframe or remove CSP.

Safari's native tabs/scripting APIs provide the owning page, selected text, and
tab-mention candidates. The original website's Chrome-only host boundary is
replaced with a native connection that implements its context, submission,
account, and invalidation contract. The website still constructs its own
conversation requests.

This adapter is bound to the inspected website deployment: runtime
`633146.1f9c264032.js`, host factories `aH` and `Kxt`. A changed or already
executed factory is reported as an adapter failure. Do not substitute a fake
Chrome origin, alter `window.parent`, or silently fall back to an ordinary
website launcher.

The macOS package uses Safari's supported **Manifest V2 persistent background
page**, with the real `browserAction` toolbar API. The original Manifest V3
service worker stopped answering cold-start side-chat requests. A persistent
background fixes that lifecycle rather than requiring the user to reload chat.
The preparation script preserves the original CSP literals, sandbox pages,
resource inventory, and host-permission set in the version conversion.

## Control existing Safari tabs and logins

Use **`safari_live`** for the tabs already open in ordinary Safari. It lists the
real tabs in each connected profile and reads their current pages without
copying cookies or creating a separate login session.

1. Call `live_list_tabs` and choose the returned tab handle.
2. Call `live_read_page` for that handle.
3. Pass its `documentId`, `snapshotId`, and node IDs to `live_interact` to type,
   click, press a page key, or scroll. The tab is selected before input.

The extension uses Safari's tabs/scripting APIs for targeting and reading.
The signed containing app delivers trusted macOS mouse/keyboard events using
Accessibility and CGEvent. Enable **ChatGPT for Safari** in **System Settings →
Privacy & Security → Accessibility** for input. Reading, listing, and explicit
tab navigation do not need that permission. Keep Safari frontmost during input.

Page/document identity, window, viewport, hit target, and keyboard focus are
checked before delivery. A stale snapshot, covered target, or focus change
returns an error; input is never replayed automatically. Read the current page
after an uncertain result. Current snapshots describe the top-level document;
embedded frames are identified separately.

See [the desktop control guide](automation/README.md) for tool examples and
configuration. `safari_live` is registered alongside the existing `safari_native`
server in this Mac's desktop configuration. A client with a cached tool catalog
needs to reload MCP connections or start a new conversation.

## Optional isolated automation

The `safari_native` MCP server exposes Apple's actual Safari automation tools:
read page content, type, click, navigate, handle tabs, and inspect requests.
The companion owns one persistent `safaridriver --mcp` process, shared through
an authenticated loopback channel.

**Automation uses an isolated Safari session.** Its tabs and website logins are
separate from ordinary Safari tabs. Enable Safari **Develop → Allow Remote
Automation and External Agents** before using it. The native side-chat profile
is also separate from the automation profile.

Use this separate backend for clean-session tests rather than existing logins.
The [MCP configuration reference](https://developers.openai.com/codex/mcp)
describes client configuration and connection reloads.

The original OpenAI native-host connection remains available: the desktop runtime
discovers the extension as Safari, lists real tabs, and creates agent tabs using
native Safari windows. Its legacy raw-CDP navigation path is not the control
backend; Safari does not expose `chrome.debugger`. Use `safari_live` for existing
tabs, or `safari_native` for isolated tests.

## Installed acceptance

- `safari_live` listed the ordinary Safari profile's existing tabs and read an
  already signed-in Gemini page without changing its login or input. Its
  document/snapshot guard rejected stale input before native delivery. A fresh
  Codex app-server loaded its nine tools and called `live_status`. Native
  mouse/keyboard acceptance still requires the macOS Accessibility grant.
- Safari → native messaging → XPC → signature-verified OpenAI host: protocol-2
  hello, desktop discovery, tab listing, and agent-tab creation passed.
- Native side-chat guest and signed-in prompt/response passed. The original
  signed-in UI attached selected text from the actual owning Safari page; a
  prompt that did not contain the text received that exact text as its answer.
  Closing and reopening the native window retained the conversation and login.
  The installed persistent-background build also passed a cold launch and a
  selected-text conversation without using Reload.
- Native MCP input, click, and link navigation passed through the signed
  companion. Both input and click events were trusted browser events.
- A fresh Codex app-server client loaded 19 tools and called
  `safari_session_status` successfully. This is distinct from an already-running
  chat's cached tool catalog. The active desktop conversation subsequently loaded
  `safari_native` and completed real page reading, input, button click, and link
  navigation through those tools, then closed its test tab and stopped its session.

The background restores polling only for the native window's matching saved
owner after a background reload; it does not reopen a window or restart a quit app.

## Build and focused checks

```sh
./scripts/build-safari.sh
python3 -m unittest discover -s tests -p 'test_prepare*.py'
node --test tests/test_native_transport.js tests/test_safari_sidebar.js tests/test_session_windows.js tests/test_companion_background.js tests/sidechat_companion_bridge.js
```

Requirements: full Xcode, macOS, and the local Apple Development identity for
team `N3JN8G9YWK`. The build creates Universal arm64/x86_64 binaries, verifies
signatures, and retains the previous app under `dist/previous-*`.

The containing app is not sandboxed so it can own the Apple driver and private
local IPC service; the Safari extension remains sandboxed. IPC binds only to
127.0.0.1 and requires a random token stored in a mode-0600 descriptor. The XPC
client and OpenAI host retain their code-signature checks. No credentials,
cookies, native message contents, or authorization tokens belong in logs or Git.

## Source layout

- `chatgpt.crx` and `unpacked/`: ignored, unmodified original download.
- `vendor/`: preserved upstream inputs for version-bound preparation.
- `vendor/manifest.safari-input.json`: the preserved MV3 Safari resource manifest;
  preparation derives the persistent macOS manifest from it.
- `scripts/prepare-safari.py`: exact upstream transformations.
- `native/`: original-host XPC transport, companion client, Safari automation.
- `companion/`: AppKit side chat, website host adapter, authenticated IPC.
- `automation/`: desktop MCP stdio entry point and configuration.
- `safari/ChatGPT for Safari/`: containing app, extension, and Xcode project.

Upstream Chrome extension: **1.26.1005.11759**.
[Chrome Web Store listing](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg).
