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

## Desktop control uses Safari-native tools

The `safari_native` MCP server exposes Apple's actual Safari automation tools:
read page content, type, click, navigate, handle tabs, and inspect requests.
The companion owns one persistent `safaridriver --mcp` process, shared through
an authenticated loopback channel.

**Automation uses an isolated Safari session.** Its tabs and website logins are
separate from ordinary Safari tabs. Enable Safari **Develop → Allow Remote
Automation and External Agents** before using it. The native side-chat profile
is also separate from the automation profile.

Use [the native automation guide](automation/README.md) for the launch command,
desktop configuration, and a complete read/type/click/navigation example.
The `safari_native` server is installed in this Mac's shared Codex/ChatGPT desktop
MCP configuration. Reload the server or start a new client session after changing
its configuration. [Official MCP configuration documentation](https://developers.openai.com/codex/mcp).

The original OpenAI native-host connection remains available: the desktop runtime
discovers the extension as Safari, lists real tabs, and creates agent tabs using
native Safari windows. Its legacy raw-CDP navigation path is not the control
backend; Safari does not expose `chrome.debugger`. Use `safari_native` instead.

## Installed acceptance

- Safari → native messaging → XPC → signature-verified OpenAI host: protocol-2
  hello, desktop discovery, tab listing, and agent-tab creation passed.
- Native side-chat guest and signed-in prompt/response passed. The original
  signed-in UI attached selected text from the actual owning Safari page; a
  prompt that did not contain the text received that exact text as its answer.
  Closing and reopening the native window retained the conversation and login.
- Native MCP input, click, and link navigation passed through the signed
  companion. Both input and click events were trusted browser events.
- A fresh Codex app-server client loaded 19 tools and called
  `safari_session_status` successfully. This is distinct from an already-running
  chat's cached tool catalog.

The background restores polling only for the native window's matching saved
owner after a worker reload; it does not reopen a window or restart a quit app.

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
- `scripts/prepare-safari.py`: exact upstream transformations.
- `native/`: original-host XPC transport, companion client, Safari automation.
- `companion/`: AppKit side chat, website host adapter, authenticated IPC.
- `automation/`: desktop MCP stdio entry point and configuration.
- `safari/ChatGPT for Safari/`: containing app, extension, and Xcode project.

Upstream Chrome extension: **1.26.1005.11759**.
[Chrome Web Store listing](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg).
