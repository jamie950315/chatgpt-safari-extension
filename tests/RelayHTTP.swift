import Foundation

// Synthetic transport fixture. Capabilities travel only over the test's private fd 3.
@main struct RelayHTTPFixture {
    static func main() throws {
        let upstream = URL(string: CommandLine.arguments[1])!
        guard upstream.scheme == "http", upstream.host == "127.0.0.1" else { fatalError("The fixture accepts loopback only") }
        let shim = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let engine = try ProviderRelayServer(mainOrigin: upstream, browserShim: shim,
            sideChatHostScript: Data("globalThis.__CHATGPT_SAFARI_ADAPTER_READY__ = Promise.resolve();".utf8))
        engine.policy.parentExtensionOrigin = "safari-web-extension://fixture-extension"
        func emit(_ extra: [String: Any] = [:]) {
            var result: [String: Any] = ["origin": engine.policy.localOrigin, "key": engine.policy.key,
                "bridgeToken": engine.policy.bridgeToken, "accountScope": engine.accountScope]
            for (key, value) in extra { result[key] = value }
            var data = try! JSONSerialization.data(withJSONObject: result); data.append(10)
            FileHandle(fileDescriptor: 3, closeOnDealloc: false).write(data)
        }
        engine.onReady = { emit() }
        try engine.start()
        DispatchQueue.global().async {
            while let line = readLine() {
                providerRelayQueue.async {
                    switch line {
                    case "clear":
                        try! engine.replaceSession(accessible: true); engine.phase = "guest"; emit()
                    case "status": emit(["providerReport": engine.providerReport ?? NSNull(), "requestRoutes": engine.requestRoutes,
                                         "settingsRequests": engine.settingsRequests.map(\.dictionary)])
                    case "verify":
                        let cookie = HTTPCookie(properties: [.name: "__Secure-next-auth.session-token", .value: "synthetic-fixture-only",
                            .domain: ".chatgpt.com", .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"])!
                        engine.verifyOwnSession([cookie]) { verified in
                            engine.enabled = verified; engine.phase = verified ? "signedIn" : "blocked"
                            emit(["verified": verified])
                        }
                    case "stop": engine.stop(); exit(0)
                    default: fatalError("Unknown fixture command")
                    }
                }
            }
        }
        dispatchMain()
    }
}
