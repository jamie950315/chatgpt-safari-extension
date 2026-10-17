import Foundation

/// Routes authenticated desktop commands to the persistent extension in each
/// real Safari profile. A delivered mutation is never retried or replayed.
final class SafariLiveBroker {
    typealias Reply = ([String: Any]) -> Void
    private struct Profile {
        let session: String
        var seen: Date
    }
    private struct Operation {
        let id: String
        let profile: String
        let session: String
        let command: [String: Any]
        let agentOwner: String?
        let reply: Reply
        var delivered = false
    }
    private let input: ([String: Any], @escaping Reply) -> Void
    private let download: ([String: Any], String, @escaping () -> Bool, @escaping Reply) -> Void
    private let cancelDownload: (String) -> Void
    private let organize: ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void
    private var profiles: [String: Profile] = [:]
    private var operation: Operation?
    private var busy = false
    private var closed = false
    private var activeAgentOwner: String?
    private var agentGeneration = 0

    init(download: @escaping ([String: Any], String, @escaping () -> Bool, @escaping Reply) -> Void = { _, _, _, reply in
            reply(SafariLiveBroker.failure("DOWNLOAD_UNAVAILABLE", "The native download writer is unavailable."))
         }, cancelDownload: @escaping (String) -> Void = { _ in },
         organize: @escaping ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void = { _, _, reply in
            reply(SafariLiveBroker.failure("ORGANIZATION_UNAVAILABLE", "Native Safari tab organization is unavailable."))
         }, input: @escaping ([String: Any], @escaping Reply) -> Void) {
        self.input = input
        self.download = download
        self.cancelDownload = cancelDownload
        self.organize = organize
    }

    func handle(_ command: [String: Any], reply: @escaping Reply) {
        precondition(Thread.isMainThread)
        switch command["action"] as? String {
        case "livePoll": poll(command, reply: reply)
        case "liveResolve": resolve(command, reply: reply)
        case "liveInput":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  let native = command["input"] as? [String: Any],
                  ["click", "type", "key", "scroll", "focus"].contains(native["action"] as? String ?? ""),
                  (native["action"] as? String != "focus" || ["interact", "organize"].contains(current.command["action"] as? String ?? "")) else {
                reply(Self.failure("STALE_OPERATION", "The live Safari input no longer belongs to an active command.")); return
            }
            input(native, reply)
        case "liveDownload", "liveOrganize":
            let isDownload = command["action"] as? String == "liveDownload"
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  current.command["action"] as? String == (isDownload ? "download_link" : "organize"),
                  let native = command["input"] as? [String: Any] else {
                reply(Self.failure("STALE_OPERATION", "This native operation no longer belongs to an active Safari command.")); return
            }
            if isDownload { download(native, current.id, { [weak self] in self?.operation?.id == current.id }, reply) }
            else {
                let expected = current.command["arguments"] as? [String: Any] ?? [:]
                guard native["action"] as? String == expected["operation"] as? String,
                      native["expectedUrl"] as? String == expected["expectedUrl"] as? String else {
                    reply(Self.failure("INVALID_COMMAND", "The native tab organization differs from the authorized command.")); return
                }
                organize(native, { [weak self] in self?.operation?.id == current.id }, reply)
            }
        case "live":
            guard let request = command["command"] as? [String: Any], let action = request["action"] as? String else {
                reply(Self.failure("INVALID_COMMAND", "A live Safari command is required.")); return
            }
            let args = request["arguments"] as? [String: Any] ?? [:]
            if action == "status" || action == "permissions" {
                input(["action": action, "prompt": args["prompt"] as? Bool ?? false]) { native in
                    guard native["ok"] as? Bool == true else { reply(native); return }
                    var result = native["result"] as? [String: Any] ?? [:]
                    result["mode"] = "existing-safari-tabs"
                    result["profiles"] = self.availableProfiles().map { ["profileId": $0] }
                    result["connected"] = !self.availableProfiles().isEmpty
                    reply(["ok": true, "result": result])
                }
            } else {
                guard !busy, !closed else {
                    reply(Self.failure("LIVE_BUSY", "Another live Safari command is running. This command was not queued or executed.")); return
                }
                busy = true
                activeAgentOwner = command["agentOwner"] as? String
                execute(action, args: args, agentOwner: activeAgentOwner, generation: agentGeneration) { result in
                    self.busy = false
                    self.activeAgentOwner = nil
                    reply(result)
                }
            }
        default: reply(Self.failure("INVALID_COMMAND", "Unknown live Safari operation."))
        }
    }

    private func availableProfiles() -> [String] {
        profiles.filter { Date().timeIntervalSince($0.value.seen) < 8 }.keys.sorted()
    }

    private func poll(_ command: [String: Any], reply: @escaping Reply) {
        guard let profile = command["profileId"] as? String, UUID(uuidString: profile) != nil,
              let session = command["sessionId"] as? String, UUID(uuidString: session) != nil, !closed else {
            reply(Self.failure("INVALID_PROFILE", "A valid live Safari profile and background session are required.")); return
        }
        if let previous = profiles[profile], previous.session != session,
           let old = operation, old.profile == profile {
            operation = nil
            cancelDownload(old.id)
            old.reply(Self.failure("BACKGROUND_CHANGED", "The Safari background restarted; the command was not replayed."))
        }
        profiles[profile] = Profile(session: session, seen: Date())
        var requests = [[String: Any]]()
        if var current = operation, current.profile == profile, current.session == session, !current.delivered {
            current.delivered = true
            operation = current
            requests = [["id": current.id, "command": current.command,
                         "deadline": Date().addingTimeInterval(35).timeIntervalSince1970 * 1000]]
            if let owner = current.agentOwner { requests[0]["agentOwner"] = owner }
        }
        reply(["ok": true, "requests": requests])
    }

