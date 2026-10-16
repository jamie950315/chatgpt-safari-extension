import Foundation
import Darwin

/// One persistent Apple Safari automation session, shared by the companion UI and MCP.
/// All mutable state belongs to `queue`; callbacks never run on the caller's queue.
final class SafariAutomation {
    private struct Pending {
        let complete: ([String: Any]) -> Void
        let timeout: DispatchWorkItem
    }

    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.automation")
    private let queueKey = DispatchSpecificKey<Bool>()
    private let driverURL: URL
    private let driverArguments: [String]
    private let requestTimeout: TimeInterval
    private let startupTimeout: TimeInterval
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var diagnostics: Pipe?
    private var buffer = Data()
    private var nextID = 0
    private var generation = 0
    private var pending: [Int: Pending] = [:]
    private var queuedTools: [([String: Any], ([String: Any]) -> Void)] = []
    private var toolInFlight = false
    private var readyWaiters: [([String: Any]) -> Void] = []
    private var state = "idle"
    private var sessionID: String?
    private var initialization: [String: Any]?
    private var terminalError: [String: Any]?
    private let maximumMessageSize = 16 * 1024 * 1024

    // The production caller uses the fixed Apple executable. The injectable constructor
    // allows protocol tests to exercise lifecycle failures without controlling Safari.
    init(driverURL: URL = URL(fileURLWithPath: "/usr/bin/safaridriver"),
         driverArguments: [String] = ["--mcp"],
         requestTimeout: TimeInterval = 120,
         startupTimeout: TimeInterval = 30) {
        self.driverURL = driverURL
        self.driverArguments = driverArguments
        self.requestTimeout = requestTimeout
        self.startupTimeout = startupTimeout
        queue.setSpecific(key: queueKey, value: true)
    }

