# ChatGPT for Safari — native development port

Click the **ChatGPT** toolbar button on an HTTP/HTTPS page to open the original
ChatGPT side chat inside that Safari window. Drag the divider to resize it;
close the sidebar to restore the page's space.

Open `dist/ChatGPT for Safari.app` to enable the extension in Safari Settings.
This is a local Apple Development-signed build, not an official OpenAI Safari
extension or a notarized release.

## Download the development preview

Download `ChatGPT-for-Safari-v0.1.0-macOS-universal.zip` from the
[v0.1.0 release](https://github.com/jamie950315/chatgpt-safari-extension/releases/tag/v0.1.0).
The repository and release are private; sign in with an account that has access.
The app requires **macOS 14 or later** and supports Apple Silicon and Intel Macs.

Extract the ZIP, open **ChatGPT for Safari.app**, and enable its extension in
Safari Settings. Allow access to the websites you want to use. Work's mouse and
keyboard controls also require Accessibility permission for the containing app.
macOS may require manual approval because this development-signed app is not
notarized.

Keep only one active copy of the extension. On this development Mac, retain the
canonical `dist/ChatGPT for Safari.app` rather than opening the downloaded copy
alongside it. See the [release notes](RELEASE_NOTES.md) for accepted functionality
and remaining limitations.

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
cold-start side-chat requests. Preparation retains the sandbox and original host permissions. It adds the
embedded wrapper resource, scoped local provider frame policy, and `webRequest`
permission for on-demand, exact-request download-header observation.

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

### Implemented control routes

The source adapter covers visible DOM, Playwright locators, open shadow roots,
same-origin and cross-origin iframe targeting, new tabs, navigation/history,
double-clicks, pointer movement/dragging, focused Unicode typing, page-editing
keys, native option selection, and real viewport/cropped/full-page screenshots.
Full-page capture restores the original scroll position and excludes the hosting
ChatGPT sidebar. Native application/system shortcuts are not page input.
Stale targets and uncertain input outcomes require a fresh read; delivered input
is never automatically replayed.

The clipboard API retains **session-local multi-MIME items**. Native copy, cut,
and paste use a transient Mac pasteboard bridge for plain text, HTML, RTF, PNG,
TIFF, JPEG, and PDF. The prior pasteboard is held only in memory and restored
after an exact trusted page-event receipt, while its observed generation is
still owned. Newer observed changes are preserved; public pasteboard APIs do not
provide cross-process atomic writer identity. Unsupported types fail explicitly.
If `live_status.clipboard.pending` is true, do not repeat the shortcut or restart
the containing app: its memory-only recovery must finish first.

Console capture starts at
the first claim or navigation, retains up to 500 messages, and ends with the turn
or after five minutes; earlier logs cannot be recovered. The `pageAssets`
capability inventories observed page assets and saves selected assets with a
manifest in a private Downloads subdirectory, retaining the original download
and cross-origin fallback approval checks.

Right-click **Ask ChatGPT** attaches the selected text to the original
conversation; it does not insert that text into the composer. Website prompt
invocations can prefill the original composer. Neither path submits
automatically or replaces an existing draft. Open tab mentions refresh when
their real tabs change. Expired sessions have an explicit sign-in/Continue path
using only this app's existing official WebKit profile.

Installed original Work bookmark read/search, updates, folder and URL creation,
and native movement passed with exact readback and sidebar restoration. Native
deletion retains source/guard coverage; destructive GUI acceptance was not run.
The updated website prompt prefill lifecycle still needs installed acceptance.
Native dialogs, two-file upload, and clean
provider-document reload have passed installed checks. Completed checks are listed
under [Installed acceptance](#installed-acceptance).

### Complete known native dialogs and uploads in one operation

Safari suspends extension callbacks while a native modal is open. For a control
with a known JavaScript dialog, register its exact response before the opening
click through the original tab's `nativeDialogs` capability:

```js
const dialogs = await tab.capabilities.get("nativeDialogs");
await dialogs.run({
  selector: "#confirm-action", type: "confirm",
  message: "Apply changes?", accept: true
});
```

The actual window, source origin, dialog type, and full message must match.
Alerts require `accept: true`; `promptText` is allowed only when accepting a
prompt. A mismatch or manual focus change leaves the modal unanswered, without
replaying its click. Manual dismissal may be needed before chat receives the
error. The default and maximum timeout are **10 seconds**. Cross-origin iframe
modals are unsupported.

For uploads, approve explicit local files before the native opening click:

```js
const uploads = await tab.capabilities.get("nativeUploads");
await uploads.run({
  selector: "input[type=file]", files: ["/absolute/path/report.txt"]
});
```

The selector must identify one visible, enabled file input in the top-level or
same-origin document. Hidden inputs and JavaScript-only upload buttons are
unsupported. Files must be regular files; multiple files require the input's
actual `multiple` attribute and one directory. The original upload approval runs
before clicking, followed by document/input and local file-identity rechecks.
The native app selects the approved files and verifies panel closure within the
same **10-second** maximum. Read the page afterwards to verify its result.

The ordinary click/`getJsDialog()` and `waitForEvent("filechooser")` contracts
remain available, but an unarmed modal can stall their extension round trip.
Never repeat an opening click that was already delivered.

### Set an exact CSS viewport by resizing the real window

The `viewport` capability measures `window.innerWidth` and `innerHeight` in the
current turn's claimed, logical-active tab. That tab must share the owning
sidebar's native Safari window. `set({width, height})` resizes that real window,
including its other tabs, and succeeds only after exact CSS dimensions are read
back. It makes at most three measured native adjustments. Fullscreen, minimized
windows, Safari minimum sizes, browser UI, and available screen space can prevent
a requested size. It does not emulate a device, force DPR, or change page zoom.

`reset()` restores the original native bounds and checks the original CSS
viewport. Turn, owner, and account teardown also request restoration. A return
to the sidebar owner authorizes rollback only after the exact terminal owner
page, native window, and last applied bounds are verified. Restoration never
switches tabs, reclaims focus, or overwrites a user's later move/resize. An
unconfirmed restoration remains visible in `live_status.viewport`; do not replay
an uncertain resize. Reset before navigating or changing native tab collections.

### Download files using the page's existing login

Ask Work to download a file linked in the current page. The original agent's
download policy and approval run before transfer. Safari fetches the file in
that page's ordinary-profile session; credentials never leave the browser.
The companion saves the completed file to **~/Downloads**, preserving existing
files with collision-safe names and applying macOS quarantine. It never opens
the file automatically. Incomplete transfers are discarded.

This route supports visible HTTP/HTTPS file links up to **32 MiB** within
**30 seconds**. Cross-origin links require Safari's actual credentialed CORS
access as well as the original download approval. Redirects are rejected before
following an unapproved destination. Blob links and arbitrary JavaScript buttons
are outside this direct-link route; supported buttons use the capability below.

For a page button that synchronously clicks a connected `a[download]`, use the
original tab's `nativeDownloads` capability. It performs the one native click;
do not click the control separately:

```js
const downloads = await tab.capabilities.get("nativeDownloads");
const saved = await downloads.run({ selector: "#download-report" });
```

The exact anchor's default action is cancelled before the original download
approval and transfer. A successful result contains the real completed file's
`state`, `path`, `bytesWritten` and `mime`. Detached anchors, location assignments,
forms, later-task downloads, and blob/data links are unsupported by this route.

For same-origin HTTP redirects, opt in with
`redirects: "same-origin-policy"`. Each request stays manual: Safari's native
request/header events bind a non-secret correlation header to its actual request
and document IDs. The next full URL must pass the original policy before its
request is sent. At most five requests are allowed; cycles and cross-origin hops
stop before the next destination is contacted. The final response is consumed
once by the existing writer, within the **32 MiB / 30-second active-transfer**
bound.

For redirects to another origin, use `redirects: "cross-origin-policy"` instead.
Each full URL still requires the original policy and approval before its request.
Safari applies the destination's own cookies; the adapter never copies Cookie or
Authorization headers between hosts. Cross-origin responses must allow the
source page's exact origin, credentials, and the non-secret correlation header
through CORS, including any preflight. Safari's cookie policies still apply.
Without that access, the operation fails without a saved path or a transport
retry; the approved server may already have received the request. The final body
is read once, with the same five-GET-hop, size, active-transfer, and cancellation
bounds. Approval time while no request is active is excluded from that budget.

#### Capture detached anchors and callback-based delayed exports

For a known export button whose handler prepares a download URL before calling
`a[download].click()`, opt in to causal capture:

```js
const downloads = await tab.capabilities.get("nativeDownloads");
const saved = await downloads.run({
  selector: "#download-report", capture: "causal", wait_ms: 15000
});
```

This still performs only one native source click. It tracks that dispatch and
its instrumented explicit `Promise.then/catch/finally`, `setTimeout`, and
`queueMicrotask` callbacks, including detached anchors and Blob URLs created
within that chain. A retained Blob survives immediate URL revocation; its bytes
are read only after the original website-origin download approval. The source
control's handlers run, but additional click listeners on the programmatic
anchor do not run in this mode.

Preparation defaults to **10 seconds**, with a **15-second** maximum, separately
from the **30-second** active-transfer budget. Capture waits for the tracked
callback tree to finish and rejects multiple candidate anchors. Completion,
cancellation, expiry, or navigation removes its hooks; cancellation retires only
the operation's tagged pending callbacks and timers. After an uncertain click,
inspect the page rather than clicking again.

Native `async/await`, pre-cached uninstrumented functions, worker, interval, or
event-listener continuations, and pre-existing Blob URLs cannot be attributed
to this operation. They can produce an ordinary Safari download, but Work never
adopts that file or reports it as complete. Location assignments, forms, data
URLs, cross-origin frame controls, and a generic native
`waitForEvent("download")` remain unsupported. Without `capture: "causal"`, the
default connected-anchor route retains its existing limitations.

#### Use an existing destination tab when CORS is unavailable

If an already-open destination-origin HTML tab is available, claim it through
the original browser-consent flow and use `redirects: "tab-origin-policy"` with
its real tab ID in `transportTabs`. Supply **1–4** already-claimed tabs in the
same Safari profile, one per destination origin, excluding the source tab.
This redirect option can also be combined with `capture: "causal"`.

Each full URL still passes the original policy and approval before its request.
Safari fetches in that URL's own origin document with that destination's own
login; native request/document proof binds the transport separately from the
source click. Both leases remain required through native writer completion.
The same five-GET, **32 MiB / 30-second** limits and single final-body read apply.

A missing or ambiguous destination document, navigation, released claim, or
cancellation stops the operation. This route never creates or navigates carrier
tabs, copies credentials, or retries a CORS failure. Arbitrary no-CORS origins
without an existing authorized document remain unsupported.

#### Export Google Workspace files and YouTube captions

`Tab.content.exportGsuite(format)` derives the official export URL from the
current Google Workspace page: documents support pdf/md/docx, spreadsheets
pdf/xlsx/csv, and presentations pdf/pptx. It uses the page's existing login and
the same **32 MiB / 30-second** bounded writer. `exportYouTubeTranscript()` saves
the current official YouTube watch video's available captions as UTF-8 text;
its fixed player helper restores the previous captions state. Both retain the
original download approval and return a path only after real file writing.
Missing captions or an invalid document response fail explicitly.

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
never falls back to another profile's history. On this Mac, Full Disk Access is
enabled for this checkout's `dist/ChatGPT for Safari.app`; the installed original
Work agent successfully searched an exact owned URL and returned its real visit
timestamp. On another installation, the user may need to enable **System Settings
→ Privacy & Security → Full Disk Access** for the containing app. This grant is
broader than Safari metadata; Downloads-folder and Accessibility permissions do
not replace it. Permission failures remain explicit.

Bookmark tree/search/read, title/URL updates, and folder creation use Safari's
own editor in a temporary ordinary-profile window, then restore the sidebar
owner. Native row handles expire when their identity becomes stale or ambiguous.
URL creation uses the official Add Bookmark sheet for an inert local utility
page, verifies its exact destination, then replaces the temporary URL and title
in Safari's editor. It never visits the bookmarked website. The destination
folder must have a unique native name; root placement requires Safari's actual
root label to match its menu and selected destination. Missing official button
identities or an unconfirmed destination stop the operation before Add.
One original SDK `create` awaits two internal native stages: the one-shot Add
transaction and exact editor finalization. Each stage is bounded to 20 seconds
and uses a separate 25-second native HTTP request; the original operation has a
45-second overall bound and a five-second continuation handoff. Its memory-only,
one-use receipt binds the original owner/account/profile/session/turn, operation,
utility window and native editor. Finalization never selects or refocuses a
window. Safari can temporarily unload this disposable utility's API tab while
its native editor is visible. The same native lease restores the exact
capability page; the extension verifies its sole fresh real tab before returning
to the original sidebar. This never aliases a user tab or transfers its claims.
New siblings, foreign navigation and user focus changes abort the lease.
Cancellation, a changed owner/focus/document, expiry, or an app/background
restart stops continuation without replaying Add or deleting data. A partial
creation remains identifiable as `ChatGPT Safari Pending <operation UUID>`;
inspect that existing entry before explicitly finishing it or creating anything
else. Receipts and native hierarchy snapshots are not persisted.
Deletion uses the selected native row's real context menu. Built-in collections
are protected; deleting a nonempty folder requires `removeTree`. All mutations
verify the resulting hierarchy and preservation of unrelated bookmarks. An
active native editor search must be cleared before complete-tree operations.
Bookmark movement uses a trusted native drag into an explicit visible folder,
then verifies its actual parent, appended index, entire subtree, and unchanged
unrelated hierarchy. A delivered but unconfirmed drag is never replayed.
Offscreen rows are first revealed through their actual normalized native
scrollbar. The same owned drag can reveal its destination without replaying
mouse-down; every event still uses visible, native-hit-tested row/outline
coordinates. Explicit insertion indices, root drops, and targets that cannot be
safely revealed remain unsupported.

System notifications use `UNUserNotificationCenter`. Open **connection
diagnostics → App notifications → Enable notifications** to request the Mac's
permission. A successful request returns a real scheduling ID, not proof that a
banner was displayed.

### Remaining implementation gaps and platform boundaries

The original read-only `evaluate`/`evaluateAll` sandbox freezes JavaScript realm
intrinsics and requires Chrome's isolated world. Safari's public AppleEvents
JavaScript command has no isolated-world option; running that sandbox in the
page's main world would damage the page. Use the supported DOM read methods.

Raw desktop CDP and Chrome's device-metrics/DPR overrides have no equivalent
ordinary-profile transport here; use the high-level Safari controls and real
window viewport sizing above. Chrome inline group color/collapse and group
reordering remain unsupported; Safari's native collections have different
semantics.

An installed ordinary-page probe exposed no native `document.modelContext`
`getTools` or `executeTool` methods. WebMCP remains unadvertised until a real
provider is available. Top Sites and recently closed sessions also have no
verified profile-bound provider and return explicit errors, not history rankings
or fabricated restore handles. Generic `Tabs.content()` and `ContentAPI.export()`
remain disabled, as in the original Chrome extension.

Safari lacks Chrome's manifest sandbox pages. The packaged original JavaScript
worker therefore runs at a dedicated local origin with no extension APIs,
credentials, or network access. Exact-parent ports connect it to the original
security-gated host. Host-to-background browser RPC uses a real MessageChannel
bound to the nested host frame and scope, since Safari's same-background-frame
runtime messaging does not reach its own listener. This computation sandbox
does not create website tabs or another login session.

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

Completed installed checks:

- The original **Work** agent completed causal detached HTTP (**41 bytes**),
  explicit Promise/timer (**40 bytes**), server-prepared (**40 bytes**), and
  immediate-revoke Blob (**33 bytes**) downloads. Each returned a real writer
  path with exact content, mode 0600 and quarantine, and a normal final reply.
  Multiple candidates stopped without a path or file GET; navigation during
  preparation made no final file request and did not replay the source click.

- The original **Work** agent completed a different-host, no-CORS
  `tab-origin-policy` redirect through an already-existing claimed destination
  document. Before destination approval there were zero file requests; after
  approval, one authenticated GET produced the exact **46-byte** file with mode
  0600 and quarantine. The destination used only its own HTTP-only login, with
  no copied source cookie or Authorization. Work returned the writer's path
  and finished normally.

- After the scoped native-message admission fix, the original **Work** agent
  saved **3,145,728 exact bytes** through 66 appends in **22.1 seconds**, with one
  nonce-bound GET, the ordinary HTTP-only login retained, mode 0600, quarantine,
  and a normal completed reply. The transfer window had no native host admission
  drops. Closing the actual sidebar in a separate live-stream check cancelled
  the writer after **1,146,880 bytes**, removed its observed partial, stopped the
  server stream, and produced no second file request or completion path.

- A concurrent same-page ordinary download was not adopted, but Work's own
  capture stopped. This establishes a safe stop, not simultaneous completion of
  both downloads. Generic native `async/await` attribution and arbitrary no-CORS
  destinations without an existing authorized origin document remain unresolved.

- The original **Work** agent completed an explicit same-origin-policy button
  download through a real HTTP redirect. Both session-protected endpoints were
  requested once. While the second original approval was pending, the final
  endpoint had not been contacted. Approval produced an exact **52-byte** file
  with mode 0600 and quarantine, preserving the same-name original. Native
  request/header nonce and document identity were observed; Work finished in the
  same inline conversation.

- The original **Work** agent ran `nativeDownloads` once on a synchronous
  connected-anchor button, retained its original download approval, and returned
  a real **46-byte** file. Exact content, mode 0600 and quarantine were verified;
  the same inline conversation finished normally without another button click.

- The original **Work** agent completed a different-host `cross-origin-policy`
  redirect with both ordinary Safari HTTP-only logins retained. Before the
  original destination approval there were zero requests; afterward, one
  preflight and one GET produced the exact **61-byte** file with mode 0600 and
  quarantine. Work returned the writer's actual path and completed normally.
  A non-CORS response failed without a path or fallback. Explicitly denying a
  distinct destination sent no destination request and returned no path.

- After the user enabled Full Disk Access for the containing app, the original
  **Work** agent searched only an exact owned fixture URL in today's Safari
  history. Its normal history consent was retained, the real visit timestamp
  was returned, and the original response finished normally.

- The official provider **Reload** button recovered automatically after the
  expected missing-capability document response, without closing the sidebar or
  restarting the app. A separate root-page reload retained the exact Work draft,
  conversation and enabled Send.

- The original **Work** agent accepted an exact native alert and dismissed an
  exact native confirm, once each. Both returned `responseVerified: true`,
  subsequent dialog inspection was empty, and the confirm page read back
  `false`. The original response finished normally without replay.

- After replacing the containing app, the original **Work** kernel initialized
  successfully in the still-running Safari background. It created a fresh blank
  tab, navigated it once without re-claiming, read its actual page and retained
  session, then closed only that new tab and finished normally.

- The original **Work** agent completed a known native prompt once and read back
  its exact entered value. A separate two-file native upload returned both
  approved filenames and a trusted change event. Both operations completed
  normally without repeating their opening clicks.

- In the original **Chat** mode, attaching two ordinary Safari tabs with **@**
  returned both exact session-only DOM markers. Neither marker was included in
  the prompt. The original Safari consent prompt was retained and the response
  finished normally.

- Native **Ask ChatGPT** attached the owning page's selected text to the same
  original conversation. With an empty composer, exactly one selected-text
  attachment appeared, Send stayed disabled, and nothing was submitted. A second
  selection preserved the exact existing composer draft alongside its attachment.

- In the original **Work** sidebar, a policy-approved download used an ordinary
  Safari page's HTTP-only session and saved the exact 204-byte UTF-8 response to
  Downloads. A same-name file was preserved; the new file had mode 0600 and
  macOS quarantine. The original agent's response finished normally.

- In the original **Work** sidebar, the management capability claimed two
  scratch tabs, reversed their adjacent order, and read the real final order
  back. The original conversation finished normally and other tabs were retained.

- The original **Work** agent read open shadow-root content and both same-origin
  and cross-origin iframe content, entered text, clicked Apply, and finished
  normally in the same cloud conversation.

- The original **Work** agent selected Blue through the native select control
  with trusted input, round-tripped session-local clipboard text, read the
  full-page bottom, and saved an observed SVG plus its asset manifest without
  failures. The saved files were mode 0600 with quarantine, inside a private
  mode-0700 directory; the original response finished normally.

- The original **Work** agent pasted real HTML into an ordinary Safari rich
  editor, copied and cut its synthetic rich text with native shortcuts, and
  pasted it back with bold markup intact. A separate native PNG paste produced
  one image and a trusted `Files` receipt for **68 bytes**. Each requested shortcut
  ran once; native status confirmed pasteboard restoration with no pending
  memory-only recovery. The original replies finished normally.

- The original **Work** agent set the real CSS viewport to **1200 × 650**, then
  reset it successfully and finished normally. A fresh read of the same page
  confirmed the original **1473 × 836** viewport; native status reported
  `leaseActive: false` and `restoration: restored`.

- The original **Work** agent captured a new console event after claiming the
  page and applying a note through trusted input. It then completed a credentialed
  cross-origin download after separate one-time source/destination approvals.
  The saved file matched the exact **53-byte UTF-8** response, including Chinese
  text, with mode 0600 and quarantine; the original response finished normally.

- The original **Work** agent exported the official public Google Sheets
  sample to a real **1,408-byte CSV**, containing the six expected columns and
  30 data rows, after its normal download approval. The file had mode 0600 and
  quarantine; the original reply finished normally. Approval waiting time no
  longer consumes the 30-second transfer deadline.

- The original **Work** agent exported a public YouTube video
  (`aircAruvnKk`) to **20,649 bytes** of UTF-8, including the exact video ID,
  English language metadata and timestamped real captions. The file had mode
  0600 and quarantine. Native UI readback confirmed the captions toggle retained
  its prior state and the video stayed paused; the original reply finished normally.

- The original **Work** management capability moved one explicitly claimed,
  unpinned scratch tab into a new normal window with a single `windows.create`
  call. It read back the same native tab ID and URL in the new window.

- The original **Work** agent completed text entry, an Apply button click, and
  a Next page link click in an ordinary Safari tab, read back the applied value
  and `Session established: true`, and finished after an inline remount. No
  separate MCP client or isolated session performed those actions.

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
node --test tests/test_safari_downloads.js tests/test_safari_download_intent.js tests/test_safari_causal_download.js tests/test_safari_download_realm.js
```

Requirements: full Xcode, macOS, and the local Apple Development identity for
team `N3JN8G9YWK`. The build creates Universal arm64/x86_64 binaries, verifies
signatures, and retains the previous app under `dist/previous-*`.

After a rebuild, run `python3 scripts/restart-companion.py` to restart only this
checkout's containing app, then reopen the inline sidebar. Safari stays running.
The helper refuses pending clipboard recovery or multiple app instances; it
waits for the old process to exit before starting its replacement.

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
