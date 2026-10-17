import Foundation
import WebKit

/// Retains only this app's in-memory provider session. The extension owns page context.
final class EmbeddedSideChatController {
    static let shared = EmbeddedSideChatController()
    private var relay: ChatGPTProviderRelay?
    private var ownerToken: String?
    private var context: [String: Any]?
    private var parentOrigin: String?
    private var liveProfileId: String?
    private var authorizationEpoch = UUID()
    private var agentCommands: [String: Int] = [:]
    private var cloudTunnel: [String: Any] = [:]
    var liveCommand: (([String: Any], @escaping ([String: Any]) -> Void) -> Void)?
    var cancelAgentCommands: ((String) -> Void)?
    var kernelEntry: ((String) throws -> String)?
    private var conversationURL = URL(string: "https://chatgpt.com/?surface=browser_side_chat")!
    private var initialized = false
    private var authenticationState: String?
    private var preparation = UUID()
    private var preparing = false
    private var lastError: String?
    private var profileProbe: ProviderProfileDeploymentProbe?
    private let relayResources: () throws -> (Data, Data)
    private let installProfileSession: (ChatGPTProviderRelay, @escaping (Result<Void, Error>) -> Void) -> Void
    private let openAuthentication: (Bool) -> Void

    init(relayResources: @escaping () throws -> (Data, Data) = {
        guard let browserURL = Bundle.main.url(forResource: "ProviderBrowser", withExtension: "js"),
              let hostURL = Bundle.main.url(forResource: "SideChatBridge", withExtension: "js") else {
            throw SideChatError("The embedded ChatGPT resources are missing. Rebuild the app.")
        }
        return (try Data(contentsOf: browserURL), try Data(contentsOf: hostURL))
    }, installProfileSession: @escaping (ChatGPTProviderRelay, @escaping (Result<Void, Error>) -> Void) -> Void = { service, completion in
        // Explicitly authorized: only this app's own profile, minimum session,
        // official validation, memory only. Never Safari or Margina stores.
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            service.installOwnSessionCookies(cookies, completion: completion)
        }
    }, openAuthentication: @escaping (Bool) -> Void = { logout in
        SideChatCompanionController.shared.showAuthentication(logout: logout)
    }) {
        self.relayResources = relayResources
        self.installProfileSession = installProfileSession
        self.openAuthentication = openAuthentication
    }

    func handle(command: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        precondition(Thread.isMainThread)
        do {
            switch command["action"] as? String {
            case "embeddedProfileDeployment":
                guard profileProbe == nil else { throw SideChatError("The app-profile deployment check is already running") }
                let probe = ProviderProfileDeploymentProbe()
                profileProbe = probe
                probe.start { result in
                    self.profileProbe = nil
                    reply(result)
                }
            case "embeddedStatus":
                let current = state()
                if let relay {
                    relay.status { diagnostics in
                        var value = current; value["relay"] = diagnostics
                        reply(["ok": true, "state": value])
                    }
                } else { reply(["ok": true, "state": current]) }
            case "embeddedOpen", "embeddedUpdate":
                let token = try validateOwner(command)
                let isOpen = command["action"] as? String == "embeddedOpen"
                if !isOpen && ownerToken != token { throw SideChatError("The embedded side chat owner changed") }
                guard let origin = command["parentExtensionOrigin"] as? String,
                      let url = URL(string: origin), url.scheme == "safari-web-extension", url.host != nil,
                      url.user == nil, url.password == nil, url.port == nil,
                      url.path.isEmpty, url.query == nil, url.fragment == nil else {
                    throw SideChatError("The embedded side chat has an invalid extension origin")
                }
                let value = try SideChatCompanionController.validateContext(command["context"] as Any)
                if let profile = command["liveProfileId"] as? String {
                    guard UUID(uuidString: profile) != nil else { throw SideChatError("Invalid Safari browser profile") }
                    liveProfileId = profile
                }
                if let parentOrigin, parentOrigin != origin {
                    relay?.stop(); relay = nil; initialized = false
                }
                if let previous = ownerToken, previous != token {
                    authorizationEpoch = UUID()
                    cancelAgentCommands?(previous)
                    cancelPreparation()
                }
                ownerToken = token; context = value; parentOrigin = origin
                if !isOpen { reply(["ok": true, "state": state()]); return }
                if authenticationState != nil { reply(["ok": true, "state": state()]); return }
                prepareRelay { result in
                    guard self.ownerToken == token else {
                        reply(["ok": false, "error": "The embedded side chat owner changed"]); return
                    }
                    switch result {
                    case .success: reply(["ok": true, "state": self.state()])
                    case .failure(let error):
                        if Self.requiresAuthentication(error) {
                            self.authenticationState = "signed_out"
                            reply(["ok": true, "state": self.state()])
                        } else {
                            self.lastError = error.localizedDescription
                            reply(["ok": false, "error": error.localizedDescription])
                        }
                    }
                }
            case "embeddedEntry":
                try requireOwner(command)
                if let authenticationState {
                    reply(["ok": true, "entry": ["authentication": ["state": authenticationState]]]); return
                }
                guard let relay, initialized else { throw SideChatError("The ChatGPT provider is not ready") }
                relay.entry(conversationURL: conversationURL) { result in
                    DispatchQueue.main.async {
                        guard command["ownerToken"] as? String == self.ownerToken else {
                            reply(["ok": false, "error": "The embedded side chat owner changed"]); return
                        }
                        switch result {
                        case .success(let entry): reply(["ok": true, "entry": entry.dictionary])
                        case .failure(let error): reply(["ok": false, "error": error.localizedDescription])
                        }
                    }
                }
            case "embeddedLocation":
                try requireOwner(command)
                guard let value = command["url"] as? String, let url = URL(string: value),
                      url.scheme == "https", url.host == "chatgpt.com", url.user == nil, url.password == nil,
                      url.port == nil || url.port == 443 else { throw SideChatError("Invalid ChatGPT conversation URL") }
                conversationURL = url
                reply(["ok": true])
            case "embeddedBrowserSession":
                try requireOwner(command)
                if authenticationState != nil || !initialized { reply(["ok": true, "session": NSNull()]); return }
                guard let relay, initialized else { throw SideChatError("The ChatGPT provider is not ready") }
                let token = ownerToken
                relay.readBrowserSession { result in
                    guard token == self.ownerToken else {
                        reply(["ok": false, "error": "The embedded side chat owner changed"]); return
                    }
                    switch result {
                    case .success(let session): reply(["ok": true, "session": session])
                    case .failure: reply(["ok": false, "error": "The app-owned ChatGPT browser session could not be verified"])
                    }
                }
            case "embeddedKernel":
                try requireOwner(command)
                guard let parentOrigin, let kernelEntry else { throw SideChatError("The Safari kernel host is unavailable") }
                reply(["ok": true, "url": try kernelEntry(parentOrigin)])
            case "embeddedLive":
                try requireOwner(command)
                guard let profile = liveProfileId, command["profileId"] as? String == profile,
                      let request = command["command"] as? [String: Any],
                      let action = request["action"] as? String,
                      ["read_page", "interact", "navigate", "history", "select_tab", "close_tab", "organize", "download_link_inspect", "download_link", "dom_query", "screenshot", "dialog", "asset_bundle", "content_export", "create_tab", "filechooser", "viewport"].contains(action),
                      let args = request["arguments"] as? [String: Any],
                      (action == "create_tab" ? args["profileId"] as? String == profile
                        : (args["handle"] as? String).flatMap(SafariLiveBroker.profile(from:)) == profile),
                      let liveCommand else { throw SideChatError("The side-chat browser command has no matching Safari profile") }
                agentCommands[action, default: 0] += 1
                liveCommand(["action": "live", "command": request, "agentOwner": ownerToken!], reply)
            case "embeddedAuth":
                try requireOwner(command)
                if let operation = command["authOperation"] as? String {
                    guard ["open", "resume", "logout"].contains(operation), command["state"] == nil else {
                        throw SideChatError("Invalid ChatGPT authentication operation")
                    }
                    if operation != "resume" {
                        if operation == "logout" {
                            authorizationEpoch = UUID()
                            if let ownerToken { cancelAgentCommands?(ownerToken) }
                            cancelPreparation()
                            relay?.clearOwnSession()
                            initialized = false
                            authenticationState = "logout_requested"
                        }
                        openAuthentication(operation == "logout")
                        reply(["ok": true, "authentication": ["state": authenticationState ?? "signed_out"]]); return
                    }
                    guard !preparing else { throw SideChatError("The app-owned ChatGPT login is already being checked") }
                    authorizationEpoch = UUID()
                    let token = ownerToken
                    initialized = false
                    prepareRelay { result in
                        guard token == self.ownerToken else {
                            reply(["ok": false, "error": "The embedded side chat owner changed"]); return
                        }
                        switch result {
                        case .success: reply(["ok": true])
                        case .failure(let error):
                            if Self.requiresAuthentication(error) {
                                self.authenticationState = "signed_out"
                                reply(["ok": false, "error": "Sign in in the app window, then choose Continue."])
                            } else { reply(["ok": false, "error": error.localizedDescription]) }
                        }
                    }
                    return
                }
                guard let value = command["state"] as? String,
                      ["expired", "logout_requested", "signed_in", "signed_out"].contains(value) else {
                    throw SideChatError("Invalid ChatGPT authentication state")
                }
                if value != "signed_in" {
                    authorizationEpoch = UUID()
                    if let ownerToken { cancelAgentCommands?(ownerToken) }
                    cancelPreparation()
                    relay?.clearOwnSession()
                    initialized = false
                    authenticationState = value
                }
                reply(["ok": true, "authentication": authenticationState.map { ["state": $0] as Any } ?? NSNull()])
            case "embeddedPoll":
                if ownerToken == nil { reply(["ok": true, "closed": true, "requests": [], "state": state()]); return }
                try requireOwner(command)
                if let status = command["cloudTunnel"] as? [String: Any] { cloudTunnel = Self.safeTunnelStatus(status) }
                let current = state(), token = ownerToken, epoch = authorizationEpoch
                if let relay, initialized, authenticationState == nil {
                    relay.readDocumentRecoverySequence { sequence in
                        guard self.ownerToken == token, self.authorizationEpoch == epoch else {
                            reply(["ok": false, "error": "The embedded side chat owner changed"]); return
                        }
                        reply(["ok": true, "requests": [], "state": current, "documentRecoverySequence": sequence])
                    }
                } else { reply(["ok": true, "requests": [], "state": current]) }
            case "embeddedClose":
                if ownerToken != nil { try requireOwner(command) }
                if let ownerToken { cancelAgentCommands?(ownerToken) }
                cancelPreparation()
                ownerToken = nil; context = nil; liveProfileId = nil
                reply(["ok": true])
            default: throw SideChatError("Unknown embedded side chat command")
            }
        } catch { reply(["ok": false, "error": error.localizedDescription]) }
    }

    private func validateOwner(_ command: [String: Any]) throws -> String {
        guard let token = command["ownerToken"] as? String, UUID(uuidString: token) != nil else {
            throw SideChatError("Invalid embedded side chat owner")
        }
        return token
    }
    private func requireOwner(_ command: [String: Any]) throws {
        guard ownerToken != nil, command["ownerToken"] as? String == ownerToken else {
            throw SideChatError("The embedded side chat owner changed")
        }
    }
    func authorization(owner: String, profile: String) -> UUID? {
        precondition(Thread.isMainThread)
        guard ownerToken == owner, liveProfileId == profile, initialized, authenticationState == nil else { return nil }
        return authorizationEpoch
    }
    private func state() -> [String: Any] {
        var result: [String: Any] = ["visible": ownerToken != nil, "ownerAvailable": context != nil,
                                   "embedded": true, "relayReady": initialized, "agentCommands": agentCommands, "cloudTunnel": cloudTunnel]
        if let ownerToken { result["ownerToken"] = ownerToken }
        if let lastError { result["error"] = lastError }
        if let authenticationState { result["authentication"] = ["state": authenticationState] }
        return result
    }
    private func prepareRelay(completion: @escaping (Result<Void, Error>) -> Void) {
        if initialized { completion(.success(())); return }
        let operation = UUID()
        preparation = operation
        preparing = true
        do {
            guard let parentOrigin else { throw SideChatError("The embedded side chat has no extension origin") }
            let finish: (Result<Void, Error>) -> Void = { result in
                guard self.preparation == operation else { completion(.failure(ProviderRelayError.sessionChanged)); return }
                self.preparing = false
                if case .success = result { self.initialized = true; self.authenticationState = nil; self.lastError = nil }
                completion(result)
            }
            if let relay { installProfileSession(relay, finish); return }
            let (browser, host) = try relayResources()
            let service = ChatGPTProviderRelay(browserShim: browser, sideChatHostScript: host)
            relay = service
            service.start(parentExtensionOrigin: parentOrigin, conversationURL: conversationURL) { result in
                DispatchQueue.main.async {
                    guard self.preparation == operation, self.relay === service else {
                        completion(.failure(ProviderRelayError.sessionChanged)); return
                    }
                    switch result {
                    case .failure(let error): finish(.failure(error))
                    case .success: self.installProfileSession(service, finish)
                    }
                }
            }
        } catch { preparing = false; completion(.failure(error)) }
    }
    private func cancelPreparation() {
        preparation = UUID()
        if preparing { relay?.clearOwnSession(); initialized = false }
        preparing = false
    }
    private static func requiresAuthentication(_ error: Error) -> Bool {
        guard let error = error as? ProviderRelayError else { return false }
        switch error {
        case .missingSession, .invalidSession, .ambiguousSession, .sessionUnconfirmed, .invalidBrowserSession: return true
        default: return false
        }
    }
    private static func safeTunnelStatus(_ source: [String: Any]) -> [String: Any] {
        var result: [String: Any] = [:]
        for key in ["kernelGate", "running", "registered"] { if let value = source[key] as? Bool { result[key] = value } }
        if let kernel = source["kernel"] as? [String: Any] {
            var value: [String: Any] = [:]
            if let phase = kernel["phase"] as? String,
               ["idle", "preparing", "host_loaded", "sent", "executing", "ready", "failed"].contains(phase) { value["phase"] = phase }
            for key in ["requests", "replies", "failures", "connections"] {
                if let count = kernel[key] as? Int, (0...1_000_000).contains(count) { value[key] = count }
            }
            result["kernel"] = value
        }
        let fields: [String: [String: Set<String>]] = [
            "setup": ["trigger": ["startup", "navigation", "retry", "unauthorized", "invalid_tunnel", "app_session", "unknown"],
                      "stage": ["session", "session_decode", "read_configuration", "create_tunnel", "save_registration", "configure_polling", "start_polling", "unknown"],
                      "outcome": ["created", "refreshed", "unchanged", "invalid_session", "failed", "unknown"]],
            "polling": ["state": ["connected", "failed", "offline", "stopped", "recovered", "unknown"],
                        "reason": ["http", "network", "invalid_response", "unknown"]]
        ]
        for (section, allowed) in fields {
            guard let input = source[section] as? [String: Any] else { continue }
            var value: [String: Any] = [:]
            for (key, choices) in allowed { if let text = input[key] as? String, choices.contains(text) { value[key] = text } }
            if let status = input["httpStatus"] as? Int, (100...599).contains(status) { value["httpStatus"] = status }
            result[section] = value
        }
        return result
    }
    func stop() {
        if let ownerToken { cancelAgentCommands?(ownerToken) }
        cancelPreparation()
        relay?.stop(); relay = nil; initialized = false; context = nil; ownerToken = nil; liveProfileId = nil
        authenticationState = nil
    }
}