    /// Returns {ok:true,result:<MCP result>} or {ok:false,error:<JSON-RPC error>}.
    /// No command is retried: a timed-out mutation may already have taken effect.
    func handle(_ command: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            guard let action = command["action"] as? String else {
                reply(Self.error(-32602, "Expected an automation action.")); return
            }
            switch action {
            case "status":
                reply(["ok": true, "result": status()])
            case "stop":
                stopSession(reason: Self.error(-32003, "The Safari automation session was stopped."))
                state = "idle"
                sessionID = nil
                initialization = nil
                terminalError = nil
                reply(["ok": true, "result": status()])
            case "initialize":
                let version = command["protocolVersion"] as? String ?? "2024-11-05"
                ensureReady(protocolVersion: version, reply: reply)
            case "tools/list":
                var params: [String: Any] = [:]
                if let cursor = command["cursor"] {
                    guard let cursor = cursor as? String else {
                        reply(Self.error(-32602, "The tools cursor must be a string.")); return
                    }
                    params["cursor"] = cursor
                }
                ensureReady { [self] result in
                    guard result["ok"] as? Bool == true else { reply(result); return }
                    request("tools/list", params: params, timeout: requestTimeout, reply: reply)
                }
            case "tools/call":
                guard let name = command["name"] as? String, !name.isEmpty,
                      command["arguments"] == nil || command["arguments"] is [String: Any] else {
                    reply(Self.error(-32602, "Expected a tool name and an arguments object.")); return
                }
                let params: [String: Any] = ["name": name, "arguments": command["arguments"] ?? [:]]
                ensureReady { [self] result in
                    guard result["ok"] as? Bool == true else { reply(result); return }
                    queuedTools.append((params, reply))
                    startNextTool()
                }
            default:
                reply(Self.error(-32601, "Unknown Safari automation action: \(action)."))
            }
        }
    }

    /// Call from application termination. It stops only this companion's driver.
    func close() {
        let finish = { [self] in
            stopSession(reason: Self.error(-32003, "The Safari companion is closing."))
            state = "idle"
        }
        if DispatchQueue.getSpecific(key: queueKey) == true { finish() }
        else { queue.sync(execute: finish) }
    }

    private func status() -> [String: Any] {
        var value: [String: Any] = [
            "state": state,
            "backend": "Apple Safari safaridriver MCP",
            "scope": "isolated_automation_session",
            "existingSafariTabsAccessible": false,
            "pendingRequests": pending.count,
            "queuedTools": queuedTools.count
        ]
        if let sessionID { value["sessionId"] = sessionID }
        if let process, process.isRunning { value["driverPID"] = process.processIdentifier }
        if let initialization { value["initialization"] = initialization }
        if let terminalError { value["error"] = terminalError["error"] }
        return value
    }

    private static func error(_ code: Int, _ message: String) -> [String: Any] {
        ["ok": false, "error": ["code": code, "message": message]]
    }

    private func startNextTool() {
        // Native tools share the active browsing context. Finish one tool before
        // starting the next, including calls submitted by different MCP clients.
        guard !toolInFlight, state == "ready", !queuedTools.isEmpty else { return }
        let (params, reply) = queuedTools.removeFirst()
        toolInFlight = true
        request("tools/call", params: params, timeout: requestTimeout) { [self] result in
            toolInFlight = false
            reply(result)
            startNextTool()
        }
    }

    private func ensureReady(protocolVersion: String = "2024-11-05",
                             reply: @escaping ([String: Any]) -> Void) {
        if state == "ready", let initialization {
            reply(["ok": true, "result": initialization]); return
        }
        if state == "failed" {
            reply(terminalError ?? Self.error(-32002, "The Safari automation session failed. Call stop before starting a new session."))
            return
        }
        readyWaiters.append(reply)
        guard state != "starting" else { return }
        state = "starting"
        sessionID = UUID().uuidString
        generation += 1
        let currentGeneration = generation
        let child = Process()
        let childInput = Pipe(), childOutput = Pipe(), childDiagnostics = Pipe()
        child.executableURL = driverURL
        child.arguments = driverArguments
        child.standardInput = childInput
        child.standardOutput = childOutput
        child.standardError = childDiagnostics
        childOutput.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            self?.queue.async { [weak self] in
                guard let self, self.generation == currentGeneration else { return }
                self.receive(data)
            }
        }
        // Drain diagnostics without exposing page contents, URLs, or credentials in logs.
        childDiagnostics.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty { handle.readabilityHandler = nil }
        }
        child.terminationHandler = { [weak self] child in
            self?.queue.async { [weak self] in
                guard let self, self.generation == currentGeneration else { return }
                self.fail(Self.error(-32002, "Safari's automation driver exited (status \(child.terminationStatus)). Call stop before starting a new session."))
            }
        }
        process = child
        input = childInput
        output = childOutput
        diagnostics = childDiagnostics
        do {
            try child.run()
            request("initialize", params: [
                "protocolVersion": protocolVersion,
                "capabilities": [:],
                "clientInfo": ["name": "ChatGPT Safari Companion", "version": "1.0.0"]
            ], timeout: startupTimeout) { [self] response in
                guard response["ok"] as? Bool == true,
                      let result = response["result"] as? [String: Any],
                      result["protocolVersion"] is String,
                      result["capabilities"] is [String: Any],
                      result["serverInfo"] is [String: Any] else {
                    fail(response["ok"] as? Bool == false ? response : Self.error(-32603, "Safari returned an invalid MCP initialization result."))
                    return
                }
                do {
                    try write(["jsonrpc": "2.0", "method": "notifications/initialized"])
                    initialization = result
                    state = "ready"
                    let waiters = readyWaiters
                    readyWaiters.removeAll()
                    for waiter in waiters { waiter(["ok": true, "result": result]) }
                } catch {
                    fail(Self.error(-32002, "Could not initialize Safari's automation channel. Call stop before starting a new session."))
                }
            }
        } catch {
            fail(Self.error(-32001, "Could not start /usr/bin/safaridriver --mcp: \(error.localizedDescription)"))
        }
    }

    private func request(_ method: String, params: [String: Any], timeout: TimeInterval,
                         reply: @escaping ([String: Any]) -> Void) {
        nextID += 1
        let id = nextID
        let currentGeneration = generation
        let timeoutWork = DispatchWorkItem { [weak self] in
            guard let self, self.generation == currentGeneration, self.pending[id] != nil else { return }
            self.fail(Self.error(-32004, "Safari automation timed out during \(method). The action was not retried; it may already have taken effect. Call stop before starting a new session."))
        }
        pending[id] = Pending(complete: reply, timeout: timeoutWork)
        queue.asyncAfter(deadline: .now() + timeout, execute: timeoutWork)
        do {
            try write(["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        } catch {
            fail(Self.error(-32002, "Could not send a request to Safari's automation driver. Call stop before starting a new session."))
        }
    }

    private func write(_ message: [String: Any]) throws {
        guard let process, process.isRunning, let input else {
            throw NSError(domain: "SafariAutomation", code: 1)
        }
        var data = try JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed])
        guard data.count <= maximumMessageSize else {
            throw NSError(domain: "SafariAutomation", code: 2)
        }
        data.append(0x0a)
        try input.fileHandleForWriting.write(contentsOf: data)
    }

    private func receive(_ data: Data) {
        guard state == "starting" || state == "ready" else { return }
        guard !data.isEmpty else {
            fail(Self.error(-32002, "Safari's automation channel closed. Call stop before starting a new session.")); return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0a) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            if line.isEmpty { continue }
            guard line.count <= maximumMessageSize,
                  let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  message["jsonrpc"] as? String == "2.0" else {
                fail(Self.error(-32700, "Safari's automation driver returned invalid JSON-RPC.")); return
            }
            // Notifications do not complete a request. Match response IDs, not output order.
            guard message["method"] == nil, let id = message["id"] as? Int,
                  let request = pending.removeValue(forKey: id) else { continue }
            request.timeout.cancel()
            if let error = message["error"] as? [String: Any] {
                request.complete(["ok": false, "error": error])
            } else if let result = message["result"] {
                request.complete(["ok": true, "result": result])
            } else {
                request.complete(Self.error(-32603, "Safari returned a response without a result or error."))
            }
        }
        if buffer.count > maximumMessageSize {
            fail(Self.error(-32700, "Safari's automation response exceeded 16 MiB."))
        }
    }

    private func fail(_ error: [String: Any]) {
        guard state != "failed" else { return }
        state = "failed"
        terminalError = error
        stopSession(reason: error)
    }

    private func stopSession(reason: [String: Any]) {
        generation += 1
        output?.fileHandleForReading.readabilityHandler = nil
        diagnostics?.fileHandleForReading.readabilityHandler = nil
        process?.terminationHandler = nil
        try? input?.fileHandleForWriting.close()
        if let process, process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning {
                // Only the child launched by this instance may be force-stopped.
                Darwin.kill(process.processIdentifier, SIGKILL)
                process.waitUntilExit()
            }
        }
        process = nil
        input = nil
        output = nil
        diagnostics = nil
        buffer.removeAll()
        let requests = pending.values
        pending.removeAll()
        let waiters = readyWaiters
        readyWaiters.removeAll()
        let tools = queuedTools
        queuedTools.removeAll()
        toolInFlight = false
        for request in requests {
            request.timeout.cancel()
            request.complete(reason)
        }
        for waiter in waiters { waiter(reason) }
        for (_, reply) in tools { reply(reason) }
    }

    deinit {
        output?.fileHandleForReading.readabilityHandler = nil
        diagnostics?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close()
        if let process, process.isRunning { process.terminate() }
    }
}
