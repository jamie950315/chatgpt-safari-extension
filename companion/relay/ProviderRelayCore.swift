// Bounded provider-only transport adapted from Jamie's Margina relay.
// This process never reads a browser cookie store or persists account credentials.
import Foundation
import Network
import Security

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
    var body = Data()
    var received = 0
    var publicLinkAssets: [String] = []
    var settingsObservation: ProviderRelaySettingsObservation?
    init(client: ProviderRelayClient, url: URL, method: String, staticOnly: Bool) { self.client = client; self.url = url; self.method = method; self.staticOnly = staticOnly }
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
    let completion: (Bool) -> Void
    var body = Data()
    var status = 0
    var accepted = false
    init(url: URL, completion: @escaping (Bool) -> Void) { self.url = url; self.completion = completion }
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

    init(mainOrigin: URL, browserShim: Data, sideChatHostScript: Data) throws {
        self.policy = ProviderRelayPolicy(key: try providerRelayRandomKey(), bridgeNonce: try providerRelayRandomKey(), bridgeToken: try providerRelayRandomKey(), mainOrigin: mainOrigin)
        self.browserShim = browserShim
        self.sideChatHostScript = sideChatHostScript
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
            let protected = ["authorization", "chatgpt-account-id", "originator"].contains(name) || name.hasPrefix("oai-") || name.hasPrefix("openai-") || name.hasPrefix("x-openai-")
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
        for probe in abandoned { probe.completion(false) }
    }

    func verifyOwnSession(_ cookies: [HTTPCookie], completion: @escaping (Bool) -> Void) {
        do {
            let accepted = try ProviderRelaySessionCookies.select(cookies)
            try replaceSession(accessible: false)
            phase = "checking"
            guard let storage = session.configuration.httpCookieStorage else { completion(false); return }
            for cookie in accepted { storage.setCookie(cookie) }
            let url = policy.mainOrigin.appendingPathComponent("api/auth/session")
            var request = URLRequest(url: url)
            request.timeoutInterval = 15
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let task = session.dataTask(with: request)
            probes[ProviderRelayTaskKey(session, task)] = ProviderRelaySessionProbe(url: url, completion: completion)
            task.resume()
        } catch { completion(false) }
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
        for probe in abandoned { probe.completion(false) }
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
                probe.accepted = response.url == probe.url && response.statusCode == 200 && type == "application/json" && response.value(forHTTPHeaderField: "cf-mitigated") != "challenge" && response.expectedContentLength <= ProviderRelaySessionCookies.sessionResponseLimit
                completionHandler(probe.accepted ? .allow : .cancel)
                return
            }
            guard let transfer = self.transfers[key] else { completionHandler(.cancel); return }
            transfer.status = response.statusCode
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
            if !transfer.document || transfer.method == "HEAD" {
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
            if transfer.document {
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
                probe.completion(self.session === session && error == nil && probe.accepted && ProviderRelaySessionCookies.validSessionResponse(status: probe.status, data: probe.body))
                return
            }
            guard self.session === session, let transfer = self.transfers.removeValue(forKey: key), !transfer.client.completed else { return }
            transfer.settingsObservation?.stage = error == nil ? "complete" : "networkFailure"
            if error != nil { transfer.client.error(502, ProviderRelayMessages.text("upstreamFailed")); return }
            guard self.session === session, !transfer.client.completed else { return }
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
