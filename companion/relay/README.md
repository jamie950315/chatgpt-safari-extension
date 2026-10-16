# Embedded ChatGPT provider relay

The Safari page owns the sidebar layout. Its local extension frame contains a
separate, unprivileged provider frame. This native transport relays only the
allowlisted ChatGPT website over HTTPS; it exposes no MCP or generic native API.
Its bounded HTTP/SSE transport is adapted from Jamie's Margina implementation.

## Native integration

Compile these containing-app sources:

- `ProviderRelayPolicy.swift`
- `ProviderRelayCore.swift`
- `ChatGPTProviderRelay.swift`

Bundle `ProviderBrowser.js` and the application's `SideChatBridge.js` as local
resources. The API is asynchronous and delivers public completions on the main
queue:

```swift
let relay = ChatGPTProviderRelay(browserShim: browserData,
                                sideChatHostScript: sideChatData)
relay.start(parentExtensionOrigin: extensionOrigin,
            conversationURL: conversationURL) { result in
    // Start creates an anonymous, app-owned memory session.
}
// Only after authorization, supply this application's own session cookies.
relay.installOwnSessionCookies(authorizedOwnCookies) { result in
    // A separate official /api/auth/session check must pass.
    relay.entry(conversationURL: conversationURL) { entry in
        // Return entry.dictionary only to the owning extension frame.
    }
}
```

The API itself never reads WebKit, Safari, Margina, Keychain, or filesystem
credentials. It selects one supported secure, HTTP-only ChatGPT session-cookie
envelope from the explicitly supplied app-owned cookies. Anti-bot, device,
third-party, and unknown cookie formats are excluded. The jar is ephemeral.
Session replacement revokes old requests, capabilities, bridge tokens, and
account scopes before validation. Failed validation disables provider access.

`clearOwnSession()` revokes only relay memory and creates a new anonymous scope;
it never logs out or deletes the original WK profile. Sidebar closure should
retain the relay. Call `stop()` when the containing app quits. Reopening under
the same exact extension origin retains its session and conversation route.

## Provider host-script contract

The browser shim publishes a frozen `window.ChatGPTSafariProviderRelay`:

- `providerOrigin`: the real, per-process local HTTP origin.
- `parentExtensionOrigin`: the exact authorized Safari extension origin.
- `bridgeToken`: the separate, session-local host-channel capability.
- `runtimeURL`: the single official `633146.<deployment>.js` URL found in the
  upstream HTML's script/link attributes. Missing or ambiguous deployment fails.
- `importURL(officialURL)`: maps an allowlisted official HTTPS module to the
  authenticated local provider URL.
- `upstreamURL(localURL)`: maps a public provider URL back to its official URL,
  removing local capability/inline-module query parameters.

The host script owns its one MessageChannel handshake. It must verify the exact
extension parent, actual provider origin, message source, and bridge token.
The browser shim neither accepts messages nor exposes account/native controls.
Only the wrapper receives `entry.dictionary`; never put it in the host page's
DOM, storage, URL, or messages.

`SideChatBridge.js` must assign a real readiness promise to
`globalThis.__CHATGPT_SAFARI_ADAPTER_READY__`. The served host module awaits that
promise. Each original site module then executes a sequential dynamic import:
first the host module, then its unchanged original module. Inline site source
is retained in bounded native memory and served under its document's path so
relative imports keep the same base. No blob/data scripts, evaluation, or
browser-origin impersonation are introduced.

## Policy and limits

The provider listener is separate from the companion control listener and binds
only to `127.0.0.1` using a unique `.localhost` hostname. It verifies exact Host,
same-provider Origin, a per-session capability, framing, redirects, and static
MIME types. Browser Cookie/Referer/Host/control headers and upstream Set-Cookie
are not forwarded to the provider document. Static assets remain cookie-free.
The bounded upstream header set preserves the incoming browser's actual
`User-Agent`; it never invents a Chrome agent or substitutes a hard-coded
browser identity.

`status` includes a bounded `runtimeInspection` inventory for deployment
diagnosis. It retains only public `/cdn/assets/*.js` paths grouped by HTML
script/link attributes, import literals, other literals, and HTTP Link headers,
plus fixed state/error enums and numeric/boolean response metadata. It never
retains authenticated HTML, private URLs, headers, body excerpts, or cookies.

Script CSP protections are retained. The frame directive permits the actual
extension parent plus its owning HTTP(S) page ancestors; the host handshake
checks the direct parent exactly. HTTPS-upgrade and remote-report directives
are adapted for this local presentation. Login/signout proxying is blocked;
account entry remains on official HTTPS pages. Provider challenges surface as
failures. WebSocket is not implemented.

Limits: 32 clients, 32 MiB request/non-HTML response, 16 MiB HTML, 128 MiB queued
uploads, 128 retained inline modules within 16 MiB, 15-second request read,
30-second stalled write, and 600-second overall request lifetime. Streaming
responses use downstream backpressure. There is no mutation retry.

## Focused checks

```sh
xcrun swiftc -swift-version 5 companion/relay/ProviderRelayPolicy.swift \
  tests/RelayPolicy.swift -o build/relay-checks/policy
build/relay-checks/policy companion/relay/ProviderBrowser.js
xcrun swiftc -swift-version 5 companion/relay/*.swift \
  tests/RelayLifecycle.swift -o build/relay-checks/lifecycle
build/relay-checks/lifecycle companion/relay/ProviderBrowser.js
node --test tests/RelayBrowser.test.js tests/RelayHTTP.test.js
```

These checks use synthetic account data and an owned loopback upstream. Actual
signed-in provider behavior, original site rendering, and owning-page context
require installed Safari acceptance.
