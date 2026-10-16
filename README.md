# ChatGPT for Safari — local conversion

Open `dist/ChatGPT for Safari.app`, then use **Open Safari Settings** to find the
extension in Safari's Extensions settings. This is a development-signed local
conversion, not an official OpenAI Safari extension or a notarized release.

## What was converted

Apple's `safari-web-extension-converter` generated a macOS containing app and a
Safari Web Extension from ChatGPT Chrome extension **1.26.1005.11759**. The copied
Chrome JavaScript and assets are retained in the Xcode project's extension
Resources directory, with bounded background capability guards and corrected
Safari waiting-page text. The containing app explains the compatibility limitations.

Source listing: <https://chromewebstore.google.com/detail/chatgpt/hehggadaopoacecdllhhajmbjkdcmajg>

## Compatibility limits

The extension package can be built and registered with Safari. **The original
ChatGPT browser-control runtime is not compatible with Safari.** In particular:

- Chrome DevTools Protocol control uses `chrome.debugger`, which Safari does not
  provide. The conversion guards debugger/download event registration and CDP
  heartbeat cleanup so missing Chrome APIs do not crash background startup. It
  does not emulate browser control or report unsupported operations as successful.
- Safari installs updates through the containing app, not Chrome's
  `runtime.onUpdateAvailable`; the Chrome-store listener is guarded as well.
- Safari does not expose `webNavigation.onCreatedNavigationTarget`; its optional
  listener is guarded without changing supported navigation events.
- Chrome side-panel integration uses `chrome.sidePanel`, unavailable in Safari.
- The existing native host uses `runtime.connectNative`. Safari native messaging
  requires a Safari app-extension handler; the generated handler is not a bridge
  to the ChatGPT/Codex desktop app and explicitly reports that limitation.
- Apple's converter also flags `bookmarks`, `downloads`, `downloads.open`,
  `favicon`, `history`, `notifications`, `offscreen`, `sessions`, `tabGroups`,
  `topSites`, `sandbox`, `include_globs`, and content-script `world` as unsupported.

Enabling this package does not make ChatGPT able to control Safari. Achieving
that requires a separate Safari-native implementation and desktop integration,
not just a different manifest. The conversion does not add fake API shims or
silently substitute a website launcher.

## Rebuild

```sh
./scripts/build-safari.sh
```

Requirements: full Xcode, macOS, and the configured local Apple Development
identity for team `N3JN8G9YWK`. The script builds a universal Release app, verifies
its signature, and copies it to `dist/`. Nothing is published or notarized.

Project: `safari/ChatGPT for Safari/ChatGPT for Safari.xcodeproj`.

`vendor/background.chrome.js` retains the original Chrome background. The build
applies the exact, version-bound changes in `scripts/prepare-safari.py` to the
Safari copy; an unexpected upstream change fails preparation rather than guessing.
