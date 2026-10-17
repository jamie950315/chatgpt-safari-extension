# ChatGPT Safari Conversion

## Required outcome

The original side chat, a real ChatGPT/Codex desktop connection, and Safari
automation must work in the installed build before declaring completion.
This is a development-signed conversion of Chrome extension 1.26.1005.11759.

## Current implementation

- The production toolbar mounts a closed-shadow page sidebar, extension wrapper,
  and isolated local provider iframe inside the Safari window. Never replace it
  with a floating AppKit panel. Preserve root reflow, fixed-control compensation,
  and authored-style restoration on close; use acknowledged isolated scripting,
  not unreliable tabs.sendMessage delivery.
- `companion/relay/` is a provider-only HTTPS relay adapted from Margina. Keep its
  loopback/Host/Origin/capability, framing, MIME, redirect, and streaming checks.
  Provider scripts never execute in the privileged extension wrapper.
- A clean provider document reload cannot inherit fetch capability headers.
  Missing-capability HTML stays a 401 and may send only a content-free recovery
  signal to its exact wrapper. Re-entry must retain the same account/provider
  scope; never refresh the session to hide this failure, put keys in storage or
  cookies, or expose a bridge token in the error document.
  Recovery requires a newer native document receipt paired with the current
  authenticated channel's unload checkpoint. Ignore unsolicited/stale signals;
  permit only one same-account re-entry until a fresh document handshake.
- Establish the exact-frame provider channel from its capability-bound document
  readiness signal before original entry initialization. Waiting for iframe
  `load` deadlocks the original context loader when module compilation delays it.
  Duplicate readiness for the same document must not replace its live channel.
- Explicit user authorization permits memory-only sharing of this app's own
  minimal secure HTTP-only ChatGPT session after an official session probe.
  Never read Safari/Margina cookies, persist credentials, or delete the original
  app-owned WebKit profile. The old native view remains for its sign-in profile.
- `companion/SideChatBridge.js` adapts the original host boundary (`aH`, `ipG`, and `Kxt`).
  Resolve the runtime from fresh HTML, install before original entry execution,
  and preserve canonical public module URLs (including known async chunks).
  Forward the actual browser User-Agent. Keep exact real frame/parent identity,
  account scope, and owner invalidation. Do not fake Chrome ancestry, strip CSP,
  or replace the original conversation UI/request construction.
- The relay buffers public JavaScript modules and uses bundled Babel 7.28.5 in
  a separate JavaScriptCore compilation context to lower async generators and
  `for await` only inside the inspected `sY`, `tI`, and `dd` stream factories.
  Keep generated helpers within each factory's closure. Wrapping native
  iterators alone did not prevent the reproduced
  WebKit crash. Never execute provider code in the compiler or privilege its
  output; keep canonical module URLs, original logic, CSP, and license intact.
  Compilation runs on its own queue. The containing app's allow-jit entitlement
  is required for JavaScriptCore compiler performance; it does not grant eval/JIT
  to the sandboxed extension or execute provider code in the native process.
- Set the original website's own-origin `codex.browser.apiBaseUrl` to
  `/backend-api` before entry modules run. Forward actual account/API identity
  headers only to official nonstatic ChatGPT requests; never attach them or
  session cookies to static/CDN resources. Do not fabricate account settings.
- `native/BridgeService.swift` handles the signed extension's native messages.
  The original OpenAI host transport and companion operations are separate.
  Keep XPC client, process signing, and precise origin checks; never log native
  messages or credentials.
- `CompanionControlServer` binds authenticated HTTP only to loopback. Its
  mode-0600 descriptor is runtime data, never source. The containing app owns
  one `SafariAutomation` instance and one Apple driver.
- `automation/` exposes this same backend through the `safari_native` MCP server.
  Use real native tool results; do not emulate CDP with empty successes or DOM
  input events. Apple automation uses isolated tabs/logins, not existing tabs.
- `safari_live` controls ordinary Safari's existing tabs and logins. Its broker
  uses a separate profile/session-bound extension poll channel, independent of
  side-chat ownership. Handles bind profile and tab; snapshots bind document,
  URL, and node identity. Never replay a delivered command after a disconnect.
- The original side-chat Work agent uses its account-bound upstream cloud
  tunnel and JavaScript kernel, not a separate MCP or replacement model loop.
  Its native-only session read is owner-bound and returns only the minimum
  original tunnel fields. Never expose it through the provider host vocabulary.
