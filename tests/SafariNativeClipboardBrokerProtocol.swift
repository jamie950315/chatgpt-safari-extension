import Foundation

@main struct SafariNativeClipboardBrokerChecks {
    static func main() {
        let profile = UUID().uuidString, background = UUID().uuidString
        let items: [[String: Any]] = [["entries": [["mime_type": "text/plain", "text": "Plain"], ["mime_type": "text/html", "text": "<b>Rich</b>"]]]]
        let scope = ["profileId": profile, "ownerId": "owner", "accountScope": "account", "sessionId": "work-session", "turnId": "work-turn", "tabId": "12", "documentId": "doc", "node": "n1"]
        let token = UUID().uuidString
        var pending: [String: Any] = [:], calls = 0, receipts = 0, allowed: (() -> Bool)?
        let broker = SafariLiveBroker(guardedInput: { _, authorized, reply in calls += 1; allowed = authorized; precondition(authorized()); reply(["ok": true, "result": ["eventsPosted": 2,
            "nativeClipboard": ["operation": "paste", "trustedPageReceipt": true, "nativeDataRead": true, "clipboardRestoration": "restored", "items": items]]]) },
            clipboardReceipt: { input in precondition(input["token"] as? String == token && input["scope"] as? [String: String] == scope); receipts += 1 },
            input: { command, reply in if command["action"] as? String == "status" { reply(["ok": true, "result": [:]]) } else { preconditionFailure("Native clipboard skipped guarded input") } })
        func poll() {
            broker.handle(["action": "livePoll", "profileId": profile, "sessionId": background]) {
                if let request = ($0["requests"] as? [[String: Any]])?.first { pending = request }
            }
        }
        let args: [String: Any] = ["handle": "live:\(profile):12", "expectedUrl": "https://fixture.test/", "documentId": "doc", "snapshotId": "snapshot",
            "agentScope": scope.filter { ["ownerId", "accountScope", "sessionId", "turnId"].contains($0.key) }, "interactions": [["type": "clipboard", "operation": "paste", "node": "n1", "items": items]]]
        let plan: [String: Any] = ["operation": "paste", "scope": scope, "items": items, "receiptToken": token]
        let native: [String: Any] = ["action": "key", "key": "Meta+v", "expectedUrl": "https://fixture.test/", "clipboardPlan": plan]
        func send(_ input: [String: Any], ok: Bool) {
            broker.handle(["action": "liveInput", "id": pending["id"] ?? "missing", "profileId": profile, "sessionId": background, "input": input]) { precondition($0["ok"] as? Bool == ok) }
        }
        poll(); broker.handle(["action": "live", "agentOwner": "owner", "command": ["action": "interact", "arguments": args]]) { _ in }; poll()
        for key in scope.keys {
            let changed = scope.merging([key: "changed"]) { _, n in n }
            send(native.merging(["clipboardPlan": plan.merging(["scope": changed]) { _, n in n }]) { _, n in n }, ok: false)
        }
        send(native.merging(["clipboardPlan": plan.merging(["items": []]) { _, n in n }]) { _, n in n }, ok: false)
        send(native.merging(["key": "Meta+x"]) { _, n in n }, ok: false)
        send(native.filter { $0.key != "clipboardPlan" }, ok: false)
        precondition(calls == 0)
        send(native, ok: true); send(native, ok: false); precondition(calls == 1)
        broker.handle(["action": "live", "command": ["action": "status"]]) { status in
            let observed = (status["result"] as! [String: Any])["lastInputObservation"] as! [String: Any]
            let clipboard = observed["clipboard"] as! [String: Any]
            precondition(clipboard["trustedPageReceipt"] as? Bool == true && clipboard["restoration"] as? String == "restored" && clipboard["items"] == nil)
        }
        broker.cancelAgent(owner: "owner"); precondition(allowed?() == false)
        send(native, ok: false); precondition(calls == 1)
        let terminal: [String: Any] = ["action": "liveClipboardReceipt", "id": pending["id"]!, "profileId": profile, "sessionId": background,
            "input": ["token": token, "scope": scope]]
        for field in ["id", "profileId", "sessionId"] {
            broker.handle(terminal.merging([field: "wrong"]) { _, n in n }) { precondition($0["ok"] as? Bool == false) }
        }
        for input: [String: Any] in [["token": UUID().uuidString, "scope": scope], ["token": token, "scope": scope.merging(["node": "wrong"]) { _, n in n }]] {
            broker.handle(terminal.merging(["input": input]) { _, n in n }) { precondition($0["ok"] as? Bool == false) }
        }
        precondition(receipts == 0)
        broker.handle(terminal) { precondition($0["ok"] as? Bool == true) }
        broker.handle(terminal) { precondition($0["ok"] as? Bool == false) }
        precondition(receipts == 1 && calls == 1, "Late owner-terminal cleanup must not grant another native input")
        broker.close()
        print("Native clipboard broker: immutable MIME bytes, exact scope, once-only dispatch, content-free diagnostics, cancellation, exact late cleanup receipt and no replay passed")
    }
}
