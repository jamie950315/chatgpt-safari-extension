// Bounded provider-only transport adapted from Jamie's Margina relay.
// This process never reads a browser cookie store or persists account credentials.
import Foundation
import Network
import Security
import JavaScriptCore

let providerRelayQueue = DispatchQueue(label: "dev.jamie.chatgpt-safari.provider-relay")
let providerRelayMaximumBody = 32 * 1024 * 1024
let providerRelayMaximumDocument = 16 * 1024 * 1024
#if CHATGPT_RELAY_TESTING
let providerRelayWriteTimeout: Double = 0.5
#else
let providerRelayWriteTimeout: Double = 30
#endif

final class ProviderRelayClient {
    let id = UUID()
    let connection: NWConnection
    weak var server: ProviderRelayServer?
    var buffer = Data()
    var task: URLSessionDataTask?
    var responded = false
    var completed = false
    var deadline: DispatchWorkItem?
    var writeDeadline: DispatchWorkItem?
    var lifetimeDeadline: DispatchWorkItem?
    var pendingWrites = 0
    var headersChecked = false
    var reservedBodyBytes = 0

    init(_ connection: NWConnection, server: ProviderRelayServer) { self.connection = connection; self.server = server }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.finish() }
            if case .cancelled = state { self?.finish() }
        }
        connection.start(queue: providerRelayQueue)
        let work = DispatchWorkItem { [weak self] in self?.error(408, ProviderRelayMessages.text("requestTimeout")) }
        deadline = work
        providerRelayQueue.asyncAfter(deadline: .now() + 15, execute: work)
        let lifetime = DispatchWorkItem { [weak self] in self?.finish() }
        lifetimeDeadline = lifetime
        providerRelayQueue.asyncAfter(deadline: .now() + 600, execute: lifetime)
        receive()
    }

    func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, failure in
            guard let self, !self.completed else { return }
            if let data { self.buffer.append(data) }
            if self.buffer.count > providerRelayMaximumBody + 32_768 { self.error(413, ProviderRelayMessages.text("requestTooLarge")); return }
            if let end = self.buffer.range(of: Data("\r\n\r\n".utf8)) {
                guard end.lowerBound <= 32_768, let head = String(data: self.buffer[..<end.lowerBound], encoding: .utf8) else { self.error(400, ProviderRelayMessages.text("invalidRequest")); return }
                let lines = head.components(separatedBy: "\r\n")
                let requestLine = lines[0].split(separator: " ", omittingEmptySubsequences: false)
                guard requestLine.count == 3, requestLine[2] == "HTTP/1.1", lines.count <= 101 else { self.error(400, ProviderRelayMessages.text("invalidRequest")); return }
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":"), line.first != " ", line.first != "\t" else { self.error(400, ProviderRelayMessages.text("invalidHeader")); return }
                    let name = String(line[..<colon]).lowercased()
                    guard name.range(of: #"^[a-z0-9!#$%&'*+.^_`|~-]+$"#, options: .regularExpression) != nil, headers[name] == nil else { self.error(400, ProviderRelayMessages.text("duplicateHeader")); return }
                    headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                guard headers["transfer-encoding"] == nil else { self.error(400, ProviderRelayMessages.text("unsupportedUpload")); return }
                let size = headers["content-length"] ?? "0"
                guard size.range(of: #"^[0-9]+$"#, options: .regularExpression) != nil, let count = Int(size), count <= providerRelayMaximumBody else { self.error(413, ProviderRelayMessages.text("invalidLength")); return }
                if !self.headersChecked {
                    let request = ProviderRelayRequest(method: String(requestLine[0]), target: String(requestLine[1]), headers: headers, body: Data())
                    guard let server = self.server, server.preflight(request, client: self) else { return }
                    guard server.pendingRequestBytes + count <= 128 * 1024 * 1024 else { self.error(503, ProviderRelayMessages.text("uploadBusy")); return }
                    self.headersChecked = true
                    self.reservedBodyBytes = count
                    server.pendingRequestBytes += count
                }
                if self.buffer.count >= end.upperBound + count {
                    guard self.buffer.count == end.upperBound + count else { self.error(400, "Trailing request bytes are not accepted"); return }
                    self.deadline?.cancel()
                    let request = ProviderRelayRequest(method: String(requestLine[0]), target: String(requestLine[1]), headers: headers, body: self.buffer.subdata(in: end.upperBound..<(end.upperBound + count)))
                    self.buffer = Data()
                    self.server?.handle(request, client: self)
                    return
                }
            } else if self.buffer.count > 32_768 { self.error(431, ProviderRelayMessages.text("headersTooLarge")); return }
            if failure != nil || complete { self.finish(); return }
            self.receive()
        }
    }

    func sendHead(_ status: Int, headers: [String: String], length: Int? = nil) {
        guard !responded, !completed else { return }
        responded = true
        var values = headers
        values["Connection"] = "close"
        values["Cache-Control"] = "no-store"
        values["Referrer-Policy"] = "no-referrer"
        values["X-Content-Type-Options"] = "nosniff"
        if let length { values["Content-Length"] = String(length) } else { values["Transfer-Encoding"] = "chunked" }
        var head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\n"
        for (name, value) in values where !value.contains("\r") && !value.contains("\n") { head += "\(name): \(value)\r\n" }
        head += "\r\n"
        willWrite()
        connection.send(content: Data(head.utf8), completion: .contentProcessed { [weak self] error in self?.didWrite(error) })
    }

    func send(_ status: Int, data: Data, headers: [String: String]) {
        guard !responded, !completed else { return }
        sendHead(status, headers: headers, length: data.count)
        willWrite()
        connection.send(content: data, completion: .contentProcessed { [weak self] error in self?.didWrite(error); self?.finish() })
    }

    func stream(_ data: Data, completion: @escaping () -> Void) {
        guard !completed else { completion(); return }
        var framed = Data(String(data.count, radix: 16).utf8)
        framed.append(Data("\r\n".utf8)); framed.append(data); framed.append(Data("\r\n".utf8))
        willWrite()
        connection.send(content: framed, completion: .contentProcessed { [weak self] error in
            self?.didWrite(error)
            completion()
        })
    }

    func endStream() {
        guard !completed else { return }
        willWrite()
        connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [weak self] error in self?.didWrite(error); self?.finish() })
    }

    func willWrite() {
        pendingWrites += 1
        if pendingWrites == 1 { armWriteDeadline() }
    }

    func didWrite(_ error: NWError?) {
        pendingWrites = max(0, pendingWrites - 1)
        if error != nil { finish(); return }
        if pendingWrites == 0 { writeDeadline?.cancel() }
        else { armWriteDeadline() }
    }

    func armWriteDeadline() {
        writeDeadline?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.finish() }
        writeDeadline = work
        providerRelayQueue.asyncAfter(deadline: .now() + providerRelayWriteTimeout, execute: work)
    }

    func error(_ status: Int, _ message: String) {
        if responded { finish(); return }
        server?.incrementRoute("rejections")
        server?.incrementRoute("rejection_http_\(status)")
        // Fixed categories distinguish a rejected local capability from an
        // upstream account failure without retaining a URL or request data.
        let reasons = [
            "Only this local provider hostname is accepted": "host",
            "Requests from another origin are rejected": "origin",
            "The provider capability is invalid": "capability",
            "This upstream route is not allowed": "route",
            "The provider session is unavailable": "session",
        ]
        if let reason = reasons[message] { server?.incrementRoute("rejection_" + reason) }
        let body = "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>\(providerRelayEscapeHTML(ProviderRelayMessages.text("relayStatusTitle")))</title><h1>\(providerRelayEscapeHTML(ProviderRelayMessages.text("chatUnavailable")))</h1><p>\(providerRelayEscapeHTML(message))</p><p>\(providerRelayEscapeHTML(ProviderRelayMessages.text("noAutomaticAction")))</p></html>"
        send(status, data: Data(body.utf8), headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'"])
    }

    func finish() {
        guard !completed else { return }
        completed = true
        deadline?.cancel()
        lifetimeDeadline?.cancel()
        writeDeadline?.cancel()
        server?.pendingRequestBytes -= reservedBodyBytes
        buffer = Data()
        task?.cancel()
        connection.cancel()
        server?.clients.removeValue(forKey: id)
    }
}