- `Resources/safari/agent-kernel-bridge.js` dispatches supported high-level DOM
  and navigation commands inside the original security gate. Preserve original
  consent, claimed-tab leases, session/turn scope, and owner cancellation. The
  executor calls the same ordinary-profile live backend internally; it does not
  start safaridriver or fake CDP responses. Unsupported APIs stay disabled.
- The packaged upstream selector helper runs statically in ISOLATED worlds;
  preserve real frame sender/document chains for cross-origin locators. Never
  move upstream `Dc` into MAIN: its required realm lockdown freezes page
  intrinsics. Public Safari AppleEvents cannot select an isolated realm.
  Locators, open shadow roots, native option selection, dialogs, uploads and
  viewport/cropped/full-page screenshots keep their original high-level API
  routes; do not replace trusted native input with DOM-dispatched events.
- Clipboard API items belong to the original session. `SafariNativeClipboard`
  temporarily bridges supported plain/HTML/RTF/PNG/TIFF/JPEG/PDF items through
  NSPasteboard and native shortcuts. Preserve every prior item/type/data only in
  memory; restore only after the exact node/document/snapshot/nonce-bound trusted
  event receipt, with observed-generation checks. Never import unknown copy/cut
  generations, expose prior clipboard data, dereference file URLs, or claim
  public pasteboard APIs provide cross-process atomic writer identity. Unknown
  delivered copy/cut retains prior memory even before publication. Late exact
  receipts may finish cleanup; newer observed generations must not be overwritten.
  Do not restart the app while `live_status.clipboard.pending` is true.
  Intercept clipboard chords in every DOM/CUA/locator key route.
  Console capture starts at claim/navigation, is bounded to 500 messages and the
  active turn/five minutes, and releases on account/owner/turn teardown. Asset
  bundles use the operation-bound private writer and original download/fetch
  consent, not fabricated paths.
- `native/SafariViewport.swift` and `Resources/safari/viewport-background.js`
  resize the real ordinary Safari window, not CDP device metrics, DPR, mobile
  emulation or page zoom. Resolve the current turn's claimed logical-active tab;
  never guess a focused user tab. Require the sidebar's same native window,
  exact document/CSS measurements and signed native foreground/window proof.
  Preserve the first original bounds; make at most three measured adjustments.
  Only a genuinely completed sidebar-owner restoration may `commitReturnPage`
  for rollback. It must not expand normal resize/check page authority. Reset
  and turn/owner/account cleanup never select tabs, activate windows, or overwrite
  manual focus/move/resize/URL changes. Preserve an unconfirmed native lease and
  its explicit `live_status.viewport` outcome rather than silently losing it.
- History uses trusted SFExtensionProfileKey observations and exact read-only
  metadata/store binding. Unknown mappings never select a default store.
  Bookmarks use a capability-addressed inert temporary page and native editor;
  preserve the owning sidebar and never write Safari's live plist. Row handles
  bind native identity, profile, and account epoch. Await the sole temporary
  tab's exact completed navigation; do not create another tab after a readiness
  race. Bind the editor to its retained utility address and unique native
  outline/title; Safari's editor need not expose a WebArea. CRUD uses real
  Add Bookmark/editor/context-menu actions with exact
  destination and complete before/after hierarchy proof. Built-in collections
  are protected; nonempty folder deletion requires `removeTree`. Movement uses
  trusted native drag into an explicit visible folder, appends only, and verifies
  the entire subtree and unrelated hierarchy. No root drops, explicit insertion
  indices, offscreen targets, or replay of an uncertain mutation.
- `SafariFileChooser` accepts only a native-opened panel and its exact observed
  DOM input/profile/document/owner/session/turn lease. Keep original upload
  approval, native file/path readback, and no-replay outcomes. Never substitute
  DOM file assignments or guessed inputs. Native input authorization is checked
  again after serial-queue admission and before later events.
