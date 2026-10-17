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
        let agentSession = UUID().uuidString, agentOwner = UUID().uuidString
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": agentSession]) { _ in }
        output = nil
        broker.handle(["action": "live", "agentOwner": agentOwner,
                       "command": ["action": "interact", "arguments": ["handle": "live:\(profile):12"]]]) { output = $0 }
        broker.cancelAgent(owner: "unrelated-owner")
        precondition(output == nil)
        broker.cancelAgent(owner: agentOwner)
        precondition((output?["error"] as? [String: Any])?["code"] as? String == "AGENT_OWNER_CHANGED")
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": agentSession]) { response in
            precondition((response["requests"] as! [Any]).isEmpty, "Closed sidebar commands must not be delivered later")
        }
        output = nil
        broker.handle(["action": "live", "agentOwner": agentOwner,
                       "command": ["action": "interact", "arguments": ["handle": "live:\(profile):12"]]]) { output = $0 }
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": agentSession]) { response in
            request = (response["requests"] as! [[String: Any]])[0]
        }
        broker.cancelAgent(owner: agentOwner)
        precondition((output?["error"] as? [String: Any])?["code"] as? String == "AGENT_OWNER_CHANGED")
        precondition(((output?["error"] as? [String: Any])?["message"] as? String)?.contains("partial") == true)
        broker.handle(["action": "liveInput", "profileId": profile, "sessionId": agentSession,
                       "id": request["id"]!, "input": ["action": "type"]]) {
            precondition(($0["error"] as? [String: Any])?["code"] as? String == "STALE_OPERATION",
                         "A delivered agent command cannot post more input after owner cancellation")
        }
        broker.close()
        print("Live broker identity, restart invalidation, and no-replay checks passed")
    }
}
