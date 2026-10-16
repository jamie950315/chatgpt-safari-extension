import Foundation
import Security

@objc(SafariNativeBridge)
protocol SafariNativeBridge {
    func handle(_ request: Data, withReply reply: @escaping (Data) -> Void)
}

private let maximumFrameSize = 16 * 1024 * 1024

private func encode(_ value: [String: Any]) -> Data {
    // All callers construct JSON values, including failures.
    try! JSONSerialization.data(withJSONObject: value)
}

private func failure(_ code: String, _ message: String) -> [String: Any] {
    ["ok": false, "error": ["code": code, "message": message]]
}

private func validateOfficialHost(_ url: URL) throws {
    var code: SecStaticCode?
    var requirement: SecRequirement?
    let rule = "anchor apple generic and identifier \"extension-host\" and certificate leaf[subject.OU] = \"2DC432GLL2\""
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
          SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
          let code, let requirement,
          SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess else {
        throw NSError(domain: "SafariBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "The registered host is not a valid OpenAI-signed native host."])
    }
}

private func officialHost() throws -> URL {
    let manifest = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json")
    let value = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any]
    guard value?["name"] as? String == "com.openai.codexextension",
          value?["type"] as? String == "stdio",
          let path = value?["path"] as? String, path.hasPrefix("/") else {
        throw NSError(domain: "SafariBridge", code: 2, userInfo: [NSLocalizedDescriptionKey: "Install the ChatGPT/Codex browser native host before connecting Safari."])
    }
    let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
    try validateOfficialHost(url)
    return url
}

private final class HostSession {
    let id = UUID().uuidString
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    let diagnostics = Pipe()
    let queue: DispatchQueue
    var buffer = Data()
    var messages: [Any] = []
    var queuedBytes = 0
    var terminalError: [String: Any]?
    var pollReply: ((Data) -> Void)?
    var pollGeneration = 0
    var lastActivity = Date()

    init(executable: URL, origin: String, queue: DispatchQueue) throws {
        self.queue = queue
        process.executableURL = executable
        process.arguments = [origin]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = diagnostics
        // Drain diagnostics, but never log messages, page contents, or credentials.
        diagnostics.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.queue.async { [weak self] in self?.receive(data) }
        }
        process.terminationHandler = { [weak self] process in
            self?.queue.async { [weak self] in
                self?.fail("NATIVE_HOST_EXITED", "The native host exited (status \(process.terminationStatus)).")
            }
        }
        do { try process.run() } catch {
            output.fileHandleForReading.readabilityHandler = nil
            diagnostics.fileHandleForReading.readabilityHandler = nil
            throw error
        }
    }

    func send(_ value: Any) throws {
        guard terminalError == nil, process.isRunning else {
            throw NSError(domain: "SafariBridge", code: 3, userInfo: [NSLocalizedDescriptionKey: "The native host is disconnected."])
        }
        let data = try JSONSerialization.data(withJSONObject: value)
        guard data.count <= maximumFrameSize else {
            throw NSError(domain: "SafariBridge", code: 4, userInfo: [NSLocalizedDescriptionKey: "The native message exceeds 16 MiB."])
        }
        var length = UInt32(data.count).littleEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }
        frame.append(data)
        try input.fileHandleForWriting.write(contentsOf: frame)
        lastActivity = Date()
    }

    func receive(_ data: Data) {
        guard terminalError == nil else { return }
        guard !data.isEmpty else {
            fail("NATIVE_HOST_EOF", "The native host closed its output.")
            return
        }
        buffer.append(data)
        do {
            while buffer.count >= 4 {
                let size = buffer.prefix(4).enumerated().reduce(0) { $0 | Int($1.element) << ($1.offset * 8) }
                guard size > 0, size <= maximumFrameSize else {
                    fail("INVALID_NATIVE_FRAME", "The native host returned an invalid frame length.")
                    return
                }
                guard buffer.count >= size + 4 else { break }
                let message = try JSONSerialization.jsonObject(with: Data(buffer.dropFirst(4).prefix(size)))
                buffer.removeFirst(size + 4)
                messages.append(message)
                queuedBytes += size
                if queuedBytes > maximumFrameSize * 2 {
                    fail("NATIVE_QUEUE_FULL", "The native message consumer stopped receiving messages.")
                    return
                }
            }
            flush()
        } catch { fail("INVALID_NATIVE_JSON", "The native host returned malformed JSON.") }
    }

    func poll(_ reply: @escaping (Data) -> Void) {
        guard pollReply == nil else {
            reply(encode(failure("POLL_ALREADY_PENDING", "Only one receive request is allowed per connection.")))
            return
        }
        lastActivity = Date()
        pollReply = reply
        pollGeneration += 1
        let generation = pollGeneration
        flush()
        queue.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.pollGeneration == generation, let pending = self.pollReply else { return }
            self.pollReply = nil
            pending(encode(["ok": true, "messages": []]))
        }
    }

    func flush() {
        guard let reply = pollReply else { return }
        if !messages.isEmpty {
            pollReply = nil
            let batch = messages
            messages.removeAll(keepingCapacity: true)
            queuedBytes = 0
            reply(encode(["ok": true, "messages": batch]))
        } else if let terminalError {
            pollReply = nil
            reply(encode(terminalError))
        }
    }

    func fail(_ code: String, _ message: String) {
        guard terminalError == nil else { return }
        terminalError = failure(code, message)
        flush()
        stop()
    }

    func stop() {
        output.fileHandleForReading.readabilityHandler = nil
        diagnostics.fileHandleForReading.readabilityHandler = nil
        try? input.fileHandleForWriting.close()
        if process.isRunning { process.terminate() }
    }

    deinit { stop() }
}