- The original Tab capabilities `nativeDialogs.run` and `nativeUploads.run`
  register one native click plus its exact response before Safari suspends
  extension callbacks. Keep the original browser/upload security gate.
  Dialogs require a known exact type/full message and explicit accept boolean;
  only an accepting prompt may set prompt text. Uploads require one visible,
  enabled top-level/same-origin file input, explicit regular same-directory
  files and the actual multiple attribute. Recheck document/node/file inode
  after approval. Both default to and allow at most 10 seconds. A source/window/
  origin/type/message mismatch or focus change leaves the modal untouched;
  never replay the click. Alert response first moves and verifies the native
  cursor, then rechecks the exact button before one down/up; preserve native
  cursor tracking rather than adding another click after an uncertain result.
  Ordinary click/getJsDialog and filechooser-event
  contracts remain, but unarmed modal round trips can stall and may require
  manual dismissal. Do not claim them as installed working from native-only proof.
- Notifications use the containing app's real UserNotifications authorization
  and scheduling acknowledgment. Only an explicit diagnostics button requests
  permission; no silent empty successes or invented display receipts.
- Chat tab mentions retain the original consent-gated `executeTabRead` extractor.
  Use its existing 80,000-character traversal/output bounds; do not replace Chat
  requests or turn the owner-only `tabContext` event into cross-tab page access.
  Native Ask ChatGPT attaches selected text, rather than inserting composer text.
  Website prompt invocations may prefill the composer; neither path submits
  automatically or replaces an existing draft.
- Work's management capability uses actual Safari tab APIs and native named
  Tab Groups through `SafariTabOrganization`. Require claimed tabs for changes,
  exact native window/page/title identity, and operation-bound cancellation.
  Keep the hosting sidebar tab outside group/ungroup batches. A create operation
  may park and rekey its source collection. Only that bounded native lease,
  restored source/destination proof, exact native window, unique original/fresh
  owner page identity, and matching terminal selection may rebind the same owner
  token and remount its conversation. Never create persistent tab aliases,
  transfer general claimed-tab authority, or restart the tunnel for this remount.
  Select and verify a restored inactive owner before running any frame/snapshot
  script: Safari rejects script injection into its lazy restored document.
  Rename acceptance uses the exact original native row, its committed new name,
  the old name's absence, and ended editing. Update the verified preflight
  inventory from that proof; do not trigger another post-rename picker relayout.
  Safari groups are separate collections; their session-local handles map to
  observed native names, not fabricated Chrome group IDs/color/collapse state.
  Reject duplicate names and shared or unverifiable groups. Do not advertise
  unsupported management methods or fabricate Chrome-only audit snapshots.
- Work downloads inspect a current DOM link, then run the original download
  consent/policy before ordinary-profile Safari fetch. Cross-origin HTTP(S)
  links additionally require real credentialed CORS. Bind each 48 KiB chunk and
  native writer call to the live operation/profile/owner/document/link. Reject
  unapproved redirects and blob/JavaScript-button verified downloads; cap at
  32 MiB/30 s. Never infer completion from a click or a new file in Downloads.
  Save completed files privately in Downloads with collision-safe names and
  quarantine; never open them automatically. Cancel partials on owner change,
  background restart, failure, timeout, and shutdown. No cookies leave Safari.
- `Tab.content.exportGsuite` derives official Google Workspace export URLs;
  `exportYouTubeTranscript` uses a fixed current-video player/timedtext helper
  and restores the prior captions state. Keep original download approval,
  account/profile/owner/session/turn/document binding and bounded native writing;
  return paths only after real bytes are saved. Generic `Tabs.content` and
  `ContentAPI.export` remain disabled as in the original extension.
- WebMCP remains unadvertised: the installed fixed provider probe exposed no
  `document.modelContext.getTools/executeTool`. Never invent a provider or tools.
  Top Sites/recently closed lack a verified Safari profile-bound provider;
  preserve explicit errors rather than history substitutes or fake restore IDs.
- Safari does not implement manifest `sandbox.pages`. The original packaged
  worker runs at a separate capability-bound `chatgpt-kernel-*.localhost` origin
  served by `CompanionControlServer`, without extension APIs, credentials, or
  network access. Keep its exact Host/parent/capability, CSP, body, and resource
  checks. Never add eval permission to privileged extension pages or run agent
  scripts in the provider relay. Background/offscreen traffic uses a real
  parent-validated MessageChannel because runtime messages do not deliver to
  Safari's replacement offscreen iframe in the same background document. The
  host's browser RPC also uses a real MessageChannel, accepted only from the
  exact nested host frame and scope; never fabricate a runtime sender.
