import Foundation

struct ChatGPTProviderRelayEntry {
    let providerURL: String
    let providerOrigin: String
    let parentExtensionOrigin: String
    let bridgeToken: String
    let accountScope: String
    let phase: String
    var dictionary: [String: Any] {
        ["providerURL": providerURL, "providerOrigin": providerOrigin,
         "parentExtensionOrigin": parentExtensionOrigin, "bridgeToken": bridgeToken,
         "accountScope": accountScope, "phase": phase]
    }
}

/// Owns a provider-only, in-memory account session. No WebKit store or MCP API is accessible here.
final class ChatGPTProviderRelay {
    private let browserShim: Data
    private let sideChatHostScript: Data
    private var server: ProviderRelayServer?
    private var sessionOperation = UUID()

    init(browserShim: Data, sideChatHostScript: Data) {
        self.browserShim = browserShim
        self.sideChatHostScript = sideChatHostScript
    }

    deinit {
        let engine = server
        providerRelayQueue.async { engine?.stop() }
    }

    /// Starting anonymously never reads or imports a cookie. Only the explicit native API below can install one.
    func start(parentExtensionOrigin: String, conversationURL: URL,
               completion: @escaping (Result<ChatGPTProviderRelayEntry, Error>) -> Void) {
        providerRelayQueue.async {
            do {
                guard ProviderRelayPolicy.validParent(parentExtensionOrigin) else { throw ProviderRelayError.invalidParent }
                guard ProviderRelayPolicy.validConversation(conversationURL) else { throw ProviderRelayError.invalidConversation }
                guard !self.browserShim.isEmpty, self.browserShim.count <= 512 * 1024,
                      !self.sideChatHostScript.isEmpty, self.sideChatHostScript.count <= 1024 * 1024 else { throw ProviderRelayError.invalidResource }
                if let current = self.server, !current.stopped,
                   current.policy.parentExtensionOrigin == parentExtensionOrigin, !current.policy.localOrigin.isEmpty {
                    self.deliver(completion, .success(try self.makeEntry(current, conversationURL: conversationURL)))
                    return
                }
                self.server?.stop()
                self.sessionOperation = UUID()
                let engine = try ProviderRelayServer(mainOrigin: URL(string: "https://chatgpt.com")!, browserShim: self.browserShim, sideChatHostScript: self.sideChatHostScript)
                engine.policy.parentExtensionOrigin = parentExtensionOrigin
                self.server = engine
                engine.startCompletion = { error in
                    guard self.server === engine, !engine.stopped else {
                        self.deliver(completion, .failure(ProviderRelayError.notRunning)); return
                    }
                    if let error { self.deliver(completion, .failure(error)); return }
                    do { self.deliver(completion, .success(try self.makeEntry(engine, conversationURL: conversationURL))) }
                    catch { self.deliver(completion, .failure(error)) }
                }
                do { try engine.start() }
                catch {
                    engine.startCompletion = nil; engine.stop()
                    if self.server === engine { self.server = nil }
                    throw error
                }
            } catch { self.deliver(completion, .failure(error)) }
        }
    }

    /// The caller must have authorization to supply this app's own session. Never supply Safari/Margina cookies.
    /// Selection and a separate official session probe run before any authenticated provider entry becomes usable.
    func installOwnSessionCookies(_ cookies: [HTTPCookie], completion: @escaping (Result<Void, Error>) -> Void) {
        providerRelayQueue.async {
            guard let engine = self.server, !engine.stopped, !engine.policy.localOrigin.isEmpty else {
                self.deliver(completion, .failure(ProviderRelayError.notRunning)); return
            }
            let operation = UUID(); self.sessionOperation = operation
            do {
                let minimal = try ProviderRelaySessionCookies.select(cookies)
                engine.verifyOwnSession(minimal) { verified in
                    guard self.server === engine, self.sessionOperation == operation, !engine.stopped else {
                        self.deliver(completion, .failure(ProviderRelayError.notRunning)); return
                    }
                    if verified {
                        engine.phase = "signedIn"; engine.enabled = true
                        self.deliver(completion, .success(()))
                    } else {
                        try? engine.replaceSession(accessible: false)
                        engine.phase = "blocked"
                        self.deliver(completion, .failure(ProviderRelayError.sessionUnconfirmed))
                    }
                }
            } catch {
                try? engine.replaceSession(accessible: false); engine.phase = "blocked"
                self.deliver(completion, .failure(error))
            }
        }
    }

