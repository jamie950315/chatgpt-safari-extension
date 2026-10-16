# ChatGPT Safari Conversion

## Goal and current boundary

The requested result is the original side chat, a real ChatGPT/Codex desktop
connection, and browser automation in Safari. All three must work in the actual
installed build before declaring completion. This is a local development-signed
conversion of Chrome extension 1.26.1005.11759, not an official Safari release.

The current build has a content sidebar and an XPC native-host transport. An
installed-Safari protocol-2 native hello, desktop discovery as Safari, real tab
listing, and desktop-requested agent tab creation passed. Navigation fails at
the unavailable CDP debugger attachment. ChatGPT's frame-ancestors policy rejects the nested Safari chat
frame. Safari's native sidePanel implementation is compiled out on the tested
Safari 27.0.1. Do not remove site security headers, substitute a website launcher,
or call the visible sidebar shell a working chat.

The upstream desktop kernel expects arbitrary CDP, live remote objects, AX,
trusted input, and real Document response interception. Safari's official MCP
supports isolated automation sessions, not attachment to existing Safari tabs.
Do not return empty CDP successes or equate standalone MCP probes with integration.

## Ownership and build

- `unpacked/` and `chatgpt.crx` are ignored, preserved original downloads.
- `vendor/` holds upstream inputs; `scripts/prepare-safari.py` applies exact,
  version-bound changes to copied extension resources.
- `Resources/safari/sidebar-adapter.js` is the sole toolbar/sidebar state owner.
  Embedded extension frames use fixed-operation runtime RPC for privileged
  scripting/tab APIs. Direct scripting from those frames triggered WebKit IPC
  validation failure and page termination in installed testing.
- `Resources/safari/session-windows.js` replaces the upstream internal tab-group
  manager with real Safari window/tab creation. Preserve explicit preferred
  windows and stable tab IDs; do not move user tabs or fabricate Chrome groups.
  The upstream native connection calls `ChatGPTSafariConnectNative` directly:
  assigning Safari's built-in `runtime.connectNative` did not replace its behavior.
- `native/` bridges request/reply Safari messages to the existing OpenAI stdio
  host through an embedded XPC service. Keep code-signature checks and precise
  client/origin checks; never log native message contents or credentials.
- Build with `./scripts/build-safari.sh`; output is
  `dist/ChatGPT for Safari.app`, with previous builds retained in `dist/`.
  Use the local Apple Development identity and team `N3JN8G9YWK`.
- Native and source tests do not replace installed chat, desktop request, and
  browser-control acceptance. Build artifacts and probe logs stay ignored.

Preserve browser profiles, login state, drafts, and user tabs. Test only owned
pages, do not restart Safari, and clean up task-owned probes. Do not alter the
installed OpenAI app/plugin, Chrome host registrations, or system security to
conceal an unsupported integration.