- A same-session provider remount must not suspend active cloud RPCs. Compare
  the verified in-memory app session before refreshing the original tunnel;
  changed credentials/account and sign-out must still update it.
- `native/SafariLiveInput.swift` uses public AX + CGEvent for trusted input.
  Preserve real Accessibility checks, Safari foreground/window/page identity,
  viewport mapping, native hit testing, and editable keyboard focus. Never use
  this backend to bypass another tool's denied app access, or replace native
  input with JavaScript-dispatched events. Test mutations on ordinary-profile
  scratch pages; existing authenticated pages can be checked read-only.
- An explicit live interaction uses `AXFrontmost` once to focus only the
  signature-verified Safari process/window. Later user focus changes abort the
  batch. WebExtension windows.update and cooperative AppKit activation do not
  establish native foreground ownership. Initialize/read dynamic Workspace
  state on the main runloop and verify the actual AX focused application PID.
- Native event posting is asynchronous: observe DOM focus after a native click
  without replaying it. Page keys require an already focused node. A loading
  document keeps its real tab handle and completed inputs (`pagePending`), not
  an error that invites repeating a delivered navigation.
- Native modal inspection includes attached AXSheets, not only AXChildren.
  Fixed native input receipts distinguish dispatch, native completion, extension
  acknowledgment, and final resolution without logging page contents or tokens.
  A callback timeout is an observation, never permission to replay an input.
- `Resources/safari/sidebar-adapter.js` is the sole toolbar/sidebar state owner.
  Its companion binding brokers real Safari context/selection/tab mentions and
  releases ownership when the inline sidebar closes.
- The macOS manifest uses a persistent MV2 background document. MV3's worker
  stalled cold-start context requests in installed Safari. Derive the manifest
  from `vendor/manifest.safari-input.json`, preserve CSP/permissions/resources,
  and use the actual `browserAction` API. Do not assign over Safari API objects.
- Upstream calls `ChatGPTSafariConnectNative` directly. Assigning Safari's
  built-in `runtime.connectNative` did not replace that host method.
- New blank tabs keep Safari's actual empty URL/title. A memory-only receipt
  comes only from a successful native create callback and binds the exact tab,
  window, profile, account, owner, session and turn. It authorizes only the first
  navigation or close, never DOM/read/input. Consume or invalidate it on
  nonblank navigation, removal/attachment, owner/turn teardown or background
  reload; never retroactively authorize an observed blank tab.
- Session windows replace the upstream internal Chrome tab-group manager.
  Preserve preferred windows and stable tab IDs; automatic session management
  never moves user tabs. Explicit organization moves only requested claimed tabs
  through the separate native management capability.

## Build and acceptance

Build with `./scripts/build-safari.sh`; output is
`dist/ChatGPT for Safari.app`. Signing uses the local Apple Development identity
and team `N3JN8G9YWK`. The app is Universal, not notarized. The containing app is
unsandboxed for its native runtime; the Safari extension stays sandboxed.
Register only the canonical dist extension with PlugInKit. Xcode's intermediate
app must not remain registered/running alongside it: duplicate copies create
different extension origins/backgrounds and can bind the toolbar to stale code.
Use `python3 scripts/restart-companion.py` after a rebuild, then reopen the
inline sidebar. Never restart Safari. The helper matches executable paths
independently of launch arguments and refuses pending clipboard recovery or
multiple app instances. The original kernel checks its owner-bound native
resource before execution: only an actual service/capability change replaces
the offscreen document, rejecting old delivered work without replay.

Native hello and desktop discovery/tab listing/creation passed. The installed
embedded route passed official session validation, real settings requests,
signed-in conversation, owning-page selected-text context, page reflow,
fixed-control compensation, and divider resizing. The original ChatGPT UI
answered with selected text absent from the prompt. Closing/reopening the
inline sidebar retained its login and the same conversation. Real
Safari-native input/click/navigation passed; a fresh Codex
app-server consumer loaded 19 MCP tools and called session
status. The active desktop conversation also used the registered MCP tools for
real page reading, input, click, and navigation. Preserve saved-owner polling
across background reload without reopening the native UI or restarting a quit app.

