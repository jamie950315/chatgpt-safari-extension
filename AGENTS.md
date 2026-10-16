# ChatGPT Safari Conversion

## Scope

This is a local, development-signed Safari Web Extension conversion of OpenAI's
ChatGPT Chrome extension 1.26.1005.11759 (Chrome Web Store ID
`hehggadaopoacecdllhhajmbjkdcmajg`). It is not an official Safari release.

- `unpacked/` and `chatgpt.crx` preserve the original download and are ignored.
- `safari/ChatGPT for Safari/` contains Apple's converted Xcode project and copied
  upstream extension resources. Do not silently replace the extension with a
  website launcher or pretend unsupported browser APIs work.
- `vendor/background.chrome.js` preserves the original background. The preparation
  script adds capability checks for Chrome-store update, debugger, download,
  and created-navigation-target event registration and CDP
  heartbeat cleanup; it does not emulate unsupported APIs. Safari lacks required Chrome APIs,
  including `debugger` and `sidePanel`; the desktop native host is not ported.
  Packaging, Safari registration, and functional browser control are separate gates.
- The upstream waiting page identifies the local Safari conversion and its actual
  limits instead of displaying an unrelated Chrome rollout promise.
- The generated native message handler returns an explicit unsupported error,
  rather than Apple's sample echo response.

## Build

Run `./scripts/build-safari.sh` on a Mac with full Xcode installed. The app is
written to `dist/ChatGPT for Safari.app`. Build logs and DerivedData stay under
ignored `build/`. Signing uses the local Apple Development identity and team
`N3JN8G9YWK`; no credentials or provisioning profiles belong in Git.

Do not modify existing browser profiles, close user tabs, disable system security
checks, or claim full ChatGPT browser control based on a successful native build.
