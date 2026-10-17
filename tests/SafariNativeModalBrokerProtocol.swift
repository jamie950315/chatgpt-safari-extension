import Foundation

@main struct SafariNativeModalBrokerChecks {
    static func main() {
        let profile = UUID().uuidString, background = UUID().uuidString
        var calls = 0, allowed: (() -> Bool)?, pending: [String: Any] = [:]
        let broker = SafariLiveBroker(guardedInput: { _, authorized, reply in
            precondition(authorized()); calls += 1; allowed = authorized; reply(["ok": true, "result": ["eventsPosted": 2]])
        }, input: { _, _ in preconditionFailure("The guarded native input must own modal response delivery") })
        func poll() {
            broker.handle(["action": "livePoll", "profileId": profile, "sessionId": background]) {
                if let request = ($0["requests"] as? [[String: Any]])?.first { pending = request }
            }
        }
        let scope = ["profileId": profile, "ownerId": "owner", "accountScope": "account", "sessionId": "original-session", "turnId": "turn",
                     "tabId": "12", "documentId": "document", "node": "n1"]
        let policy: [String: Any] = ["kind": "dialog", "type": "prompt", "message": "Exact?", "accept": true, "promptText": "Answer", "timeout_ms": 10000]
        let arguments: [String: Any] = ["handle": "live:\(profile):12", "expectedUrl": "https://example.test/", "documentId": "document", "snapshotId": "snapshot",
            "agentScope": scope.filter { ["ownerId", "accountScope", "sessionId", "turnId"].contains($0.key) },
            "nativeModal": policy, "interactions": [["type": "click", "node": "n1"]]]
        let native: [String: Any] = ["action": "click", "expectedUrl": "https://example.test/", "modalPlan": ["policy": policy, "scope": scope]]
        func send(_ input: [String: Any], ok: Bool) {
            broker.handle(["action": "liveInput", "id": pending["id"] ?? "missing", "profileId": profile, "sessionId": background, "input": input]) {
                precondition($0["ok"] as? Bool == ok, String(describing: $0))
            }
        }
        poll()
        broker.handle(["action": "live", "agentOwner": "owner", "command": ["action": "interact", "arguments": arguments]]) { _ in }
        poll()
        for field in ["ownerId", "accountScope", "sessionId", "turnId", "tabId", "documentId", "node"] {
            let changed = scope.merging([field: "changed"]) { _, n in n }
            send(native.merging(["modalPlan": ["policy": policy, "scope": changed]]) { _, n in n }, ok: false)
        }
        send(native.merging(["modalPlan": ["policy": policy.merging(["accept": false]) { _, n in n }, "scope": scope]]) { _, n in n }, ok: false)
        send(native.filter { $0.key != "modalPlan" }, ok: false)
        precondition(calls == 0)
        send(native, ok: true); precondition(calls == 1)
        send(native, ok: false); precondition(calls == 1, "A second delivery cannot consume the response or replay the opening click")
        broker.cancelAgent(owner: "owner"); precondition(allowed?() == false)
        send(native, ok: false); precondition(calls == 1)
        broker.close()
        print("Native modal broker: exact owner/account/profile/session/turn/tab/document/node and response policy, once-only dispatch, cancellation and no replay passed")
    }
}
