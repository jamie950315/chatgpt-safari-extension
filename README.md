# ChatGPT for Safari — native development port

Click the **ChatGPT** toolbar button on an HTTP/HTTPS page to open the original
ChatGPT side chat inside that Safari window. Drag the divider to resize it;
close the sidebar to restore the page's space.

Open `dist/ChatGPT for Safari.app` to enable the extension in Safari Settings.
This is a local Apple Development-signed build, not an official OpenAI Safari
extension or a notarized release.

## Side chat shares the Safari window

A closed-shadow sidebar reserves page width and compensates viewport-fixed
controls. Its extension-owned wrapper contains a separate, unprivileged local
provider frame. The native HTTPS relay is adapted from Jamie's Margina project;
provider scripts never run in the extension's privileged context.

With the user's explicit authorization, the relay shares only the containing
app's own minimal secure HTTP-only ChatGPT session in memory. An official
session check must pass. It never reads Safari or Margina cookies, writes
credentials to disk, or deletes the original app-owned WebKit profile.

Safari's native tabs/scripting APIs provide the owning page, selected text, and
tab-mention candidates. An exact-parent, capability-bound MessageChannel adapts
the original website's host boundary. Account and owner changes invalidate
context. The original website still renders the conversation, composer, and
constructs its own conversation requests.

Each fresh HTML response identifies its actual module runtime. The host adapter
hooks the inspected `aH`, `ipG`, and `Kxt` factories before original entry modules run;
public module URLs must remain canonical so both use the same module instance.
The relay forwards the actual browser User-Agent, retains script CSP protection,
and narrowly adapts local framing/reporting directives. Never fake a Chrome
origin, alter browser ancestry, strip CSP, or replace conversation requests.
It uses the website's own API-base setting to route requests to `/backend-api`.
Original account/API identity headers go only to official nonstatic ChatGPT
requests, never static or CDN resources.

The relay compiles native async generators and `for await` syntax inside the
inspected stream factories using bundled Babel 7.28.5 in a separate JavaScriptCore
context. This avoids a reproduced WebKit crash while retaining the original
parser and stream logic. Unrelated factories are unchanged. The compiler only
parses provider source; it never executes it. Public module URLs and CSP remain
unchanged. Its dedicated native compilation queue uses the containing app's
JIT entitlement; extension permissions are unchanged. Original resume/turn
headers stay on official nonstatic requests.

The macOS package uses a **Manifest V2 persistent background page**, with the
real `browserAction` toolbar API. Safari's MV3 worker stopped answering
cold-start side-chat requests. Preparation retains the sandbox and original
host permissions, adding only the embedded wrapper resource and scoped local
provider frame policy.

## Direct side-chat agent control (development candidate)

In the original inline sidebar, select **Work** and describe an action on an
existing Safari tab, for example: "In this page, enter the project note and click
Apply." Approve the Browser confirmation when prompted. Supported actions are
dispatched to the real Safari backend, not Chrome or an isolated browser profile.

The original agent keeps its cloud tunnel, account scope, conversation UI,
browser-control consent, and tab leases. Supported high-level commands use
Safari's real tabs/scripting APIs and trusted native mouse/keyboard input.
The app's own ChatGPT session authenticates only the agent tunnel; page logins
remain in ordinary Safari and are never copied out. No separate MCP client or
API key is needed for this path.

The current executor supports top-level visible DOM, click, focused typing,
page keys, scrolling, existing-tab navigation/history/reload, and tab closing.
Unimplemented screenshot, Playwright, clipboard, and browser-management APIs are
disabled rather than simulated. Stale targets and uncertain input outcomes
require a fresh page read; delivered input is never automatically replayed.

Safari lacks Chrome's manifest sandbox pages. The packaged original JavaScript
worker therefore runs at a dedicated local origin with no extension APIs,
credentials, or network access. Exact-parent ports connect it to the original
security-gated host. Host-to-background browser RPC uses a real MessageChannel
bound to the nested host frame and scope, since Safari's same-background-frame
runtime messaging does not reach its own listener. This computation sandbox
does not create website tabs or another login session.

**Installed end-to-end verification of this new sidebar path is still required.**
The independent desktop control results below do not establish that acceptance.

## Optional desktop control of existing tabs

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
tab navigation do not need that permission. Each input batch activates its
verified Safari window once; keep Safari frontmost while that batch runs.

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
Automation and External Agents** before using it. The app-owned ChatGPT session
is also separate from the automation profile.

Use this separate backend for clean-session tests rather than existing logins.
The [MCP configuration reference](https://developers.openai.com/codex/mcp)
describes client configuration and connection reloads.

The original OpenAI native-host connection remains available: the desktop runtime
discovers the extension as Safari, lists real tabs, and creates agent tabs using
native Safari windows. Its legacy raw-CDP navigation path is not the control
backend; Safari does not expose `chrome.debugger`. The sidebar's high-level
adapter and `safari_live` target existing tabs; `safari_native` is for isolated tests.

## Installed acceptance

- `safari_live` listed the ordinary Safari profile's existing tabs and read an
  already signed-in Gemini page without changing its login or input. A fresh
  Codex app-server loaded its nine tools and used the installed companion for
  Unicode text entry and button clicks; the page reported trusted events.
- In fullscreen ordinary Safari, native page keys, a 500-pixel scroll, and link
  navigation passed. Navigation retained the same tab handle and session cookie;
  the old document/snapshot was then rejected before input.
- Safari → native messaging → XPC → signature-verified OpenAI host: protocol-2
  hello, desktop discovery, tab listing, and agent-tab creation passed.
- The installed embedded route passed official session validation and real
  account-settings requests. The original signed-in ChatGPT UI returned the
  exact owning-page selection even though the prompt did not contain it.
  Closing/reopening retained the login and the same conversation. Inline page
  reflow, fixed-control compensation, divider resizing, and fullscreen rendering
  passed in Safari.
- Native MCP input, click, and link navigation passed through the signed
  companion. Both input and click events were trusted browser events.
- A fresh Codex app-server client loaded 19 tools and called
  `safari_session_status` successfully. This is distinct from an already-running
  chat's cached tool catalog. The active desktop conversation subsequently loaded
  `safari_native` and completed real page reading, input, button click, and link
  navigation through those tools, then closed its test tab and stopped its session.

The background restores only the companion's matching saved owner. Closing the
sidebar releases browser context while retaining its in-memory provider session.

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
- `companion/`: embedded provider controller/relay, website host adapter,
  app-owned sign-in profile, and authenticated IPC.
- `automation/`: desktop MCP stdio entry point and configuration.
- `safari/ChatGPT for Safari/`: containing app, extension, and Xcode project.

Upstream Chrome extension: **1.26.1005.11759**.
[Chrome Web Store listing](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg).
