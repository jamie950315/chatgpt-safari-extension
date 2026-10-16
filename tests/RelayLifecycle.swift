import Foundation

@main struct RelayLifecycleChecks {
    static func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(5)
        while !condition() && Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        precondition(condition(), "The provider lifecycle check timed out")
    }
    static func main() throws {
        let browser = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let service = ChatGPTProviderRelay(browserShim: browser, sideChatHostScript: Data("globalThis.__CHATGPT_SAFARI_ADAPTER_READY__ = Promise.resolve();".utf8))
        let conversation = URL(string: "https://chatgpt.com/c/synthetic-conversation?surface=browser_side_chat")!
        var first: ChatGPTProviderRelayEntry?, failed = false
        service.start(parentExtensionOrigin: "https://attacker.invalid", conversationURL: conversation) { result in
            if case .failure = result { failed = true }
        }
        wait { failed }
        service.start(parentExtensionOrigin: "safari-web-extension://fixture-extension", conversationURL: conversation) { result in first = try! result.get() }
        wait { first != nil }
        precondition(first!.phase == "guest" && first!.providerURL.contains("/c/synthetic-conversation?"))
        var same: ChatGPTProviderRelayEntry?
        service.start(parentExtensionOrigin: "safari-web-extension://fixture-extension", conversationURL: conversation) { result in same = try! result.get() }
        wait { same != nil }
        precondition(same!.providerURL == first!.providerURL && same!.accountScope == first!.accountScope, "Closing/reopening must retain the in-memory provider session")
        failed = false
        service.installOwnSessionCookies([]) { result in if case .failure = result { failed = true } }
        wait { failed }
        var unavailable = false
        service.entry(conversationURL: conversation) { result in if case .failure = result { unavailable = true } }
        wait { unavailable }
        service.clearOwnSession()
        var cleared: ChatGPTProviderRelayEntry?
        service.entry(conversationURL: conversation) { result in cleared = try! result.get() }
        wait { cleared != nil }
        precondition(cleared!.phase == "guest" && cleared!.accountScope != first!.accountScope && cleared!.bridgeToken != first!.bridgeToken)
        var status: [String: Any]?
        service.status { status = $0 }
        wait { status != nil }
        precondition(status!["running"] as? Bool == true && status!["phase"] as? String == "guest")
        precondition(status!["providerURL"] == nil && status!["bridgeToken"] == nil && status!["accountScope"] == nil)
        service.stop()
        var stopped = false
        service.status { stopped = $0["running"] as? Bool == false }
        wait { stopped }
        print("Provider startup, retained route, rejected session, scope invalidation, safe status, and stop checks passed")
    }
}