/// A fixed, read-only deployment check using this app's actual WebKit request identity.
/// Returns public asset paths and user agent only, never page text, HTML, or cookies.
private final class ProviderProfileDeploymentProbe: NSObject, WKNavigationDelegate {
    private var view: WKWebView?
    private var timeout: Timer?
    private var completion: (([String: Any]) -> Void)?
    func start(completion: @escaping ([String: Any]) -> Void) {
        self.completion = completion
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 800, height: 800), configuration: config)
        self.view = view
        view.navigationDelegate = self
        timeout = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            self?.finish(["ok": false, "error": "The app-profile deployment check timed out"])
        }
        view.load(URLRequest(url: URL(string: "https://chatgpt.com/?surface=browser_side_chat")!, cachePolicy: .reloadIgnoringLocalCacheData))
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.scheme == "https", webView.url?.host == "chatgpt.com" else {
            finish(["ok": false, "error": "The app profile did not load ChatGPT"]); return
        }
        webView.callAsyncJavaScript("""
        const assets = new Set();
        for (const element of document.querySelectorAll('script[src],link[href]')) {
          try {
            const u = new URL(element.src || element.href, location.href);
            if (u.origin === 'https://chatgpt.com' && /^\\/cdn\\/assets\\/[^/]+\\.js$/.test(u.pathname)
              && !u.search && !u.hash) assets.add(u.pathname);
          } catch {}
        }
        return { assets: [...assets].sort().slice(0, 100), userAgent: navigator.userAgent };
        """, arguments: [:], in: nil, in: .page) { result in
            switch result {
            case .success(let value): self.finish(["ok": true, "deployment": value])
            case .failure: self.finish(["ok": false, "error": "The app-profile deployment inventory was unavailable"])
            }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(["ok": false, "error": "The app-profile deployment navigation failed"])
    }
    private func finish(_ result: [String: Any]) {
        guard let completion else { return }
        self.completion = nil; timeout?.invalidate(); timeout = nil
        view?.navigationDelegate = nil; view?.stopLoading(); view = nil
        completion(result)
    }
}
