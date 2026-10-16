import Foundation
import WebKit

/// Retains only this app's in-memory provider session. The extension owns page context.
final class EmbeddedSideChatController {
    static let shared = EmbeddedSideChatController()
    private var relay: ChatGPTProviderRelay?
    private var ownerToken: String?
    private var context: [String: Any]?
    private var parentOrigin: String?
    private var conversationURL = URL(string: "https://chatgpt.com/?surface=browser_side_chat")!
    private var initialized = false
    private var lastError: String?
    private var profileProbe: ProviderProfileDeploymentProbe?

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
                if let parentOrigin, parentOrigin != origin {
                    relay?.stop(); relay = nil; initialized = false
                }
                ownerToken = token; context = value; parentOrigin = origin
                if !isOpen { reply(["ok": true, "state": state()]); return }
                prepareRelay { result in
                    guard self.ownerToken == token else {
                        reply(["ok": false, "error": "The embedded side chat owner changed"]); return
                    }
                    switch result {
                    case .success: reply(["ok": true, "state": self.state()])
                    case .failure(let error):
                        self.lastError = error.localizedDescription
                        self.ownerToken = nil; self.context = nil
                        reply(["ok": false, "error": error.localizedDescription])
                    }
                }
            case "embeddedEntry":
                try requireOwner(command)
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
            case "embeddedAuth":
                try requireOwner(command)
                guard let value = command["state"] as? String,
                      ["expired", "logout_requested", "signed_in", "signed_out"].contains(value) else {
                    throw SideChatError("Invalid ChatGPT authentication state")
                }
                if value != "signed_in" { relay?.clearOwnSession() }
                reply(["ok": true])
            case "embeddedPoll":
                if ownerToken == nil { reply(["ok": true, "closed": true, "requests": [], "state": state()]); return }
                try requireOwner(command)
                reply(["ok": true, "requests": [], "state": state()])
            case "embeddedClose":
                if ownerToken != nil { try requireOwner(command) }
                ownerToken = nil; context = nil
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
    private func state() -> [String: Any] {
        var result: [String: Any] = ["visible": ownerToken != nil, "ownerAvailable": context != nil,
                                   "embedded": true, "relayReady": initialized]
        if let ownerToken { result["ownerToken"] = ownerToken }
        if let lastError { result["error"] = lastError }
        return result
    }
    private func prepareRelay(completion: @escaping (Result<Void, Error>) -> Void) {
        if initialized { completion(.success(())); return }
        do {
            guard let browserURL = Bundle.main.url(forResource: "ProviderBrowser", withExtension: "js"),
                  let hostURL = Bundle.main.url(forResource: "SideChatBridge", withExtension: "js"),
                  let parentOrigin else { throw SideChatError("The embedded ChatGPT resources are missing. Rebuild the app.") }
            let service = ChatGPTProviderRelay(browserShim: try Data(contentsOf: browserURL), sideChatHostScript: try Data(contentsOf: hostURL))
            relay = service
            service.start(parentExtensionOrigin: parentOrigin, conversationURL: conversationURL) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .failure(let error): completion(.failure(error))
                    case .success:
                        // Explicitly authorized exception: only this containing app's own profile,
                        // minimal verified HTTP-only session, memory only. Never Safari/Margina.
                        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
                            service.installOwnSessionCookies(cookies) { installed in
                                DispatchQueue.main.async {
                                    switch installed {
                                    case .success: self.initialized = true; self.lastError = nil; completion(.success(()))
                                    case .failure(let error): completion(.failure(error))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch { completion(.failure(error)) }
    }
    func stop() { relay?.stop(); relay = nil; initialized = false; context = nil; ownerToken = nil }
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
