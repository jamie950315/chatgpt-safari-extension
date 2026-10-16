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
- Explicit user authorization permits memory-only sharing of this app's own
  minimal secure HTTP-only ChatGPT session after an official session probe.
  Never read Safari/Margina cookies, persist credentials, or delete the original
  app-owned WebKit profile. The old native view remains for its sign-in profile.
- `companion/SideChatBridge.js` adapts the original host boundary (`aH` and `Kxt`).
  Resolve the runtime from fresh HTML, install before original entry execution,
  and preserve canonical public module URLs (including known async chunks).
  Forward the actual browser User-Agent. Keep exact real frame/parent identity,
  account scope, and owner invalidation. Do not fake Chrome ancestry, strip CSP,
  or replace the original conversation UI/request construction.
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
- `Resources/safari/sidebar-adapter.js` is the sole toolbar/sidebar state owner.
  Its companion binding brokers real Safari context/selection/tab mentions and
  releases ownership when the inline sidebar closes.
- The macOS manifest uses a persistent MV2 background document. MV3's worker
  stalled cold-start context requests in installed Safari. Derive the manifest
  from `vendor/manifest.safari-input.json`, preserve CSP/permissions/resources,
  and use the actual `browserAction` API. Do not assign over Safari API objects.
- Upstream calls `ChatGPTSafariConnectNative` directly. Assigning Safari's
  built-in `runtime.connectNative` did not replace that host method.
- Session windows replace the upstream internal Chrome tab-group manager.
  Preserve preferred windows and stable tab IDs; never move user tabs.

## Build and acceptance

Build with `./scripts/build-safari.sh`; output is
`dist/ChatGPT for Safari.app`. Signing uses the local Apple Development identity
and team `N3JN8G9YWK`. The app is Universal, not notarized. The containing app is
unsandboxed for its native runtime; the Safari extension stays sandboxed.

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