final class ProviderRelayTransfer {
    let client: ProviderRelayClient
    let url: URL
    let method: String
    let staticOnly: Bool
    var status = 0
    var headers: [String: String] = [:]
    var document = false
    var script = false
    var body = Data()
    var received = 0
    var publicLinkAssets: [String] = []
    var settingsObservation: ProviderRelaySettingsObservation?
    init(client: ProviderRelayClient, url: URL, method: String, staticOnly: Bool) { self.client = client; self.url = url; self.method = method; self.staticOnly = staticOnly }
}

/// Compiles source only; never executes provider code in the native context.
/// Ordinary generator/Promise output avoids WebKit's crashing async-generator VM path.
final class ProviderStreamCompiler {
    private let context: JSContext
    private let transform: JSValue
    static func needed(_ data: Data) -> Bool {
        guard let source = String(data: data, encoding: .utf8) else { return false }
        return source.range(of: #"\b(?:sY|tI|dd)\s*:\s*\(?\s*function\s*\("#, options: .regularExpression) != nil
            && source.range(of: #"\basync\s*(?:function\s*\*|\*)|\bfor\s+await\s*\("#, options: .regularExpression) != nil
    }
    init(source: Data) throws {
        guard let script = String(data: source, encoding: .utf8), let context = JSContext() else {
            throw ProviderRelayError.invalidResource
        }
        context.evaluateScript(script)
        guard context.exception == nil,
              let transform = context.evaluateScript("""
              source => {
                const types = Babel.packages.types, targets = new Set(['sY', 'tI', 'dd']);
                let changed = false;
                const output = Babel.transform(source, {sourceType: 'module', compact: true, comments: false, sourceMaps: false,
                  plugins: [() => ({visitor: {ObjectProperty(path) {
                    const node = path.node, key = node.key.name ?? node.key.value;
                    if (!targets.has(key) || node.value.type !== 'FunctionExpression' || node.value.params.length !== 3) return;
                    const file = types.file(types.program([types.expressionStatement(node.value)]));
                    const result = Babel.transformFromAst(file, '', {plugins: ['transform-async-generator-functions'], sourceType: 'script', ast: true, code: false});
                    const body = result.ast.program.body, expression = body.pop().expression;
                    body.push(types.returnStatement(expression));
                    path.get('value').replaceWith(types.callExpression(types.functionExpression(null, [], types.blockStatement(body)), []));
                    path.skip(); changed = true;
                  }}})]});
                return {code: changed ? output.code : source, changed};
              }
              """),
              context.exception == nil else { throw ProviderRelayError.invalidResource }
        self.context = context; self.transform = transform
    }
    func compile(_ data: Data) throws -> (Data, Bool) {
        guard let source = String(data: data, encoding: .utf8) else { throw ProviderRelayError.invalidResource }
        guard source.range(of: #"\basync\s*(?:function\s*\*|\*)|\bfor\s+await\s*\("#, options: .regularExpression) != nil else { return (data, false) }
        context.exception = nil
        guard let result = transform.call(withArguments: [source]), context.exception == nil,
              let output = result.forProperty("code")?.toString(), output.utf8.count <= providerRelayMaximumBody else {
            throw ProviderRelayError.invalidResource
        }
        return (Data(output.utf8), result.forProperty("changed")?.toBool() == true)
    }
}

final class ProviderRelaySettingsObservation {
    let path: String
    let method: String
    var status = 0
    var stage = "started"
    init(path: String, method: String) { self.path = path; self.method = method }
    var dictionary: [String: Any] { ["path": path, "method": method, "status": status, "stage": stage] }
}

struct ProviderRelayTaskKey: Hashable {
    let session: ObjectIdentifier
    let task: Int
    init(_ session: URLSession, _ task: URLSessionTask) { self.session = ObjectIdentifier(session); self.task = task.taskIdentifier }
}

final class ProviderRelaySessionProbe {
    let url: URL
    let completion: (Result<[String: Any], Error>) -> Void
    var body = Data()
    var status = 0
    var accepted = false
    init(url: URL, completion: @escaping (Result<[String: Any], Error>) -> Void) { self.url = url; self.completion = completion }
}

final class ProviderRelayServer: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate {
    var policy: ProviderRelayPolicy
    let loopbackHost: String
    var enabled = true
    var onReady: (() -> Void)?
    var listener: NWListener?
    var clients: [UUID: ProviderRelayClient] = [:]
    var pendingRequestBytes = 0
    var requestCount = 0
    var challengeCount = 0
    var transfers: [ProviderRelayTaskKey: ProviderRelayTransfer] = [:]
    var probes: [ProviderRelayTaskKey: ProviderRelaySessionProbe] = [:]
    var session: URLSession!
    var lastActivity = Date()

    let browserShim: Data
    let sideChatHostScript: Data
    private let streamCompilerSource: Data?
    private var streamCompiler: ProviderStreamCompiler?
    private let streamCompilerQueue = DispatchQueue(label: "dev.jamie.chatgpt-safari.provider-compiler")
    var startCompletion: ((Error?) -> Void)?
    var stopped = false
    var phase = "guest"
    var accountScope = UUID().uuidString
    var inlineModules: [String: Data] = [:]
    var inlineModuleBytes = 0
    var inlineModuleOrder: [String] = []
    var runtimeInspection: [String: Any] = ["state": "uninspected"]
    var providerReport: [String: Any]?
    var requestRoutes = ["browserScript": 0, "hostModule": 0, "runtimeModule": 0, "rejections": 0]
    var settingsRequests: [ProviderRelaySettingsObservation] = []

    init(mainOrigin: URL, browserShim: Data, sideChatHostScript: Data, streamCompilerSource: Data? = nil) throws {
        self.policy = ProviderRelayPolicy(key: try providerRelayRandomKey(), bridgeNonce: try providerRelayRandomKey(), bridgeToken: try providerRelayRandomKey(), mainOrigin: mainOrigin)
        self.browserShim = browserShim
        self.sideChatHostScript = sideChatHostScript
        self.streamCompilerSource = streamCompilerSource
        self.loopbackHost = "chatgpt-provider-\(UUID().uuidString.lowercased()).localhost"
        super.init()
        session = makeSession()
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.timeoutIntervalForRequest = 45
        configuration.timeoutIntervalForResource = 600
        configuration.httpMaximumConnectionsPerHost = 6
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        listener.stateUpdateHandler = { [weak self] state in
            guard let self, self.listener === listener else { return }
            if case .ready = state, let port = listener.port {
                self.policy.localOrigin = "http://\(self.loopbackHost):\(port.rawValue)"
                self.startCompletion?(nil); self.startCompletion = nil
                self.onReady?()
            }
            if case .failed(let error) = state { self.startCompletion?(error); self.startCompletion = nil; self.stop() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, self.listener === listener, self.clients.count < 32 else { connection.cancel(); return }
            let client = ProviderRelayClient(connection, server: self)
            self.clients[client.id] = client
            client.start()
        }
        listener.start(queue: providerRelayQueue)
    }

    func handle(_ request: ProviderRelayRequest, client: ProviderRelayClient) {
        guard preflight(request, client: client) else { return }
        let local = URLComponents(string: policy.localOrigin + request.target)!
        let origin = request.headers["origin"]
        let authorized = policy.authorized(request)
        guard authorized || policy.publicStatic(request) else { client.error(401, ProviderRelayMessages.text("sessionInvalidReopen")); return }
        lastActivity = Date()
        if local.path == "/__chatgpt/diagnostics" {
            guard request.body.count <= ProviderRelayDiagnostics.maximumBytes,
                  let decoded = try? JSONSerialization.jsonObject(with: request.body),
                  let report = ProviderRelayDiagnostics.validate(decoded) else {
                incrementRoute("rejections")
                client.send(400, data: Data("{\"ok\":false,\"error\":\"Invalid provider diagnostic report\"}".utf8), headers: ["Content-Type": "application/json"]); return
            }
            providerReport = report
            client.send(200, data: Data("{\"ok\":true}".utf8), headers: ["Content-Type": "application/json"]); return
        }
        if local.path == "/__chatgpt/browser.js", request.method == "GET" {
            incrementRoute("browserScript")
            let runtimes = (local.queryItems ?? []).filter { $0.name == "__chatgpt_runtime" }
            guard runtimes.count == 1, let runtime = runtimes[0].value,
                  runtime.range(of: #"^633146\.[a-f0-9]{10}\.js$"#, options: .regularExpression) != nil else {
                client.error(400, "The page runtime binding is invalid"); return
            }
            do { client.send(200, data: try policy.configuredBrowserShim(browserShim, runtimeURL: "https://chatgpt.com/cdn/assets/" + runtime), headers: ["Content-Type": "application/javascript; charset=utf-8"] ) }
            catch { client.error(500, "The provider relay bootstrap is invalid") }
            return
        }
        if local.path == "/__chatgpt/sidechat-host.js", request.method == "GET" {
            incrementRoute("hostModule")
            var module = sideChatHostScript
            module.append(Data("\nif (!globalThis.__CHATGPT_SAFARI_ADAPTER_READY__ || typeof globalThis.__CHATGPT_SAFARI_ADAPTER_READY__.then !== 'function') throw new Error('The Safari side-chat adapter did not publish its readiness promise');\nawait globalThis.__CHATGPT_SAFARI_ADAPTER_READY__;\n".utf8))
            client.send(200, data: module, headers: ["Content-Type": "application/javascript; charset=utf-8"]); return
        }
        if (local.queryItems ?? []).contains(where: { $0.name == providerRelayInlineParameter }) {
            var parts = local
            parts.queryItems = parts.queryItems?.filter { $0.name != providerRelayKeyParameter }
            let identifier = parts.percentEncodedPath + "?" + (parts.percentEncodedQuery ?? "")
            guard let source = inlineModules[identifier] else { client.error(404, "The inline module belongs to an expired page"); return }
            client.send(200, data: source, headers: ["Content-Type": "application/javascript; charset=utf-8"]); return
        }
        guard let upstream = policy.upstreamURL(request.target) else { client.error(403, ProviderRelayMessages.text("upstreamNotAllowed")); return }
        if upstream.path.range(of: #"^/cdn/assets/633146\.[a-f0-9]{10}\.js$"#, options: .regularExpression) != nil { incrementRoute("runtimeModule") }
        if request.headers["upgrade"] != nil { client.error(501, ProviderRelayMessages.text("websocketUnavailable")); return }
        var outgoing = URLRequest(url: upstream)
        outgoing.httpMethod = request.method
        if !request.body.isEmpty { outgoing.httpBody = request.body }
        let staticOnly = ProviderRelayPolicy.staticAssetPath(upstream.path) || upstream.host == "cdn.oaistatic.com" || upstream.host == "persistent.oaistatic.com"
        let isMain = upstream.scheme == policy.mainOrigin.scheme && upstream.host == policy.mainOrigin.host && upstream.port == policy.mainOrigin.port
        let basic: Set<String> = ["accept", "accept-language", "user-agent", "content-type", "range", "if-range", "last-event-id"]
        for (name, value) in request.headers {
            let protected = ["authorization", "chatgpt-account-id", "originator", "x-conduit-token"].contains(name) || name.hasPrefix("oai-") || name.hasPrefix("openai-") || name.hasPrefix("x-openai-") || name.hasPrefix("x-oai-")
            guard basic.contains(name) || (isMain && !staticOnly && protected) else { continue }
            if value.utf8.count <= 8192 { outgoing.setValue(value, forHTTPHeaderField: name) }
        }
        if origin != nil {
            var parts = URLComponents(url: upstream, resolvingAgainstBaseURL: false)!
            parts.path = ""; parts.query = nil; parts.fragment = nil
            outgoing.setValue(parts.string, forHTTPHeaderField: "Origin")
        }
        // No incoming Cookie/Referer/Host/control headers are forwarded.
        // Static modules use a separate cookie-free request policy.
        if staticOnly { outgoing.httpShouldHandleCookies = false }
        requestCount += 1
        let task = session.dataTask(with: outgoing)
        client.task = task
        let transfer = ProviderRelayTransfer(client: client, url: upstream, method: request.method, staticOnly: staticOnly)
        if ["/backend-api/settings/user", "/__codex-api/settings/user"].contains(upstream.path),
           upstream.scheme == policy.mainOrigin.scheme, upstream.host == policy.mainOrigin.host, upstream.port == policy.mainOrigin.port {
            let observation = ProviderRelaySettingsObservation(path: upstream.path, method: request.method)
            settingsRequests.append(observation)
            if settingsRequests.count > 8 { settingsRequests.removeFirst(settingsRequests.count - 8) }
            transfer.settingsObservation = observation
        }
        transfers[ProviderRelayTaskKey(session, task)] = transfer
        task.resume()
    }

    func preflight(_ request: ProviderRelayRequest, client: ProviderRelayClient) -> Bool {
        if let rejection = policy.rejection(for: request, enabled: enabled && !stopped) {
            client.error(rejection.0, rejection.1); return false
        }
        return true
    }

    func incrementRoute(_ name: String) {
        requestRoutes[name] = min(1_000_000_000, (requestRoutes[name] ?? 0) + 1)
    }

    // Do not put arbitrary paths, identifiers, query values, headers or bodies
    // in status. These fixed route classes cover account and submit failures.
    static func diagnosticRoute(_ path: String) -> String? {
        switch path {
        case "/api/auth/session": return "auth_session"
        case "/backend-api/me": return "account_me"
        case "/backend-api/accounts/check", "/backend-api/accounts/check/v4-2023-04-27": return "account_check"
        case "/backend-api/settings/user": return "settings"
        case "/backend-api/f/conversation", "/backend-api/conversation": return "conversation_submit"
        case "/backend-api/f/conversation/prepare": return "conversation_prepare"
        case "/backend-api/f/conversation/resume": return "resume"
        default:
            if path.hasPrefix("/backend-api/conversation/") {
                return path.hasSuffix("/stream_status") ? "stream_status" : "conversation"
            }
            return nil
        }
    }

    func replaceSession(accessible: Bool) throws {
        enabled = false
        for client in Array(clients.values) { client.finish() }
        let abandoned = Array(probes.values)
        probes.removeAll(); transfers.removeAll()
        session.invalidateAndCancel()
        session = makeSession()
        policy.key = try providerRelayRandomKey()
        policy.bridgeNonce = try providerRelayRandomKey()
        policy.bridgeToken = try providerRelayRandomKey()
        accountScope = UUID().uuidString
        inlineModules.removeAll(); inlineModuleOrder.removeAll(); inlineModuleBytes = 0
        runtimeInspection = ["state": "uninspected"]
        providerReport = nil
        requestRoutes = ["browserScript": 0, "hostModule": 0, "runtimeModule": 0, "rejections": 0]
        settingsRequests.removeAll()
        enabled = accessible
        for probe in abandoned { probe.completion(.failure(ProviderRelayError.sessionChanged)) }
    }

    func verifyOwnSession(_ cookies: [HTTPCookie], completion: @escaping (Bool) -> Void) {
        do {
            let accepted = try ProviderRelaySessionCookies.select(cookies)
            try replaceSession(accessible: false)
            phase = "checking"
            guard let storage = session.configuration.httpCookieStorage else { completion(false); return }
            for cookie in accepted { storage.setCookie(cookie) }
            requestOwnSession { result in
                if case .success = result { completion(true) } else { completion(false) }
            }
        } catch { completion(false) }
    }

    /// Native-only credential read for the signed extension background, never the provider page.
    func readBrowserSession(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard !stopped, enabled, phase == "signedIn" else { completion(.failure(ProviderRelayError.sessionUnconfirmed)); return }
        let epoch = accountScope, currentSession = session
        requestOwnSession { result in
            guard !self.stopped, self.enabled, self.phase == "signedIn", self.accountScope == epoch,
                  self.session === currentSession else { completion(.failure(ProviderRelayError.sessionChanged)); return }
            switch result {
            case .success(let payload):
                guard let minimal = ProviderRelaySessionCookies.browserSession(from: payload) else {
                    completion(.failure(ProviderRelayError.invalidBrowserSession)); return
                }
                completion(.success(minimal))
            case .failure(let error): completion(.failure(error))
            }
        }
    }

    private func requestOwnSession(completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard !stopped else { completion(.failure(ProviderRelayError.notRunning)); return }
        let url = policy.mainOrigin.appendingPathComponent("api/auth/session")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let task = session.dataTask(with: request)
        probes[ProviderRelayTaskKey(session, task)] = ProviderRelaySessionProbe(url: url, completion: completion)
        task.resume()
    }

    func registerInlineModule(_ source: String, documentURL: URL) throws -> String {
        let data = Data(source.utf8)
        guard data.count <= providerRelayMaximumDocument,
              let mapped = policy.localURL(documentURL.absoluteString, relativeTo: documentURL),
              var parts = URLComponents(string: mapped) else { throw ProviderRelayError.moduleLimit }
        // Old document modules have already entered the browser's per-document module map.
        // Bound native retention without making ordinary long-lived sessions run out of slots.
        while inlineModules.count >= 128 || inlineModuleBytes + data.count > providerRelayMaximumDocument {
            guard !inlineModuleOrder.isEmpty else { throw ProviderRelayError.moduleLimit }
            let expired = inlineModuleOrder.removeFirst()
            if let old = inlineModules.removeValue(forKey: expired) { inlineModuleBytes -= old.count }
        }
        var query = parts.queryItems ?? []
        query.removeAll { $0.name == providerRelayInlineParameter || $0.name == providerRelayKeyParameter }
        query.append(URLQueryItem(name: providerRelayInlineParameter, value: UUID().uuidString.lowercased()))
        parts.queryItems = query
        let identifier = parts.percentEncodedPath + "?" + (parts.percentEncodedQuery ?? "")
        inlineModules[identifier] = data; inlineModuleBytes += data.count
        inlineModuleOrder.append(identifier)
        query.append(URLQueryItem(name: providerRelayKeyParameter, value: policy.key))
        parts.queryItems = query
        return parts.string!
    }

    func stop() {
        guard !stopped else { return }
        stopped = true; enabled = false; phase = "stopped"
        let startup = startCompletion; startCompletion = nil
        listener?.cancel(); listener = nil
        for client in Array(clients.values) { client.finish() }
        let abandoned = Array(probes.values); probes.removeAll(); transfers.removeAll()
        inlineModules.removeAll(); inlineModuleOrder.removeAll(); inlineModuleBytes = 0
        session.invalidateAndCancel()
        startup?(ProviderRelayError.notRunning)
        for probe in abandoned { probe.completion(.failure(ProviderRelayError.sessionChanged)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Redirects must pass through the allow-list and URL rewriter, not escape to an arbitrary host.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        providerRelayQueue.async { [weak self] in
            guard let self, self.session === session, let response = response as? HTTPURLResponse else { completionHandler(.cancel); return }
            let key = ProviderRelayTaskKey(session, dataTask)
            if let probe = self.probes[key] {
                let type = response.value(forHTTPHeaderField: "Content-Type")?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces) ?? ""
                probe.status = response.statusCode
                self.incrementRoute("session_probe_http_\(response.statusCode)")
                probe.accepted = response.url == probe.url && response.statusCode == 200 && type == "application/json" && response.value(forHTTPHeaderField: "cf-mitigated") != "challenge" && response.expectedContentLength <= ProviderRelaySessionCookies.sessionResponseLimit
                completionHandler(probe.accepted ? .allow : .cancel)
                return
            }
            guard let transfer = self.transfers[key] else { completionHandler(.cancel); return }
            transfer.status = response.statusCode
            if let kind = Self.diagnosticRoute(transfer.url.path) {
                self.incrementRoute("\(kind)_http_\(response.statusCode)")
            }
            transfer.settingsObservation?.status = response.statusCode
            transfer.settingsObservation?.stage = "response"
            if response.value(forHTTPHeaderField: "cf-mitigated") == "challenge" {
                self.challengeCount += 1
                transfer.client.error(502, ProviderRelayMessages.text("browserVerification"))
                completionHandler(.cancel); return
            }
            let type = response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
            transfer.publicLinkAssets = ProviderRelayPolicy.publicAssetPaths(in: response.value(forHTTPHeaderField: "Link") ?? "")
            if transfer.staticOnly {
                let mime = type.lowercased().split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
                let accepted = ["application/javascript", "text/javascript", "application/x-javascript", "text/css", "application/octet-stream", "application/font-woff", "application/font-woff2"].contains(mime) || mime.hasPrefix("font/") || mime.hasPrefix("image/")
                guard accepted, response.value(forHTTPHeaderField: "Location") == nil else {
                    transfer.client.error(502, ProviderRelayMessages.text("staticResponseRejected"))
                    completionHandler(.cancel); return
                }
                if mime == "image/svg+xml" { transfer.headers["Content-Security-Policy"] = "default-src 'none'; sandbox" }
                transfer.script = ["application/javascript", "text/javascript", "application/x-javascript"].contains(mime)
            }
            transfer.headers["Content-Type"] = type
            transfer.document = type.lowercased().contains("text/html")
            if let location = response.value(forHTTPHeaderField: "Location") {
                guard let rewritten = self.policy.localURL(location, relativeTo: transfer.url) else {
                    transfer.client.error(502, ProviderRelayMessages.text("redirectRejected"))
                    completionHandler(.cancel); return
                }
                transfer.headers["Location"] = rewritten
            }
            if !transfer.staticOnly, let policy = response.value(forHTTPHeaderField: "Content-Security-Policy") { transfer.headers["Content-Security-Policy"] = policy }
            if (!transfer.document && !transfer.script) || transfer.method == "HEAD" {
                transfer.client.sendHead(transfer.status, headers: transfer.headers)
            }
            completionHandler(.allow)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        dataTask.suspend()
        providerRelayQueue.async { [weak self] in
            guard let self, self.session === session else { dataTask.cancel(); return }
            let key = ProviderRelayTaskKey(session, dataTask)
            if let probe = self.probes[key] {
                guard probe.body.count + data.count <= ProviderRelaySessionCookies.sessionResponseLimit else { probe.accepted = false; dataTask.cancel(); return }
                probe.body.append(data); dataTask.resume(); return
            }
            guard let transfer = self.transfers[key], !transfer.client.completed else { dataTask.cancel(); return }
            transfer.received += data.count
            guard transfer.received <= (transfer.document ? providerRelayMaximumDocument : providerRelayMaximumBody) else {
                transfer.client.error(502, ProviderRelayMessages.text("responseTooLarge")); dataTask.cancel(); return
            }
            if transfer.document || transfer.script {
                transfer.body.append(data)
                dataTask.resume()
            } else {
                transfer.client.stream(data) { dataTask.resume() }
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        providerRelayQueue.async { [weak self] in
            guard let self else { return }
            let key = ProviderRelayTaskKey(session, task)
            if let probe = self.probes.removeValue(forKey: key) {
                guard self.session === session, !self.stopped else { probe.completion(.failure(ProviderRelayError.sessionChanged)); return }
                guard error == nil, probe.accepted,
                      let payload = ProviderRelaySessionCookies.sessionPayload(status: probe.status, data: probe.body) else {
                    self.incrementRoute(error == nil ? "session_probe_invalid" : "session_probe_networkFailure")
                    probe.completion(.failure(ProviderRelayError.sessionUnconfirmed)); return
                }
                probe.completion(.success(payload))
                return
            }
            guard self.session === session, let transfer = self.transfers.removeValue(forKey: key), !transfer.client.completed else { return }
            transfer.settingsObservation?.stage = error == nil ? "complete" : "networkFailure"
            if error != nil { transfer.client.error(502, ProviderRelayMessages.text("upstreamFailed")); return }
            guard self.session === session, !transfer.client.completed else { return }
            if transfer.script && transfer.method != "HEAD" {
                if !ProviderStreamCompiler.needed(transfer.body) {
                    transfer.client.send(transfer.status, data: transfer.body, headers: transfer.headers)
                    return
                }
                // Compiling large modules must not block context/session RPCs
                // or streaming traffic on the provider transport queue.
                self.streamCompilerQueue.async {
                    let result: Result<(Data, Bool), Error> = Result {
                        if self.streamCompiler == nil {
                            let source = try self.streamCompilerSource ?? Bundle.main.url(forResource: "BabelStandalone", withExtension: "js").map { try Data(contentsOf: $0) }
                            guard let source else { throw ProviderRelayError.invalidResource }
                            self.streamCompiler = try ProviderStreamCompiler(source: source)
                        }
                        return try self.streamCompiler!.compile(transfer.body)
                    }
                    providerRelayQueue.async {
                        guard self.session === session, !self.stopped, !transfer.client.completed else { return }
                        switch result {
                        case .success(let (body, transformed)):
                            if transformed { self.incrementRoute("compiledStreamModules") }
                            transfer.client.send(transfer.status, data: body, headers: transfer.headers)
                        case .failure: transfer.client.error(502, "The provider module could not be compiled for Safari.")
                        }
                    }
                }
                return
            }
            if transfer.document && transfer.method != "HEAD" {
                guard let html = String(data: transfer.body, encoding: .utf8) else { transfer.client.error(502, ProviderRelayMessages.text("invalidUTF8")); return }
                let nonce = self.policy.bridgeNonce
                self.runtimeInspection = self.policy.runtimeInventory(in: html, httpLinkAssets: transfer.publicLinkAssets)
                self.runtimeInspection["responseStatus"] = transfer.status
                transfer.headers["Content-Security-Policy"] = self.policy.documentPolicy(transfer.headers["Content-Security-Policy"] ?? "", nonce: nonce)
                do {
                    let body = try self.policy.rewriteDocument(html, nonce: nonce, documentURL: transfer.url,
                        registerInlineModule: { try self.registerInlineModule($0, documentURL: $1) })
                    transfer.client.send(transfer.status, data: Data(body.utf8), headers: transfer.headers)
                    self.runtimeInspection["state"] = "adapted"
                } catch {
                    self.runtimeInspection["state"] = error is ProviderRelayError ? "adaptationRejected" : "parserRejected"
                    if case ProviderRelayError.unsupportedRuntime = error { self.runtimeInspection["failure"] = "unsupportedRuntime" }
                    else { self.runtimeInspection["failure"] = "documentAdaptationFailed" }
                    transfer.client.error(502, (error as? LocalizedError)?.errorDescription ?? "The provider page could not be adapted")
                }
            } else { transfer.client.endStream() }
        }
    }
}
