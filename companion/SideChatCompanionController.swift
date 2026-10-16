import AppKit
import WebKit
import CoreFoundation

/// Owns the top-level ChatGPT view. The Safari extension remains the owner of tab data.
final class SideChatCompanionController: NSObject, WKScriptMessageHandlerWithReply,
                                         WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    static let shared = SideChatCompanionController()
    private var window: NSWindow?
    private var webView: WKWebView?
    private var statusLabel: NSTextField?
    private var waitingLabel: NSTextField?
    private var context: [String: Any]?
    private var ownerToken: String?
    private var capabilities: [String: Bool] = [:]
    private var requests: [[String: Any]] = []
    private var pending: [String: PendingReply] = [:]
    private var authWindows: [NSWindow] = []
    private var documentReady = false
    private var lastError: String?
    private var timer: Timer?
    private var promptPrefill: [String: Any]?
    private var authenticationInProgress = false
    private struct PendingReply {
        let deadline: Date
        let completion: (Any?, String?) -> Void
    }
    private static let allowedCapabilities: Set<String> = [
        "browserSideChat.openInBrowser", "browserSideChat.tabContext.read", "browserTabMentions.search",
    ]
    private static let siteURL = URL(string: "https://chatgpt.com/?surface=browser_side_chat")!

    func handle(command: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        precondition(Thread.isMainThread)
        do {
            guard let action = command["action"] as? String else { throw SideChatError("Missing companion action") }
            switch action {
            case "open", "update":
                guard let token = command["ownerToken"] as? String,
                      UUID(uuidString: token) != nil else { throw SideChatError("Invalid side chat owner token") }
                if action == "update", token != ownerToken {
                    throw SideChatError("The side chat owner changed")
                }
                var nextContext = context
                if let raw = command["context"] {
                    nextContext = raw is NSNull ? nil : try Self.validateContext(raw)
                }
                var nextCapabilities = capabilities
                if let raw = command["capabilities"] {
                    guard let supplied = raw as? [String: Any], supplied.count <= Self.allowedCapabilities.count,
                          Set(supplied.keys).isSubset(of: Self.allowedCapabilities) else {
                        throw SideChatError("Invalid side chat capabilities")
                    }
                    var next: [String: Bool] = [:]
                    for (key, value) in supplied {
                        guard let number = value as? NSNumber,
                              CFGetTypeID(number) == CFBooleanGetTypeID() else {
                            throw SideChatError("A side chat capability must be a boolean")
                        }
                        if number.boolValue { next[key] = true }
                    }
                    nextCapabilities = next
                }
                let nextPrompt = try command["promptPrefill"].map(Self.validatePromptPrefill)
                if token != ownerToken {
                    cancelPending("The side chat owner changed")
                    ownerToken = token
                }
                context = nextContext
                capabilities = nextCapabilities
                if action == "open" { show() }
                updateOwner()
                if let nextPrompt {
                    promptPrefill = nextPrompt
                    deliverPromptPrefill()
                }
                if action == "open", let bounds = command["bounds"] as? [String: Any] { applyAnchor(bounds) }
                reply(["ok": true, "state": state()])
            case "close":
                if ownerToken == nil, window?.isVisible != true {
                    reply(["ok": true]); return
                }
                guard command["ownerToken"] as? String == ownerToken, ownerToken != nil else {
                    throw SideChatError("The side chat owner changed")
                }
                window?.close()
                reply(["ok": true])
            case "status":
                guard let webView, documentReady, Self.isChatGPTURL(webView.url) else {
                    reply(["ok": true, "state": state()]); return
                }
                let diagnosticScript = """
                const body = document.body;
                const style = body ? getComputedStyle(body) : null;
                return {
                  bridge: window.__CHATGPT_SAFARI_SIDECAR__?.diagnostics() ?? null,
                  document: {
                    bodyChildCount: body?.childElementCount ?? 0,
                    bodyTextLength: body?.textContent?.length ?? 0,
                    readyState: document.readyState,
                    visibilityState: document.visibilityState,
                    bodyDisplay: style?.display ?? null,
                    bodyVisibility: style?.visibility ?? null,
                    bodyOpacity: style?.opacity ?? null,
                    viewportWidth: innerWidth, viewportHeight: innerHeight,
                  },
                };
                """
                webView.callAsyncJavaScript(diagnosticScript,
                                           arguments: [:], in: nil, in: .page) { result in
                    var status = self.state()
                    if case .success(let diagnostics) = result, let values = diagnostics as? [String: Any] {
                        status["bridge"] = values["bridge"]
                        status["document"] = values["document"]
                    }
                    reply(["ok": true, "state": status])
                }
            case "poll":
                if ownerToken == nil, window?.isVisible != true {
                    reply(["ok": true, "closed": true, "requests": [], "state": state()]); return
                }
                guard command["ownerToken"] as? String == ownerToken, ownerToken != nil else {
                    throw SideChatError("The side chat owner changed")
                }
                expireRequests()
                let batch = requests
                requests.removeAll()
                reply(["ok": true, "requests": batch, "state": state()])
            case "resolve":
                guard command["ownerToken"] as? String == ownerToken, ownerToken != nil else {
                    throw SideChatError("The side chat owner changed")
                }
                guard let id = command["id"] as? String, id.count <= 128,
                      let request = pending.removeValue(forKey: id) else {
                    throw SideChatError("Unknown or expired side chat request")
                }
                requests.removeAll { $0["id"] as? String == id }
                if let error = command["error"] {
                    let message = (error as? String) ?? (error as? [String: Any])?["message"] as? String
                    request.completion(nil, String((message ?? "The Safari extension rejected the request").prefix(1024)))
                } else if let result = command["result"] as? [String: Any] {
                    request.completion(result, nil)
                } else {
                    request.completion(nil, "Invalid side chat reply")
                    throw SideChatError("Invalid side chat reply")
                }
                reply(["ok": true])
            default:
                throw SideChatError("Unknown side chat companion action")
            }
        } catch {
            reply(["ok": false, "error": error.localizedDescription])
        }
    }

    func show() {
        precondition(Thread.isMainThread)
        if window == nil { createWindow() }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateOwner()
    }

    private func createWindow() {
        let frame = NSScreen.main?.visibleFrame ?? NSRect(x: 100, y: 100, width: 1280, height: 800)
        let size = NSSize(width: min(460, frame.width), height: max(460, frame.height - 48))
        let panel = NSWindow(contentRect: NSRect(x: frame.maxX - size.width - 12, y: frame.minY + 24,
                                                 width: size.width, height: size.height),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable],
                             backing: .buffered, defer: false)
        panel.title = "ChatGPT — Safari Side Chat"
        panel.minSize = NSSize(width: 360, height: 420)
        panel.isReleasedWhenClosed = false
        panel.delegate = self
        panel.identifier = NSUserInterfaceItemIdentifier("ChatGPTSafariSideChat")
        let root = NSView()
        panel.contentView = root
        let header = NSTextField(labelWithString: "Waiting for a Safari tab…")
        header.font = .systemFont(ofSize: 12)
        header.textColor = .secondaryLabelColor
        header.lineBreakMode = .byTruncatingMiddle
        header.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(header)
        let reload = NSButton(title: "Reload", target: self, action: #selector(reloadSideChat))
        reload.bezelStyle = .inline
        reload.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(reload)
        let waiting = NSTextField(wrappingLabelWithString: "Open side chat from the ChatGPT button in Safari.")
        waiting.alignment = .center
        waiting.textColor = .secondaryLabelColor
        waiting.font = .systemFont(ofSize: 14)
        waiting.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(waiting)
        let config = WKWebViewConfiguration()
        // A persistent app-owned profile; Safari cookies are never imported or exported.
        config.websiteDataStore = .default()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chatgptSidechat")
        if let scriptURL = Bundle.main.url(forResource: "SideChatBridge", withExtension: "js"),
           let source = try? String(contentsOf: scriptURL, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: source,
                injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        } else {
            lastError = "The native side chat bridge resource is missing. Rebuild the app."
        }
        let view = WKWebView(frame: .zero, configuration: config)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.navigationDelegate = self
        view.uiDelegate = self
        view.isHidden = true
        root.addSubview(view)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            header.trailingAnchor.constraint(equalTo: reload.leadingAnchor, constant: -8),
            header.heightAnchor.constraint(equalToConstant: 22),
            reload.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            reload.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            reload.widthAnchor.constraint(equalToConstant: 52),
            view.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 6),
            view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            view.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            waiting.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            waiting.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
            waiting.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
        ])
        self.window = panel
        self.webView = view
        self.statusLabel = header
        self.waitingLabel = waiting
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.expireRequests() }
    }

    private func updateOwner() {
        if let lastError {
            statusLabel?.stringValue = "ChatGPT could not load"
            waitingLabel?.stringValue = lastError
            waitingLabel?.isHidden = false
            webView?.isHidden = true
        } else if context == nil {
            statusLabel?.stringValue = "Waiting for a Safari tab…"
            waitingLabel?.stringValue = "Open side chat from the ChatGPT button in Safari."
            waitingLabel?.isHidden = false
            webView?.isHidden = true
        } else {
            statusLabel?.stringValue = (context?["url"] as? String).flatMap(URL.init(string:))?.host ?? "Safari tab"
            waitingLabel?.isHidden = true
            webView?.isHidden = false
            if let webView, webView.url == nil, lastError == nil {
                webView.load(URLRequest(url: Self.siteURL))
            }
        }
        sendToPage(["type": "browser_side_chat_context_invalidated", "protocolVersion": 2])
        sendToPage(capabilitiesReply())
    }

    @objc private func reloadSideChat() {
        guard context != nil, let webView else { return }
        let destination = documentReady ? Self.sideChatURL(for: webView.url) : nil
        lastError = nil
        documentReady = false
        cancelPending("Side chat is reloading")
        webView.load(URLRequest(url: destination ?? Self.siteURL))
        updateOwner()
    }

    private func capabilitiesReply() -> [String: Any] {
        ["type": "browser_side_chat_capabilities", "browserContext": ["instanceId": context?["instanceId"] ?? NSNull()],
         "capabilities": context == nil ? [:] : capabilities]
    }

    private func state() -> [String: Any] {
        var result: [String: Any] = ["visible": window?.isVisible ?? false,
            "ownerAvailable": context != nil, "documentReady": documentReady,
            "pendingRequests": pending.count, "url": webView?.url?.absoluteString ?? "",
            "appActive": NSApp?.isActive ?? false, "appHidden": NSApp?.isHidden ?? false,
            "windowKey": window?.isKeyWindow ?? false, "windowMain": window?.isMainWindow ?? false,
            "windowOcclusionVisible": window?.occlusionState.contains(.visible) ?? false]
        if let lastError { result["error"] = lastError }
        if let ownerToken { result["ownerToken"] = ownerToken }
        if let webView {
            result["nativeView"] = [
                "hidden": webView.isHidden,
                "hiddenAncestor": webView.isHiddenOrHasHiddenAncestor,
                "alpha": webView.alphaValue,
                "frame": Self.rect(webView.frame), "bounds": Self.rect(webView.bounds),
                "attachedToWindow": webView.window === window,
                "ambiguousLayout": webView.hasAmbiguousLayout,
                "isLoading": webView.isLoading, "estimatedProgress": webView.estimatedProgress,
                "rootFrame": Self.rect(window?.contentView?.frame ?? .zero),
                "rootBounds": Self.rect(window?.contentView?.bounds ?? .zero),
                "rootHidden": window?.contentView?.isHidden ?? false,
            ]
        }
        return result
    }

    private static func rect(_ value: NSRect) -> [String: Double] {
        ["x": value.origin.x, "y": value.origin.y, "width": value.width, "height": value.height]
    }

    private func applyAnchor(_ bounds: [String: Any]) {
        guard let left = bounds["left"] as? Double, let top = bounds["top"] as? Double,
              let width = bounds["width"] as? Double, let height = bounds["height"] as? Double,
              [left, top, width, height].allSatisfy({ $0.isFinite && abs($0) < 100_000 }),
              width >= 360, height >= 420, let window,
              let primary = NSScreen.screens.first else { return }
        // Safari window coordinates start at the primary screen's top-left.
        let browser = NSRect(x: left, y: primary.frame.maxY - top - height, width: width, height: height)
        let screen = NSScreen.screens.max { a, b in
            let ra = a.frame.intersection(browser), rb = b.frame.intersection(browser)
            return ra.width * ra.height < rb.width * rb.height
        } ?? primary
        let available = screen.visibleFrame
        let panelWidth = min(window.frame.width, available.width)
        let panelHeight = min(max(height, 420), available.height)
        let outsideRight = browser.maxX + 8
        let x = outsideRight + panelWidth <= available.maxX ? outsideRight : browser.maxX - panelWidth
        let safeX = min(max(x, available.minX), available.maxX - panelWidth)
        let safeY = min(max(browser.maxY - panelHeight, available.minY), available.maxY - panelHeight)
        window.setFrame(NSRect(x: safeX, y: safeY, width: panelWidth, height: panelHeight), display: true)
    }

    private func deliverPromptPrefill() {
        guard documentReady, let payload = promptPrefill else { return }
        promptPrefill = nil
        sendToPage(payload)
    }

    private func sendToPage(_ payload: [String: Any]) {
        guard let webView, documentReady, Self.isChatGPTURL(webView.url) else { return }
        webView.callAsyncJavaScript("window.__CHATGPT_SAFARI_SIDECAR__?.receive(payload)",
                                   arguments: ["payload": payload], in: nil, in: .page) { _ in }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.webView === webView,
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.host == "chatgpt.com",
              Self.isChatGPTURL(message.frameInfo.request.url),
              documentReady || Self.isSideChatURL(message.frameInfo.request.url),
              let body = message.body as? [String: Any], let method = body["method"] as? String,
              let params = body["params"] as? [String: Any] else {
            replyHandler(nil, "The message is not from the top-level ChatGPT side chat"); return
        }
        if method == "capabilities" {
            replyHandler(capabilitiesReply(), nil); return
        }
        guard context != nil else { replyHandler(nil, "No Safari owner tab is available"); return }
        let methods: Set<String> = ["context", "tabContext", "tabMentions", "openInBrowser", "locationChanged", "authStateChanged"]
        guard methods.contains(method), pending.count < 100,
              let data = try? JSONSerialization.data(withJSONObject: params), data.count <= 96_000 else {
            replyHandler(nil, "Unsupported or excessive side chat request"); return
        }
        if method == "openInBrowser" || method == "locationChanged" {
            guard let value = params["url"] as? String, let url = URL(string: value),
                  url.scheme == "https", url.host == "chatgpt.com", url.user == nil, url.password == nil else {
                replyHandler(nil, "The requested ChatGPT URL is invalid"); return
            }
        }
        let id = UUID().uuidString
        pending[id] = PendingReply(deadline: Date().addingTimeInterval(15), completion: replyHandler)
        requests.append(["id": id, "method": method, "params": params, "ownerToken": ownerToken!])
    }

    private func expireRequests() {
        let expired = pending.filter { $0.value.deadline <= Date() }
        for (id, request) in expired {
            pending.removeValue(forKey: id)
            request.completion(nil, "The Safari extension did not answer the side chat request")
        }
        requests.removeAll { item in expired[item["id"] as? String ?? ""] != nil }
    }

    func windowWillClose(_ notification: Notification) {
        if let closed = notification.object as? NSWindow,
           authWindows.contains(where: { $0 === closed }) {
            authWindows.removeAll { $0 === closed }
            return
        }
        guard notification.object as? NSWindow === window else { return }
        cancelPending("Side chat was closed")
        context = nil
        ownerToken = nil
        promptPrefill = nil
        capabilities = [:]
        updateOwner()
    }

    private func cancelPending(_ error: String) {
        let callbacks = Array(pending.values)
        pending.removeAll()
        requests.removeAll()
        for request in callbacks { request.completion(nil, error) }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        if webView === self.webView {
            documentReady = false
            lastError = nil
            cancelPending("The ChatGPT document changed")
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === self.webView {
            if authenticationInProgress, let url = webView.url, url.scheme == "https", url.host == "chatgpt.com",
               url.path == "/", !Self.isSideChatURL(url) {
                authenticationInProgress = false
                webView.load(URLRequest(url: Self.siteURL))
                return
            }
            documentReady = Self.isSideChatURL(webView.url)
            sendToPage(capabilitiesReply())
            deliverPromptPrefill()
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if webView === self.webView { lastError = error.localizedDescription; updateOwner() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        if webView === self.webView { lastError = error.localizedDescription; updateOwner() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === self.webView {
            documentReady = false
            lastError = "The ChatGPT web process ended. Close and reopen side chat."
            updateOwner()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "https" || url.scheme == "http" {
            if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
            if webView === self.webView, documentReady, Self.isConversationURL(url), !Self.isSideChatURL(url),
               let destination = Self.sideChatURL(for: url) {
                // A full conversation navigation starts a new document; retain the explicit side-chat surface.
                webView.load(URLRequest(url: destination))
                decisionHandler(.cancel)
                return
            }
            // Authentication stays in this app-owned WebKit profile, including provider redirects.
            if Self.isAuthenticationURL(url) {
                if url.host != "chatgpt.com" || url.path.hasPrefix("/auth/") { authenticationInProgress = true }
                decisionHandler(.allow); return
            }
            if navigationAction.navigationType == .linkActivated {
                NSWorkspace.shared.open(url)
            }
        } else if url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url, Self.isAuthenticationURL(url) else {
            if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") {
                NSWorkspace.shared.open(url)
            }
            return nil
        }
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 520, height: 700), configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
        let auth = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        auth.title = "Sign in to ChatGPT"
        auth.isReleasedWhenClosed = false
        auth.delegate = self
        auth.contentView = view
        auth.center()
        auth.makeKeyAndOrderFront(nil)
        authWindows.append(auth)
        return view
    }
    func webViewDidClose(_ webView: WKWebView) {
        if let auth = authWindows.first(where: { $0.contentView === webView }) {
            auth.close()
            authWindows.removeAll { $0 === auth }
        }
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard frame.isMainFrame, origin.protocol == "https", origin.host == "chatgpt.com",
              Self.isChatGPTURL(frame.request.url), documentReady, webView === self.webView else {
            decisionHandler(.deny); return
        }
        decisionHandler(.prompt)
    }

    static func isSideChatURL(_ url: URL?) -> Bool {
        guard let url, isChatGPTURL(url) else { return false }
        return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "surface" })?.value == "browser_side_chat"
    }
    private static func isChatGPTURL(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == "chatgpt.com" && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
    }
    private static func isConversationURL(_ url: URL) -> Bool {
        guard isChatGPTURL(url) else { return false }
        let components = url.path.split(separator: "/")
        return components.count == 2 && ["c", "uc"].contains(String(components[0]))
            && UUID(uuidString: String(components[1])) != nil
    }
    private static func sideChatURL(for url: URL?) -> URL? {
        guard let url, isChatGPTURL(url), url.path == "/" || isConversationURL(url),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        var query = components.queryItems?.filter { $0.name != "surface" } ?? []
        query.append(URLQueryItem(name: "surface", value: "browser_side_chat"))
        components.queryItems = query
        return components.url
    }
    private static func isAuthenticationURL(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil, let host = url.host else { return false }
        return ["chatgpt.com", "auth.openai.com", "auth0.openai.com", "platform.openai.com", "accounts.google.com",
                "appleid.apple.com", "appleid.apple.com.cn", "login.microsoftonline.com", "login.live.com"].contains(host)
    }
    static func validateContext(_ value: Any) throws -> [String: Any] {
        guard let value = value as? [String: Any],
              Set(value.keys).isSubset(of: ["instanceId", "tabId", "windowId", "url", "selectedText", "selectionId"]),
              let instance = value["instanceId"] as? String, !instance.isEmpty, instance.count <= 128,
              validInteger(value["tabId"]), validInteger(value["windowId"]) else {
            throw SideChatError("Invalid Safari side chat context")
        }
        if let url = value["url"], !(url is NSNull) {
            guard let text = url as? String, text.count <= 16384, let parsed = URL(string: text),
                  ["http", "https"].contains(parsed.scheme ?? ""), parsed.host != nil,
                  parsed.user == nil, parsed.password == nil else { throw SideChatError("Invalid Safari owner URL") }
        }
        if let selection = value["selectedText"], !(selection is NSNull) {
            guard let text = selection as? String, text.count <= 80000 else { throw SideChatError("Invalid Safari selected text") }
        }
        if let selectionID = value["selectionId"], !(selectionID is NSNull) {
            guard let text = selectionID as? String, text.count <= 1024 else { throw SideChatError("Invalid Safari selection identifier") }
        }
        return value
    }
    private static func validInteger(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        let double = number.doubleValue
        return double.isFinite && double >= 0 && double <= 9007199254740991 && double.rounded() == double
    }
    static func validatePromptPrefill(_ value: Any) throws -> [String: Any] {
        guard let value = value as? [String: Any], Set(value.keys).isSubset(of: ["prompt", "selectedText", "createdAtMs"]) else {
            throw SideChatError("Invalid side chat prompt prefill")
        }
        for (key, limit) in [("prompt", 8192), ("selectedText", 80000)] {
            if let field = value[key] {
                guard let text = field as? String, text.count <= limit else { throw SideChatError("Invalid side chat prompt prefill") }
            }
        }
        var payload = value
        payload["type"] = "browser_side_chat_prompt_prefill"
        payload["createdAtMs"] = Date().timeIntervalSince1970 * 1000
        return payload
    }
}

struct SideChatError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
