import Foundation

@main struct Test {
    static func main() {
        let broker = SafariLiveBroker { _, reply in reply(["ok": true, "result": ["accessibilityTrusted": false]]) }
        let profile = UUID().uuidString, session = UUID().uuidString
        var output: [String: Any]?
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) { _ in }
        broker.handle(["action": "live", "command": ["action": "read_page", "arguments": ["handle": "live:\(profile):12"]]]) { output = $0 }
        broker.handle(["action": "live", "command": ["action": "close_tab", "arguments": ["handle": "live:\(profile):12"]]]) {
            precondition(($0["error"] as? [String: Any])?["code"] as? String == "LIVE_BUSY", "Concurrent mutations must not wait beyond a client's lifetime")
        }
        var request: [String: Any] = [:]
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) { response in request = (response["requests"] as! [[String: Any]])[0] }
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) { response in precondition((response["requests"] as! [Any]).isEmpty, "Delivered commands must never replay") }
        var rejected = false
        broker.handle(["action": "liveResolve", "profileId": UUID().uuidString, "sessionId": session, "id": request["id"]!, "response": ["ok": true]]) { rejected = $0["ok"] as? Bool == false }
        precondition(rejected && output == nil, "Another profile cannot resolve a command")
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": UUID().uuidString]) { _ in }
        precondition((output?["error"] as? [String: Any])?["code"] as? String == "BACKGROUND_CHANGED")
        precondition(SafariLiveBroker.profile(from: "live:\(profile):12") == profile)
        precondition(SafariLiveBroker.profile(from: "live:\(profile):-1") == nil)
        broker.close()
        print("Live broker identity, restart invalidation, and no-replay checks passed")
    }
}
