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

## Direct side-chat agent control

In **Chat**, type **@**, choose **Add browser tabs**, and attach the open Safari
tabs you want compared or summarized. Chat reads their current, signed-in page
content through the original browser-consent flow; it does not fetch a logged-out
copy of their URLs. Page context is bounded to 80,000 characters per read.

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

The executor supports visible DOM, Playwright locators, open shadow roots,
same-origin and cross-origin iframe targeting, new tabs, navigation/history,
double-clicks, pointer movement/dragging, focused Unicode typing, page-editing
keys, native option selection, and real viewport/cropped/full-page screenshots.
Full-page capture restores the original scroll position and excludes the hosting
ChatGPT sidebar. Native application/system shortcuts are not page input.
Stale targets and uncertain input outcomes require a fresh read; delivered input
is never automatically replayed.

JavaScript alerts, confirms, prompts, and file choosers use actual Safari native
dialogs. File uploads retain the original approval and require explicit existing
local files. Multiple files must share one directory. Custom `showPicker()`-only
controls without a verifiable input click are rejected. A modal retains only its
exact source selection until a response or cancellation; manual focus changes
abort rather than stealing focus back.

The original clipboard is a **session-local virtual clipboard**, not the Mac's
clipboard. Console logs are captured from the first claim, bounded to the current
turn and five minutes; earlier logs cannot be recovered. The `pageAssets`
capability inventories observed page assets and saves selected assets with a
manifest in a private Downloads subdirectory, retaining the original download
and cross-origin fallback approval checks.

Right-click **Ask ChatGPT** and website side-panel invocations can prefill the
original composer without submitting or replacing an existing draft. Open tab
mentions refresh when their real tabs change. Expired sessions have an explicit
sign-in/Continue path using only this app's existing official WebKit profile.

### Download files using the page's existing login

Ask Work to download a file linked in the current page. The original agent's
download policy and approval run before transfer. Safari fetches the file in
that page's ordinary-profile session; credentials never leave the browser.
The companion saves the completed file to **~/Downloads**, preserving existing
files with collision-safe names and applying macOS quarantine. It never opens
the file automatically. Incomplete transfers are discarded.

This route supports visible, same-origin HTTP/HTTPS file links up to **32 MiB**
within **30 seconds**. Redirects, cross-origin links, blob URLs, and JavaScript
download buttons are rejected explicitly. Normal native clicks remain available
for website interactions; they do not provide this verified-download result.

### Organize tabs into real Safari Tab Groups

Ask Work to organize explicitly selected tabs. Its `management` capability can
query, reorder, pin, close, group, ungroup, and rename native groups using real
Safari APIs and macOS Accessibility. Tabs must be claimed before changes;
unrequested tabs are retained. Keep the tab hosting the active sidebar outside
group/ungroup operations; open the sidebar in another existing tab first.

Safari groups are separate named tab collections, not Chrome's colored inline
groups. Moving a tab can remove it from the currently displayed collection.
Group handles are session-local and resolve to an observed native title/window;
duplicate names and shared or unverifiable groups cannot be changed. Chrome
group colors/collapse state are not emulated. Read the
capability's Safari-specific documentation before invoking its methods.
Safari may replace source tab IDs during creation. A batch resolves only its
already-claimed pending tabs against unique observed source identities; later
commands must query and claim their current real IDs again. A group created by
the same sidebar session can be renamed from its source collection.

Normal windows can be created empty or from an explicitly claimed, unpinned,
non-sidebar tab. Management audit records survive task changes in the same
browser session, scoped to the current ChatGPT account and Safari profile
(50 successful changes, 72 hours).

### History, bookmarks, and notifications

History search reads a profile-bound Safari database read-only, using bounded
parameterized queries. Native profile metadata must match; an unknown profile
never falls back to another profile's history. macOS may require Safari-data
access for this containing app. Permission failures remain explicit.

Bookmark tree/search/read, title/URL updates, and folder creation use Safari's
own editor in a temporary ordinary-profile window, then restore the sidebar
owner. Native row handles expire when their identity becomes stale or ambiguous.
URL creation uses the official Add Bookmark sheet for an inert local utility
page, verifies its exact destination, then replaces the temporary URL and title
in Safari's editor. It never visits the bookmarked website. The destination
folder must have a unique native name; root placement requires Safari's actual
root label to match its menu and selected destination. Missing official button
identities or an unconfirmed destination stop the operation before Add.
Deletion uses the selected native row's real context menu. Built-in collections
are protected; deleting a nonempty folder requires `removeTree`. All mutations
verify the resulting hierarchy and preservation of unrelated bookmarks. An
active native editor search must be cleared before complete-tree operations.
Bookmark movement uses a trusted native drag into an explicit visible folder,
then verifies its actual parent, appended index, entire subtree, and unchanged
unrelated hierarchy. A delivered but unconfirmed drag is never replayed.
Explicit insertion indices, root drops, and obscured/offscreen drag targets are
unsupported.

System notifications use `UNUserNotificationCenter`. Open **connection
diagnostics → App notifications → Enable notifications** to request the Mac's
permission. A successful request returns a real scheduling ID, not proof that a
banner was displayed.

### Remaining platform differences

The original read-only `evaluate`/`evaluateAll` sandbox freezes JavaScript realm
intrinsics and requires Chrome's isolated world. Safari's public AppleEvents
JavaScript command has no isolated-world option; running that sandbox in the
page's main world would damage the page. Use the supported DOM read methods.

Raw desktop CDP control, browser viewport overrides, WebMCP, Chrome group
color/collapse/reordering, Top Sites, and the recently closed session inventory
remain unavailable. Top Sites and recently closed sessions return explicit
errors rather than unrelated history data or fabricated restore handles.

Safari lacks Chrome's manifest sandbox pages. The packaged original JavaScript
worker therefore runs at a dedicated local origin with no extension APIs,
credentials, or network access. Exact-parent ports connect it to the original
security-gated host. Host-to-background browser RPC uses a real MessageChannel
bound to the nested host frame and scope, since Safari's same-background-frame
runtime messaging does not reach its own listener. This computation sandbox
does not create website tabs or another login session.

The installed original Work agent completed text entry, an Apply button click,
and a Next page link click in an ordinary Safari tab. It read back the applied
value and `Session established: true` after same-tab navigation. The inline
sidebar retained the same conversation and finished its response after remount;
no separate MCP client or isolated browser session performed those actions.

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

- In the original **Chat** mode, attaching two ordinary Safari tabs with **@**
  returned both exact session-only DOM markers. Neither marker was included in
  the prompt. The original Safari consent prompt was retained and the response
  finished normally.

- In the original **Work** sidebar, a policy-approved download used an ordinary
  Safari page's HTTP-only session and saved the exact 204-byte UTF-8 response to
  Downloads. A same-name file was preserved; the new file had mode 0600 and
  macOS quarantine. The original agent's response finished normally.

- In the original **Work** sidebar, the management capability claimed two
  scratch tabs, reversed their adjacent order, and read the real final order
  back. The original conversation finished normally and other tabs were retained.

- The original **Work** sidebar completed one two-tab batch into a real native
  Safari Tab Group and restored its source sidebar and conversation after
  Safari parked/rekeyed source tabs. A subsequent original Work run renamed
  that group to **Safari Work Complete**, read both pages with
  `Session established: true`, and finished normally. Both pages retained their
  original URLs and order. These actions used ordinary Safari, not MCP or an
  isolated browser session.

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
node --test tests/test_safari_agent_background.js tests/test_safari_agent_kernel.js tests/test_embedded_sidechat.js tests/RelayHTTP.test.js
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
