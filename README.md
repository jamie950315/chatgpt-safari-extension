# ChatGPT for Safari — development conversion

Open `dist/ChatGPT for Safari.app`, then enable its extension in Safari Settings.
This is a local Apple Development-signed build, not an official OpenAI Safari
extension or a notarized release. **The full conversion is not complete.**

## Current behavior

- The toolbar mounts a resizable sidebar in the current HTTP/HTTPS page. It loads
  the original ChatGPT side-chat extension UI, not a replacement website launcher.
- Safari native messaging reaches an embedded XPC service and the installed,
  signature-verified OpenAI native host. A real protocol-2 hello has passed from
  the installed Safari extension. Full desktop browser discovery/control has
  not passed.
- The sidebar's **Open connection diagnostics** button opens its native-host
  test and background transport status. The test sends no page content.
- ChatGPT's `frame-ancestors` policy currently rejects the nested Safari frame.
  The original UI therefore reaches its load-error screen rather than a working
  conversation. The conversion does not remove the site's security headers.

## What still prevents the requested end state

Safari 27.0.1 on the tested Mac does not expose the native sidePanel API. The
content sidebar restores its owning page's layout when closed, but it is not a
Safari-native dock. Loading a sidebar shell does not establish chat, login, or
tab-context functionality; those flows remain incomplete because of the frame
restriction above.

The original desktop browser runtime translates Playwright, accessibility, and
input operations into Chrome DevTools Protocol requests before they reach the
extension. Safari has no `chrome.debugger`. Apple's `safaridriver --mcp` passed
real input/click/navigation tests after remote automation was enabled, but its
automation session cannot attach to existing Safari tabs or their login state.
It is not wired into the original runtime. Browser control is not reported as
supported merely because those isolated tests passed.

The original package also requests Chrome APIs that Safari does not implement,
including bookmarks, downloads, history, offscreen documents, sessions, tab
groups, and top sites. Unsupported event registration is guarded; this is not a
complete implementation of those APIs.

## Rebuild and focused checks

```sh
./scripts/build-safari.sh
python3 -m unittest discover -s tests -p 'test_prepare*.py'
node --test tests/test_native_transport.js tests/test_safari_sidebar.js
```

Requirements: full Xcode, macOS, and the local Apple Development identity for
team `N3JN8G9YWK`. The build produces arm64/x86_64 binaries, verifies signatures,
and retains the previous app under `dist/previous-*`. It does not publish or
notarize anything.

The native bridge uses the existing OpenAI registration at
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json`.
It does not change Chrome/Edge registrations, copy credentials, or impersonate a
Chrome origin. Its XPC client must be this team's signed Safari extension; the
launched host must have OpenAI's signing identity.

## Source layout

- `chatgpt.crx` and `unpacked/`: ignored, unmodified original download.
- `vendor/`: preserved upstream inputs for version-bound preparation.
- `scripts/prepare-safari.py`: exact upstream transformations; an unexpected
  upstream change fails rather than silently skipping a patch.
- `native/`: XPC transport, native framing, and host identity validation.
- `safari/ChatGPT for Safari/`: containing app, extension, and Xcode project.
- Extension `Resources/safari/`: native-port transport, owning-tab sidebar,
  frame authorization, and fixed-operation background RPC. Privileged scripting
  stays in the background: calling it directly from an embedded extension page
  caused WebKit to terminate the page process during installed testing.

Upstream version: **1.26.1005.11759**. [Chrome Web Store listing](https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg).
