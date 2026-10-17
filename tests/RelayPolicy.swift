import Foundation

@main struct RelayPolicyChecks {
    static func rejects(_ operation: () throws -> Void, _ message: String) {
        do { try operation(); fatalError(message) } catch {}
    }
    static func cookie(_ name: String = "__Secure-next-auth.session-token", domain: String = ".chatgpt.com", secure: Bool = true, httpOnly: Bool = true) -> HTTPCookie {
        var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: "synthetic-fixture-only", .domain: domain, .path: "/", .expires: Date().addingTimeInterval(3600)]
        if secure { properties[.secure] = "TRUE" }
        if httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        return HTTPCookie(properties: properties)!
    }
    static func main() throws {
        let key = String(repeating: "a", count: 64), parent = "safari-web-extension://fixture-extension"
        let official = URL(string: "https://chatgpt.com")!
        var policy = ProviderRelayPolicy(key: key, bridgeNonce: String(repeating: "b", count: 64), bridgeToken: String(repeating: "c", count: 64), mainOrigin: official)
        policy.localOrigin = "http://chatgpt-provider-fixture.localhost:34567"; policy.parentExtensionOrigin = parent
        precondition(ProviderRelayPolicy.validParent(parent))
        for value in [parent + "/", parent + "/bad", "https://chatgpt.com", "safari-web-extension://user@fixture", parent + ":443"] {
            precondition(!ProviderRelayPolicy.validParent(value), value)
        }
        precondition(ProviderRelayPolicy.validConversation(URL(string: "https://chatgpt.com/c/fixture-id?surface=browser_side_chat")!))
        for value in ["https://chatgpt.com/auth/login", "https://chatgpt.com/?surface=bad", "https://chatgpt.com/?surface=browser_side_chat&surface=browser_side_chat", "https://attacker.invalid/", "https://user:pass@chatgpt.com/"] {
            precondition(!ProviderRelayPolicy.validConversation(URL(string: value)!))
        }
        func request(_ target: String = "/", headers: [String: String] = [:]) -> ProviderRelayRequest {
            ProviderRelayRequest(method: "GET", target: target, headers: ["host": "chatgpt-provider-fixture.localhost:34567", "x-chatgpt-relay": key].merging(headers) { _, new in new }, body: Data())
        }
        precondition(policy.rejection(for: request(), enabled: true) == nil)
        precondition(policy.rejection(for: request(headers: ["host": "attacker.invalid"]), enabled: true)?.0 == 403)
        precondition(policy.rejection(for: request(headers: ["origin": "https://attacker.invalid"]), enabled: true)?.0 == 403)
        precondition(policy.rejection(for: request("/?__chatgpt_key=" + key + "&__chatgpt_key=" + key), enabled: true)?.0 == 401)
        precondition(policy.rejection(for: request("/?__chatgpt_key=wrong"), enabled: true)?.0 == 401)
        precondition(policy.rejection(for: request("/api/auth/signout"), enabled: true)?.0 == 403)
        precondition(policy.rejection(for: request("/__chatgpt/upstream/auth.openai.com/"), enabled: true)?.0 == 403)
        precondition(policy.rejection(for: request("/__chatgpt/upstream/attacker.invalid/"), enabled: true)?.0 == 403)
        precondition(policy.rejection(for: request("/__chatgpt/upstream/chatgpt.com%2f.attacker.invalid/"), enabled: true)?.0 == 403)
        precondition(policy.rejection(for: request(headers: ["upgrade": "websocket"]), enabled: true)?.0 == 501)
        precondition(policy.rejection(for: request(), enabled: false)?.0 == 503)
        let reload = ProviderRelayRequest(method: "GET", target: "/c/fixture?surface=browser_side_chat",
            headers: ["host": "chatgpt-provider-fixture.localhost:34567", "accept": "text/html,application/xhtml+xml", "sec-fetch-dest": "iframe"], body: Data())
        precondition(policy.rejection(for: reload, enabled: true)?.0 == 401, "Reload stays unauthorized until the wrapper obtains a fresh entry")
        precondition(policy.documentRecoveryParent(for: reload, enabled: true) == parent)
        let documentReload = ProviderRelayRequest(method: "GET", target: reload.target,
            headers: reload.headers.merging(["sec-fetch-dest": "document"]) { _, new in new }, body: Data())
        precondition(policy.documentRecoveryParent(for: documentReload, enabled: true) == parent,
                     "WebKit document reload metadata must not prevent native receipt classification")
        precondition(policy.documentRecoveryParent(for: reload, enabled: false) == nil)
        for invalid in [ProviderRelayRequest(method: "POST", target: reload.target, headers: reload.headers, body: Data()),
                        ProviderRelayRequest(method: "GET", target: "/backend-api/me", headers: reload.headers, body: Data()),
                        ProviderRelayRequest(method: "GET", target: "/api/auth/session", headers: reload.headers, body: Data()),
                        ProviderRelayRequest(method: "GET", target: "/?__chatgpt_key=wrong", headers: reload.headers, body: Data()),
                        ProviderRelayRequest(method: "GET", target: reload.target, headers: reload.headers.merging(["origin": "https://attacker.invalid"]) { _, new in new }, body: Data()),
                        ProviderRelayRequest(method: "GET", target: reload.target, headers: reload.headers.merging(["x-chatgpt-relay": "wrong"]) { _, new in new }, body: Data()),
                        ProviderRelayRequest(method: "GET", target: reload.target, headers: reload.headers.merging(["accept": "application/json"]) { _, new in new }, body: Data())] {
            precondition(policy.documentRecoveryParent(for: invalid, enabled: true) == nil)
        }
        func publicAsset(_ path: String) -> Bool {
            policy.publicStatic(ProviderRelayRequest(method: "GET", target: path, headers: [:], body: Data()))
        }
        precondition(publicAsset("/cdn/assets/async/637745.14f70978dc.js"))
        precondition(!publicAsset("/cdn/assets/async/../637745.14f70978dc.js"))
        precondition(!publicAsset("/cdn/assets/async/%2e%2e/637745.14f70978dc.js"))
        precondition(!publicAsset("/cdn/assets/async/nested/637745.14f70978dc.js"))
        precondition(!publicAsset("/cdn/assets/async/637745.14f70978dc.js?secret=private"))
        precondition(policy.upstreamURL("/c/fixture?surface=browser_side_chat&__chatgpt_key=" + key)?.absoluteString == "https://chatgpt.com/c/fixture?surface=browser_side_chat")
        precondition(policy.localURL("https://attacker.invalid/", relativeTo: official) == nil)
        precondition(policy.localURL("https://cdn.oaistatic.com/a.js", relativeTo: official)?.contains("/__chatgpt/upstream/cdn.oaistatic.com/a.js") == true)
        let csp = policy.documentPolicy("default-src 'self'; script-src 'nonce-original'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; report-uri https://invalid/", nonce: policy.bridgeNonce)
        precondition(csp.contains("script-src 'nonce-original' 'nonce-"))
        precondition(csp.contains("object-src 'none'") && csp.contains("frame-ancestors http: https: " + parent))
        precondition(!csp.contains("upgrade-insecure-requests") && !csp.contains("report-uri"))
        let inline = "import './dependency.js'; globalThis.fixtureOriginal = true;"
        let html = "<html><head><link rel=\"modulepreload\" href=\"/cdn/assets/633146.c3403bd103.js\"><script data-marker=\">\" type=\"module\">\(inline)</script><script type='module' src='/cdn/assets/entry-123.js'></script></head><body>Fixture</body></html>"
        var originals: [String] = []
        let adapted = try policy.rewriteDocument(html, nonce: policy.bridgeNonce, documentURL: URL(string: "https://chatgpt.com/c/fixture")!) { source, url in
            precondition(url.path == "/c/fixture")
            originals.append(source); return policy.localOrigin + "/c/fixture?__chatgpt_inline=fixture&__chatgpt_key=" + key
        }
        precondition(originals == [inline], "Inline module source must remain unchanged")
        precondition(adapted.components(separatedBy: "await import(").count == 5, "Each original module waits for the host before importing its original source")
        precondition(adapted.contains("__chatgpt_runtime=633146.c3403bd103.js"))
        let deployedRuntime = try policy.runtimeURL(in: html, documentURL: official)
        precondition(deployedRuntime == "https://chatgpt.com/cdn/assets/633146.c3403bd103.js")
        rejects({ _ = try policy.runtimeURL(in: "<html></html>", documentURL: official) }, "A missing runtime must fail")
        rejects({ _ = try policy.runtimeURL(in: html + "<link href='/cdn/assets/633146.1234567890.js'>", documentURL: official) }, "Multiple deployed runtimes must fail")
        let inventoryHTML = "<html>private-account-email@example.invalid<script type='module'>import('/cdn/assets/entry-123.js'); const assets = ['\\/cdn\\/assets\\/manifest-456.js']; const secret='private-session-value';</script></html>"
        let inventory = policy.runtimeInventory(in: inventoryHTML, httpLinkAssets: ProviderRelayPolicy.publicAssetPaths(in: "</cdn/assets/633146.c3403bd103.js>; rel=modulepreload"))
        let encodedInventory = String(data: try JSONSerialization.data(withJSONObject: inventory), encoding: .utf8)!
        precondition(inventory["inlineImportAssets"] as? [String] == ["/cdn/assets/entry-123.js"])
        precondition(inventory["literalAssets"] as? [String] == ["/cdn/assets/manifest-456.js"])
        precondition(inventory["runtimeCandidates"] as? [String] == ["/cdn/assets/633146.c3403bd103.js"])
        precondition(!encodedInventory.contains("private-account-email") && !encodedInventory.contains("private-session-value"))
        let shim = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let configured = try policy.configuredBrowserShim(shim, runtimeURL: "https://chatgpt.com/cdn/assets/633146.c3403bd103.js")
        precondition(String(data: configured, encoding: .utf8)?.contains("/*__CHATGPT_RELAY_BOOTSTRAP__*/") == false)
        let minimal = try ProviderRelaySessionCookies.select([cookie(), cookie("cf_clearance"), cookie("oai-did", httpOnly: false), cookie("third_party", domain: "accounts.google.com")])
        precondition(minimal.count == 1)
        let chunks = try ProviderRelaySessionCookies.select([cookie("__Secure-authjs.session-token.1"), cookie("__Secure-authjs.session-token.0")])
        precondition(chunks.map(\.name) == ["__Secure-authjs.session-token.0", "__Secure-authjs.session-token.1"])
        rejects({ _ = try ProviderRelaySessionCookies.select([cookie(secure: false)]) }, "Insecure session cookie accepted")
        rejects({ _ = try ProviderRelaySessionCookies.select([cookie(httpOnly: false)]) }, "Non-HTTP-only session cookie accepted")
        rejects({ _ = try ProviderRelaySessionCookies.select([cookie(), cookie("__Secure-authjs.session-token")]) }, "Ambiguous account cookie accepted")
        rejects({ _ = try ProviderRelaySessionCookies.select([cookie("__Secure-authjs.session-token.1")]) }, "Missing chunk accepted")
        let session: [String: Any] = ["user": ["id": "synthetic-user"], "accessToken": "synthetic-access-token", "expires": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))]
        let sessionData = try JSONSerialization.data(withJSONObject: session)
        precondition(ProviderRelaySessionCookies.validSessionResponse(status: 200, data: sessionData))
        precondition(!ProviderRelaySessionCookies.validSessionResponse(status: 403, data: sessionData))
        precondition(!ProviderRelaySessionCookies.validSessionResponse(status: 200, data: Data("{}".utf8)))
        let diagnostic: [String: Any] = ["state": "installed", "usedOrigin": 1, "usedConnection": 2,
            "channelConnected": true, "readyPosted": true, "connectMessages": 1, "parentSourceMatched": true,
            "parentTokenMatched": true, "parentOriginKind": "expected", "trustedInputCounter": 2, "composerCandidateCount": 1,
            "composerHasText": true, "composerFocused": true, "composerEditable": true, "sendDisabled": false,
            "composerPendingInput": true, "composerComposing": false,
            "errors": [["kind": "TypeError", "frames": ["/cdn/assets/async/637745.14f70978dc.js:12:34"]]]]
        precondition(ProviderRelayDiagnostics.validate(diagnostic) != nil)
        var unsafe = diagnostic; unsafe["message"] = "private raw error"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["connections"] = true; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["failures"] = 0.5; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["channelConnected"] = 1; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["readyPosted"] = "true"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["connectMessages"] = -1; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["trustedInputCounter"] = true; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["trustedInputCounter"] = -1; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["composerCandidateCount"] = "private editor text"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["composerHasText"] = "private draft text"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["composerFocused"] = 1; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["composerEditable"] = "true"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["sendDisabled"] = "false"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["composerPendingInput"] = "private draft"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["composerComposing"] = 1; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["parentOriginKind"] = "https://private.invalid/"; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["errors"] = [["kind": "Error", "frames": ["https://chatgpt.com/c/private-conversation"]]]; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        unsafe = diagnostic; unsafe["errors"] = [["kind": "Error", "frames": ["/cdn/assets/fixture-123.js?secret=private"]]]; precondition(ProviderRelayDiagnostics.validate(unsafe) == nil)
        print("Provider relay policy, exact parent, runtime deployment, module ordering, and minimal session checks passed")
    }
}