final class BridgeService: NSObject, SafariNativeBridge {
    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.native-host")
    private var sessions: [String: HostSession] = [:]
    private let companion = CompanionClient()

    func handle(_ request: Data, withReply reply: @escaping (Data) -> Void) {
        queue.async { [self] in
            do {
                guard request.count <= maximumFrameSize,
                      let command = try JSONSerialization.jsonObject(with: request) as? [String: Any],
                      let operation = command["operation"] as? String else {
                    reply(encode(failure("INVALID_REQUEST", "Expected a Safari native transport request.")))
                    return
                }
                // An interrupted background must not leave native hosts running indefinitely.
                for (id, session) in sessions where Date().timeIntervalSince(session.lastActivity) > 90 {
                    session.fail("CONNECTION_EXPIRED", "The Safari background disconnected.")
                    sessions.removeValue(forKey: id)
                }
                if operation == "companion" {
                    guard let command = command["command"] as? [String: Any],
                          let action = command["action"] as? String,
                          ["open", "update", "close", "status", "poll", "resolve", "automation", "livePoll", "liveResolve", "liveInput",
                           "embeddedOpen", "embeddedUpdate", "embeddedClose", "embeddedStatus", "embeddedPoll",
                           "embeddedEntry", "embeddedLocation", "embeddedAuth"].contains(action) else {
                        reply(encode(failure("INVALID_COMPANION_COMMAND", "Unknown Safari companion operation.")))
                        return
                    }
                    companion.handle(command) { reply(encode($0)) }
                    return
                }
                if operation == "open" {
                    guard command["application"] as? String == "com.openai.codexextension",
                          let origin = command["origin"] as? String,
                          let url = URL(string: origin), url.scheme == "safari-web-extension", url.host != nil else {
                        reply(encode(failure("INVALID_HOST", "Only the registered OpenAI host and Safari extension origins are supported.")))
                        return
                    }
                    let session = try HostSession(executable: officialHost(), origin: origin, queue: queue)
                    sessions[session.id] = session
                    reply(encode(["ok": true, "connectionId": session.id]))
                    return
                }
                guard let id = command["connectionId"] as? String, let session = sessions[id] else {
                    reply(encode(failure("UNKNOWN_CONNECTION", "The native connection is no longer available.")))
                    return
                }
                switch operation {
                case "send":
                    guard let message = command["message"] as? [String: Any] else {
                        reply(encode(failure("INVALID_MESSAGE", "Expected a JSON-RPC object.")))
                        return
                    }
                    try session.send(message)
                    reply(encode(["ok": true]))
                case "poll": session.poll(reply)
                case "close":
                    session.fail("CONNECTION_CLOSED", "The Safari extension closed the connection.")
                    sessions.removeValue(forKey: id)
                    reply(encode(["ok": true]))
                default: reply(encode(failure("UNKNOWN_OPERATION", "Unknown native transport operation.")))
                }
            } catch { reply(encode(failure("NATIVE_TRANSPORT_ERROR", error.localizedDescription))) }
        }
    }

    func close() {
        queue.async { [self] in
            for session in sessions.values { session.fail("CONNECTION_CLOSED", "The Safari extension disconnected.") }
            sessions.removeAll()
        }
    }
}

final class BridgeListener: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        var code: SecCode?
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"dev.jamie.chatgpt-safari.Extension\" and certificate leaf[subject.OU] = \"N3JN8G9YWK\""
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: connection.processIdentifier] as CFDictionary, [], &code) == errSecSuccess,
              SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              let code, let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else { return false }
        let service = BridgeService()
        connection.exportedInterface = NSXPCInterface(with: SafariNativeBridge.self)
        connection.exportedObject = service
        connection.invalidationHandler = { service.close() }
        connection.resume()
        return true
    }
}
