import Foundation

@main struct ViewportBrokerProtocol {
    static func main() {
        var admitted = 0, cancelled = [String?](), allowed: (() -> Bool)?
        let broker = SafariLiveBroker(viewport: { _, authorized, reply in
            precondition(authorized()); admitted += 1; allowed = authorized; reply(["ok": true, "result": [:]])
        }, cancelViewport: { cancelled.append($0) }, input: { _, reply in reply(["ok": true, "result": [:]]) })
        let profile = UUID().uuidString, background = UUID().uuidString
        var pending: [String: Any] = [:]
        func poll() {
            broker.handle(["action": "livePoll", "profileId": profile, "sessionId": background]) {
                if let request = ($0["requests"] as? [[String: Any]])?.first { pending = request }
            }
        }
        let scope = ["profileId": profile, "ownerId": "owner", "accountScope": "account", "sessionId": "work-session", "turnId": "turn", "tabId": "12"]
        var input: [String: Any] = ["operation": "begin", "scope": scope.merging(["documentId": "document"]) { _, n in n }, "expectedUrl": "http://fixture.test/viewport"]
        func send(_ native: [String: Any], ok: Bool) {
            broker.handle(["action": "liveViewport", "id": pending["id"] ?? "missing", "profileId": profile, "sessionId": background, "input": native]) { precondition($0["ok"] as? Bool == ok) }
        }
        poll()
        broker.handle(["action": "live", "agentOwner": "owner", "command": ["action": "viewport", "arguments": ["operation": "set", "scope": scope,
            "handle": "live:\(profile):12", "expectedUrl": "http://fixture.test/viewport"]]]) { _ in }
        poll(); send(input, ok: true); precondition(admitted == 1)
        var changed = scope; changed["ownerId"] = "different-owner"; input["scope"] = changed.merging(["documentId": "document"]) { _, n in n }
        send(input, ok: false); precondition(admitted == 1)
        input["scope"] = scope.merging(["documentId": "document"]) { _, n in n }; input["expectedUrl"] = "https://unrelated.test/"
        send(input, ok: false)
        broker.cancelAgent(owner: "owner"); precondition(allowed?() == false && cancelled.last! == "owner")
        send(input, ok: false)
        broker.cancelAgent(owner: "idle-owner"); precondition(cancelled.last! == "idle-owner", "An idle owner still cancels its retained viewport lease")
        broker.close(); precondition(cancelled.last! == nil)
        print("Viewport broker: delivered operation, exact profile/owner/turn/tab/URL, queued authorization and idle-owner restoration cancellation passed.")
    }
}