    private func resolve(_ command: [String: Any], reply: @escaping Reply) {
        guard let current = operation, current.delivered,
              current.id == command["id"] as? String,
              current.profile == command["profileId"] as? String,
              current.session == command["sessionId"] as? String,
              let result = command["response"] as? [String: Any], result["ok"] is Bool else {
            reply(Self.failure("STALE_OPERATION", "This live Safari response belongs to an expired command.")); return
        }
        operation = nil
        cancelDownload(current.id)
        profiles[current.profile]?.seen = Date()
        reply(["ok": true])
        current.reply(result)
    }

    private func send(_ action: String, args: [String: Any], profile: String, agentOwner: String? = nil, reply: @escaping Reply) {
        guard let connection = profiles[profile], availableProfiles().contains(profile) else {
            reply(Self.failure("PROFILE_DISCONNECTED", "This Safari profile is disconnected. List tabs again.")); return
        }
        let id = UUID().uuidString
        operation = Operation(id: id, profile: profile, session: connection.session,
                              command: ["action": action, "arguments": args], agentOwner: agentOwner, reply: reply)
        DispatchQueue.main.asyncAfter(deadline: .now() + 40) { [weak self] in
            guard let self, let pending = self.operation, pending.id == id else { return }
            self.operation = nil
            self.cancelDownload(pending.id)
            pending.reply(Self.failure("LIVE_TIMEOUT", "Safari did not finish the live command. Its outcome is uncertain; it was not retried."))
        }
    }

    private func discover(deadline: Date, completion: @escaping ([String]) -> Void) {
        let ids = availableProfiles()
        if !ids.isEmpty || Date() >= deadline || closed { completion(ids); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.discover(deadline: deadline, completion: completion) }
    }

    private func execute(_ action: String, args: [String: Any], agentOwner: String?, generation: Int, reply: @escaping Reply) {
        guard ["list_tabs", "read_page", "interact", "navigate", "history", "select_tab", "create_tab", "close_tab",
               "organize", "download_link_inspect", "download_link"].contains(action) else {
            reply(Self.failure("UNKNOWN_ACTION", "Unknown live Safari tool.")); return
        }
        discover(deadline: Date().addingTimeInterval(5)) { ids in
            if let agentOwner, self.activeAgentOwner != agentOwner || self.agentGeneration != generation {
                reply(Self.failure("AGENT_OWNER_CHANGED", "The sidebar closed before command delivery. No input was executed.")); return
            }
            guard !ids.isEmpty else {
                reply(Self.failure("EXTENSION_DISCONNECTED", "Enable ChatGPT in Safari Extensions and allow access to the target website.")); return
            }
            if action == "list_tabs" {
                self.listProfiles(ids, tabs: [], failures: [], reply: reply)
            } else {
                let profile: String?
                if action == "create_tab" { profile = args["profileId"] as? String }
                else { profile = Self.profile(from: args["handle"] as? String ?? "") }
                guard let profile, ids.contains(profile) else {
                    reply(Self.failure("INVALID_HANDLE", "Use a handle or profileId returned by live_list_tabs.")); return
                }
                self.send(action, args: args, profile: profile, agentOwner: agentOwner, reply: reply)
            }
        }
    }

    private func listProfiles(_ ids: [String], tabs: [[String: Any]], failures: [[String: Any]], reply: @escaping Reply) {
        guard let first = ids.first else {
            reply(["ok": true, "result": ["mode": "existing-safari-tabs", "tabs": tabs,
                                            "profiles": availableProfiles().map { ["profileId": $0] }, "errors": failures]]); return
        }
        send("list_tabs", args: [:], profile: first) { result in
            let found = (result["result"] as? [String: Any])?["tabs"] as? [[String: Any]] ?? []
            let error = result["ok"] as? Bool == true ? [] : [["profileId": first, "error": result["error"] ?? "Unknown profile error"]]
            self.listProfiles(Array(ids.dropFirst()), tabs: tabs + found, failures: failures + error, reply: reply)
        }
    }

    static func profile(from handle: String) -> String? {
        let parts = handle.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "live", UUID(uuidString: String(parts[1])) != nil,
              let id = Int(parts[2]), id >= 0 else { return nil }
        return String(parts[1])
    }

    func cancelAgent(owner: String) {
        precondition(Thread.isMainThread)
        guard activeAgentOwner == owner else { return }
        activeAgentOwner = nil
        agentGeneration += 1
        guard let pending = operation, pending.agentOwner == owner else { return }
        operation = nil
        cancelDownload(pending.id)
        pending.reply(Self.failure("AGENT_OWNER_CHANGED", pending.delivered
            ? "The sidebar closed or changed during a delivered command. Its outcome may be partial; read the page before continuing and do not repeat input."
            : "The sidebar closed or changed before command delivery. No input was executed."))
    }

    func close() {
        closed = true
        if let pending = operation { operation = nil; cancelDownload(pending.id); pending.reply(Self.failure("APP_CLOSED", "The live Safari companion was closed.")) }
        profiles.removeAll()
    }

    private static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["ok": false, "error": ["code": code, "message": message]]
    }
}
