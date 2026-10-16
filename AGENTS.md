# ChatGPT Safari Conversion

## Required outcome

The original side chat, a real ChatGPT/Codex desktop connection, and Safari
automation must work in the installed build before declaring completion.
This is a development-signed conversion of Chrome extension 1.26.1005.11759.

## Current implementation

- The production toolbar uses an AppKit sidecar with a top-level ChatGPT
  WKWebView in a key-capable nonactivating panel. Its profile persists
  independently of Safari; never import cookies.
  The old content-sidebar source remains as preserved tested infrastructure,
  not the production route.
- `companion/SideChatBridge.js` replaces the inspected website's Chrome-only
  host boundary (`aH` and `Kxt`, runtime `633146.1f9c264032.js`). Keep exact
  deployment checks, real origin/WebView identity, account scope, and owner
  invalidation. Do not fake Chrome origins or browser ancestry, strip CSP, or
  replace the original conversation UI/request construction.
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
- `Resources/safari/sidebar-adapter.js` is the sole toolbar/sidebar state owner.
  Its companion binding brokers real Safari context/selection/tab mentions and
  releases ownership when the native window closes.
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

Native hello, desktop discovery/tab listing/creation, guest and signed-in side
chat, and actual owning-page selection passed. The original signed-in UI
answered with selected text that was absent from the prompt, including after
a cold launch without Reload. Closing/reopening the sidecar retained the
conversation. Real Safari-native input/click/navigation passed; a fresh Codex
app-server consumer loaded 19 MCP tools and called session
status. The active desktop conversation also used the registered MCP tools for
real page reading, input, click, and navigation. Preserve saved-owner polling
across background reload without reopening the native UI or restarting a quit app.

Preserve original downloads, browser profiles, login state, drafts, and user
tabs. Test only owned pages, do not restart Safari, and stop owned probes.
Do not alter the installed OpenAI app/plugin or Chrome host registration.
Build artifacts, private configuration backups, and probe reports stay ignored.
