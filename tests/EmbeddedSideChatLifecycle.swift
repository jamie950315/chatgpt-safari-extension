import Foundation

@main struct EmbeddedSideChatLifecycleChecks {
    static func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(5)
        while !condition() && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        precondition(condition(), "The embedded authentication lifecycle check timed out")
    }
    static func main() {
        var opened: [Bool] = [], cancelled: [String] = []
        var sessionResult: Result<Void, Error> = .failure(ProviderRelayError.missingSession)
        var held: ((Result<Void, Error>) -> Void)?
        var hold = false, imports = 0
        let controller = EmbeddedSideChatController(relayResources: {
            (Data("/* synthetic browser shim */".utf8), Data("/* synthetic side-chat boundary */".utf8))
        }, installProfileSession: { _, completion in
            imports += 1
            if hold { held = completion } else { completion(sessionResult) }
        }, openAuthentication: { opened.append($0) })
        controller.cancelAgentCommands = { cancelled.append($0) }
        let owner = UUID().uuidString
        let profile = UUID().uuidString
        let context: [String: Any] = ["instanceId": UUID().uuidString, "tabId": 5, "windowId": 7, "url": "https://example.test/"]
        func command(_ action: String, fields: [String: Any] = [:], token: String? = nil) -> [String: Any] {
            var result: [String: Any]?
            controller.handle(command: ["action": action, "ownerToken": token ?? owner].merging(fields) { _, new in new }) { result = $0 }
            wait { result != nil }
            return result!
        }
        let openedState = command("embeddedOpen", fields: ["context": context, "parentExtensionOrigin": "safari-web-extension://fixture-extension", "liveProfileId": profile])
        precondition(openedState["ok"] as? Bool == true)
        precondition((openedState["state"] as? [String: Any])?["ownerAvailable"] as? Bool == true)
        precondition((command("embeddedEntry")["entry"] as? [String: Any])?["authentication"] != nil)
        precondition(command("embeddedPoll")["documentRecoverySequence"] == nil)
        precondition(command("embeddedBrowserSession")["session"] is NSNull)
        precondition(command("embeddedAuth", fields: ["authOperation": "open"])["ok"] as? Bool == true && opened == [false])
        precondition(command("embeddedAuth", fields: ["authOperation": "importCookies"])["ok"] as? Bool == false)
        precondition(command("embeddedAuth", fields: ["authOperation": "resume", "state": "signed_in"])["ok"] as? Bool == false)
        let failedResume = command("embeddedAuth", fields: ["authOperation": "resume"])
        precondition(failedResume["ok"] as? Bool == false && imports == 2)
        sessionResult = .success(())
        precondition(command("embeddedAuth", fields: ["authOperation": "resume"])["ok"] as? Bool == true)
        precondition((command("embeddedEntry")["entry"] as? [String: Any])?["providerURL"] is String)
        precondition(command("embeddedPoll")["documentRecoverySequence"] as? Int == 0)
        precondition(command("embeddedPoll", token: "stale")["ok"] as? Bool == false)
        let epoch = controller.authorization(owner: owner, profile: profile)
        precondition(epoch != nil && controller.authorization(owner: "stale", profile: profile) == nil)
        let expired = command("embeddedAuth", fields: ["state": "expired"])
        precondition((expired["authentication"] as? [String: Any])?["state"] as? String == "expired")
        precondition(cancelled == [owner] && command("embeddedBrowserSession")["session"] is NSNull)
        precondition(controller.authorization(owner: owner, profile: profile) == nil)
        precondition(command("embeddedPoll")["documentRecoverySequence"] == nil)
        hold = true
        var resumed: [String: Any]?
        controller.handle(command: ["action": "embeddedAuth", "ownerToken": owner, "authOperation": "resume"]) { resumed = $0 }
        wait { held != nil }
        precondition(command("embeddedAuth", fields: ["authOperation": "resume"])["ok"] as? Bool == false)
        let replacement = UUID().uuidString
        _ = command("embeddedOpen", fields: ["context": context, "parentExtensionOrigin": "safari-web-extension://fixture-extension"], token: replacement)
        held?(.success(()))
        wait { resumed != nil }
        precondition(resumed?["ok"] as? Bool == false)
        let state = command("embeddedStatus", token: replacement)["state"] as! [String: Any]
        precondition(state["relayReady"] as? Bool == false && state["ownerToken"] as? String == replacement)
        precondition(command("embeddedAuth", fields: ["authOperation": "open"])["ok"] as? Bool == false, "A stale owner cannot open app-profile authentication")
        controller.stop()
        print("Embedded side chat: missing-session recovery, explicit app-profile authentication, session resume, sign-out, and stale-owner cancellation passed")
    }
}
