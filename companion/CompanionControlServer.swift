import Foundation
import Network
import Security
import Darwin

/// A private loopback command channel. The capability token is local-user readable only.
final class CompanionControlServer {
    typealias CommandHandler = ([String: Any], @escaping ([String: Any]) -> Void) -> Void
    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.companion-http")
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var deadlines: [ObjectIdentifier: DispatchWorkItem] = [:]
    private let queueKey = DispatchSpecificKey<Bool>()
    private var capability = ""
    private var descriptorURL: URL?
    private var started = false
    private let descriptorDirectory: URL?
    private let maxBodyBytes = 1024 * 1024
    private let maxResponseBytes = 16 * 1024 * 1024
    private let maxHeaderBytes = 16 * 1024
    var commandHandler: CommandHandler?

    init(descriptorDirectory: URL? = nil) {
        self.descriptorDirectory = descriptorDirectory
        queue.setSpecific(key: queueKey, value: true)
    }

    func start() throws {
        guard !started else { return }
        var secret = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, secret.count, &secret) == errSecSuccess else {
            throw SideChatError("Could not create the companion connection token")
        }
        capability = Data(secret).base64EncodedString()
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        params.allowLocalEndpointReuse = false
        let listener = try NWListener(using: params, on: .any)
        self.listener = listener
        started = true
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                do { try self.writeDescriptor(port: listener.port) }
                catch { self.stop() }
            case .failed, .cancelled:
                self.removeDescriptor()
            default: break
            }
        }
        listener.start(queue: queue)
    }

    func stop() {
        let finish = { [self] in
            listener?.cancel()
            listener = nil
            started = false
            for deadline in deadlines.values { deadline.cancel() }
            deadlines.removeAll()
            for connection in connections.values { connection.cancel() }
            connections.removeAll()
            removeDescriptor()
        }
        if DispatchQueue.getSpecific(key: queueKey) == true { finish() }
        else { queue.sync(execute: finish) }
    }

    private func accept(_ connection: NWConnection) {
        guard connections.count < 16, Self.isLoopback(connection.endpoint) else { connection.cancel(); return }
        let key = ObjectIdentifier(connection)
        connections[key] = connection
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            switch state {
            case .failed, .cancelled:
                if let connection {
                    let key = ObjectIdentifier(connection)
                    self?.connections.removeValue(forKey: key)
                    self?.deadlines.removeValue(forKey: key)?.cancel()
                }
            default: break
            }
        }
        connection.start(queue: queue)
        setDeadline(connection, seconds: 10)
        receive(connection, accumulated: Data())
    }

    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self else { connection.cancel(); return }
            var buffer = accumulated
            if let data { buffer.append(data) }
            if error != nil { connection.cancel(); return }
            switch self.parse(buffer) {
            case .incomplete:
                if complete { self.respond(connection, status: 400, object: ["ok": false, "error": "Incomplete request"]) }
                else { self.receive(connection, accumulated: buffer) }
            case .reject(let status, let message):
                self.respond(connection, status: status, object: ["ok": false, "error": message])
            case .command(let command):
                self.setDeadline(connection, seconds: ["automation", "live"].contains(command["action"] as? String ?? "") ? 130 : 25)
                DispatchQueue.main.async {
                    guard let handler = self.commandHandler else {
                        self.respond(connection, status: 503, object: ["ok": false, "error": "The companion is not ready"]); return
                    }
                    handler(command) { result in self.respond(connection, status: 200, object: result) }
                }
            }
        }
    }

    private func setDeadline(_ connection: NWConnection, seconds: TimeInterval) {
        let key = ObjectIdentifier(connection)
        deadlines.removeValue(forKey: key)?.cancel()
        let deadline = DispatchWorkItem { [weak connection] in connection?.cancel() }
        deadlines[key] = deadline
        queue.asyncAfter(deadline: .now() + seconds, execute: deadline)
    }

    enum ParsedRequest {
        case incomplete
        case reject(Int, String)
        case command([String: Any])
    }

    /// Kept deterministic so request framing and authentication can be checked without opening a port.
    func parse(_ data: Data) -> ParsedRequest {
        guard data.count <= maxBodyBytes + maxHeaderBytes else { return .reject(413, "Request is too large") }
        guard let range = data.range(of: Data("\r\n\r\n".utf8)) else {
            return data.count > maxHeaderBytes ? .reject(431, "Headers are too large") : .incomplete
        }
        guard range.lowerBound <= maxHeaderBytes,
              let headers = String(data: data[..<range.lowerBound], encoding: .utf8) else {
            return .reject(400, "Invalid HTTP headers")
        }
        let lines = headers.components(separatedBy: "\r\n")
        guard lines.first == "POST /command HTTP/1.1" else { return .reject(404, "Unknown companion endpoint") }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
            guard !line.hasPrefix(" "), !line.hasPrefix("\t"),
                  let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
                return .reject(400, "Invalid HTTP header")
            }
            let name = line[..<colon].lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            guard fields[name] == nil, !value.contains("\n"), !value.contains("\r") else {
                return .reject(400, "Duplicate or invalid HTTP header")
            }
            fields[name] = value
        }
        guard let host = fields["host"], host.hasPrefix("127.0.0.1:"),
              let port = UInt16(host.dropFirst("127.0.0.1:".count)), port > 0 else {
            return .reject(403, "Only the local companion host is allowed")
        }
        guard fields["origin"] == nil, fields["transfer-encoding"] == nil else {
            return .reject(403, "Browser and streaming requests are not allowed")
        }
        guard let auth = fields["authorization"], Self.secureEquals(auth, "Bearer " + capability), !capability.isEmpty else {
            return .reject(401, "Invalid companion connection token")
        }
        guard fields["content-type"]?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "application/json",
              let lengthString = fields["content-length"], !lengthString.isEmpty,
              lengthString.allSatisfy({ $0.isASCII && $0.isNumber }),
              let length = Int(lengthString), length > 0, length <= maxBodyBytes else {
            return .reject(400, "A bounded JSON request body is required")
        }
        let body = data[range.upperBound...]
        guard body.count >= length else { return .incomplete }
        guard body.count == length else { return .reject(400, "Pipelined requests are not allowed") }
        guard let json = try? JSONSerialization.jsonObject(with: body), let command = json as? [String: Any],
              command.count <= 16, let action = command["action"] as? String, !action.isEmpty, action.count <= 64 else {
            return .reject(400, "Invalid companion command")
        }
        return .command(command)
    }

    private func respond(_ connection: NWConnection, status: Int, object: [String: Any]) {
        queue.async {
            let payload = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false,\"error\":\"Invalid companion response\"}".utf8)
            guard payload.count <= self.maxResponseBytes else { connection.cancel(); return }
            let text = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            var response = Data(text.utf8)
            response.append(payload)
            connection.send(content: response, contentContext: .finalMessage, isComplete: true,
                            completion: .contentProcessed { _ in connection.cancel() })
        }
    }

    private func writeDescriptor(port: NWEndpoint.Port?) throws {
        guard let port else { throw SideChatError("The companion listener has no port") }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let directory = descriptorDirectory ?? support.appendingPathComponent("ChatGPT Safari", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let target = directory.appendingPathComponent("companion-control.json")
        let temporary = directory.appendingPathComponent(".companion-control-" + UUID().uuidString)
        let contents = try JSONSerialization.data(withJSONObject: ["port": port.rawValue, "token": capability,
                                                                   "pid": ProcessInfo.processInfo.processIdentifier])
        let descriptor = temporary.withUnsafeFileSystemRepresentation { name in
            Darwin.open(name!, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        }
        guard descriptor >= 0 else { throw SideChatError("Could not create the private companion descriptor") }
        defer { Darwin.close(descriptor); try? FileManager.default.removeItem(at: temporary) }
        let count = contents.withUnsafeBytes { bytes in Darwin.write(descriptor, bytes.baseAddress!, bytes.count) }
        guard count == contents.count, fsync(descriptor) == 0 else {
            throw SideChatError("Could not write the private companion descriptor")
        }
        let result = temporary.withUnsafeFileSystemRepresentation { source in
            target.withUnsafeFileSystemRepresentation { destination in Darwin.rename(source!, destination!) }
        }
        guard result == 0 else { throw SideChatError("Could not install the private companion descriptor") }
        descriptorURL = target
    }

    private func removeDescriptor() {
        guard let url = descriptorURL,
              let data = try? Data(contentsOf: url),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              info["pid"] as? Int32 == ProcessInfo.processInfo.processIdentifier,
              info["token"] as? String == capability else { return }
        try? FileManager.default.removeItem(at: url)
        descriptorURL = nil
    }
    private static func isLoopback(_ endpoint: NWEndpoint) -> Bool {
        guard case .hostPort(let host, _) = endpoint else { return false }
        return host == NWEndpoint.Host("127.0.0.1")
    }
    private static func secureEquals(_ first: String, _ second: String) -> Bool {
        let a = Array(first.utf8), b = Array(second.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}