    func entry(conversationURL: URL, completion: @escaping (Result<ChatGPTProviderRelayEntry, Error>) -> Void) {
        providerRelayQueue.async {
            do {
                guard let engine = self.server else { throw ProviderRelayError.notRunning }
                self.deliver(completion, .success(try self.makeEntry(engine, conversationURL: conversationURL)))
            } catch { self.deliver(completion, .failure(error)) }
        }
    }

    /// Returns the minimum original-background session shape through native code only.
    /// Callers must enforce the active signed-extension owner; never forward this to provider UI or logs.
    func readBrowserSession(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        providerRelayQueue.async {
            guard let engine = self.server, !engine.stopped, engine.enabled, engine.phase == "signedIn" else {
                self.deliver(completion, .failure(ProviderRelayError.sessionUnconfirmed)); return
            }
            let operation = self.sessionOperation, epoch = engine.accountScope
            engine.readBrowserSession { result in
                DispatchQueue.main.async {
                    let current = providerRelayQueue.sync {
                        self.server === engine && self.sessionOperation == operation && engine.accountScope == epoch
                            && !engine.stopped && engine.enabled && engine.phase == "signedIn"
                    }
                    completion(current ? result : .failure(ProviderRelayError.sessionChanged))
                }
            }
        }
    }

    /// Revoke only this relay's memory session and capabilities. The original WK profile is untouched.
    func clearOwnSession() {
        providerRelayQueue.async {
            self.sessionOperation = UUID()
            guard let engine = self.server, !engine.stopped else { return }
            do { try engine.replaceSession(accessible: true); engine.phase = "guest" }
            catch { engine.stop() }
        }
    }

    /// Safe diagnostics exclude cookies, provider capabilities, account identifiers, and conversation URLs.
    func status(completion: @escaping ([String: Any]) -> Void) {
        providerRelayQueue.async {
            let engine = self.server
            let value: [String: Any] = ["running": engine?.listener != nil && engine?.stopped == false,
                "phase": engine?.phase ?? "stopped", "requests": engine?.requestCount ?? 0,
                "challenges": engine?.challengeCount ?? 0, "activeRequests": engine?.transfers.count ?? 0,
                "runtimeInspection": engine?.runtimeInspection ?? ["state": "uninspected"],
                "providerReport": engine?.providerReport ?? NSNull(),
                "requestRoutes": engine?.requestRoutes ?? ["browserScript": 0, "hostModule": 0, "runtimeModule": 0, "rejections": 0],
                "settingsRequests": engine?.settingsRequests.map(\.dictionary) ?? []]
            DispatchQueue.main.async { completion(value) }
        }
    }

    func stop() {
        providerRelayQueue.async {
            self.sessionOperation = UUID()
            self.server?.stop(); self.server = nil
        }
    }

    private func makeEntry(_ engine: ProviderRelayServer, conversationURL: URL) throws -> ChatGPTProviderRelayEntry {
        guard !engine.stopped, engine.enabled, !engine.policy.localOrigin.isEmpty else { throw ProviderRelayError.notRunning }
        guard ProviderRelayPolicy.validConversation(conversationURL),
              var parts = URLComponents(url: conversationURL, resolvingAgainstBaseURL: false) else { throw ProviderRelayError.invalidConversation }
        var query = parts.queryItems ?? []
        query.removeAll { $0.name == "surface" }
        query.append(URLQueryItem(name: "surface", value: "browser_side_chat")); parts.queryItems = query
        guard let url = parts.url, let mapped = engine.policy.localURL(url.absoluteString, relativeTo: url) else { throw ProviderRelayError.invalidConversation }
        return ChatGPTProviderRelayEntry(providerURL: mapped, providerOrigin: engine.policy.localOrigin,
            parentExtensionOrigin: engine.policy.parentExtensionOrigin, bridgeToken: engine.policy.bridgeToken,
            accountScope: engine.accountScope, phase: engine.phase)
    }

    private func deliver<T>(_ completion: @escaping (Result<T, Error>) -> Void, _ value: Result<T, Error>) {
        DispatchQueue.main.async { completion(value) }
    }
}