Existing-profile `safari_live` tab listing, authenticated-page reading, trusted
Unicode input/clicks, fullscreen page keys, 500-pixel scrolling, same-tab native
link navigation with retained session cookie, and stale-document rejection
passed through fresh desktop MCP consumers. The installed app has Accessibility
permission; `live_status` reports actual input and session state. These are
ordinary-profile results, separate from isolated-session acceptance.

Preserve original downloads, browser profiles, login state, drafts, and user
tabs. Test only owned pages, do not restart Safari, and stop owned probes.
Do not alter the installed OpenAI app/plugin or Chrome host registration.
Build artifacts, private configuration backups, and probe reports stay ignored.
Use only owned synthetic bookmarks for acceptance; do not send private bookmark
inventories to the cloud agent.

Current installed acceptance remains open for bookmark CRUD and updated
website prompt prefill. Native prompt response and two-file upload passed
through the original Work agent with exact page readback and no replay.
Keep source/protocol checks separate from
original Work completion and retain still-valid accepted results below.

Installed native Ask ChatGPT passed selected-text attachment in the same
conversation: an empty composer remained empty with Send disabled and no
submission. A second selection retained the exact existing composer draft
alongside its attachment.

The installed original sidebar Work agent passed existing-tab text entry,
Apply button input/readback, and same-tab Next page navigation with the ordinary
HTTP-only session retained. The conversation survived inline remount and its
response finished normally. This path used the original cloud agent and native
backend, without a separate MCP client or isolated website session. Keep future
acceptance distinct from tunnel-only and isolated-worker checks.

The installed original Work path also read open-shadow and same/cross-origin
frame content, selected Blue with trusted native input, round-tripped its virtual
clipboard text, read the full-page bottom and saved an observed SVG asset bundle
with its real manifest and no failures. Its response finished normally. The
bundle directory was mode 0700; completed files were mode 0600 with quarantine.

The installed original Work viewport capability set exact CSS dimensions
1200x650, reset successfully, and finished normally. A fresh same-page read
confirmed the original 1473x836 viewport; native status reported no active lease
and restoration `restored`. This is original Work acceptance, not MCP-only proof.

The installed original Work path captured a new claimed-page console event after
trusted note/Apply input, then completed a credentialed CORS download with the
original one-time source and exact-destination approvals. The real file matched
the exact 53-byte UTF-8 response, including Chinese text, with mode 0600 and
quarantine; the original response finished normally.

The installed original Work sidebar also claimed two specified scratch tabs,
reordered them through Safari tab APIs, and read back their exact final order.
The original Work download path also passed the original one-time policy
approval, ordinary-profile authenticated fetch, exact 204-byte UTF-8 file,
collision preservation, 0600/quarantine, and normal final conversation response.
The original Work sidebar passed a single two-tab native grouping batch,
including source collection restoration, fresh source IDs, and the original
conversation's inline remount. The installed original Work agent subsequently
renamed that group to Safari Work Complete, read both exact ordinary-profile
pages with their HTTP-only session retained, and finished normally. Keep real
foreground/window checks and stop on manual focus changes. Safe selection
diagnostics report fixed failure stages/codes, not page contents or credentials;
management errors retain fixed native outcome fields in their message because
the upstream kernel does not preserve arbitrary error metadata.

Installed original Work rich clipboard acceptance passed HTML paste, rich
copy/cut and paste-back, and a 68-byte PNG paste with a trusted Files event and
one editor image. Native status confirmed restoration with no pending recovery.

Installed original Work Google Sheets CSV export passed with 1,408 real bytes,
30 data rows, mode 0600 and quarantine. Ordinary windows.create passed once for
an existing claimed scratch tab, retaining its native tab ID and URL.
The original Work agent also created a fresh blank tab, navigated it once without re-claiming,
read the actual page and retained session, then closed only that new tab.

Installed original Work YouTube export passed with 20,649 UTF-8 bytes of real
English captions for aircAruvnKk, mode 0600 and quarantine. Native readback
confirmed the prior captions toggle state and paused playback were retained.

Installed original Work alert and confirm responses passed once each, with
verified closure, null subsequent dialog inspection, and actual confirm
readback `false`.

An installed official provider Reload first produced the inert missing-capability
401, then automatically recovered the same owner/provider homepage without
closing the sidebar, restarting the app, signing out or refreshing the session.
A separate root-page reload retained its exact Work draft, conversation and
enabled Send. The earlier disabled-Send state is currently not reproduced; do
not add speculative composer/adoption mutations.
