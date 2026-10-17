import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private let companionServer = CompanionControlServer()
    private let automation = SafariAutomation()
    private let liveInput = SafariLiveInput()
    private lazy var live = SafariLiveBroker { [weak self] command, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.liveInput.handle(command) { result in DispatchQueue.main.async { reply(result) } }
    }
    private var serviceLaunch = false
    private var launchFinished = false
    private var pendingSideChat = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        launchFinished = true
        startCompanionServer()
        if serviceLaunch { hideSetupWindow() }
        if pendingSideChat {
            pendingSideChat = false
            SideChatCompanionController.shared.show()
        }
    }

    private func startCompanionServer() {
        EmbeddedSideChatController.shared.kernelEntry = { [weak self] origin in
            guard let self else { throw SideChatError("The Safari companion was closed") }
            return try self.companionServer.kernelEntry(parentOrigin: origin)
        }
        EmbeddedSideChatController.shared.cancelAgentCommands = { [weak self] owner in self?.live.cancelAgent(owner: owner) }
        EmbeddedSideChatController.shared.liveCommand = { [weak self] command, reply in
            guard let self else { reply(["ok": false, "error": "The Safari companion was closed"]); return }
            self.live.handle(command, reply: reply)
        }
        companionServer.commandHandler = { [weak self] command, reply in
            if command["action"] as? String == "automation" {
                guard let action = command["command"] as? [String: Any], let self else {
                    reply(["ok": false, "error": "Invalid Safari automation command"]); return
                }
                self.automation.handle(action, reply: reply)
            } else if ["live", "livePoll", "liveResolve", "liveInput"].contains(command["action"] as? String ?? ""), let self {
                self.live.handle(command, reply: reply)
            } else if (command["action"] as? String)?.hasPrefix("embedded") == true {
                EmbeddedSideChatController.shared.handle(command: command, reply: reply)
            } else {
                SideChatCompanionController.shared.handle(command: command, reply: reply)
            }
        }
        do { try companionServer.start() }
        catch {
            let alert = NSAlert()
            alert.messageText = "The Safari companion could not start"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "chatgpt-safari" && url.query == nil && url.fragment == nil {
            guard url.path.isEmpty || url.path == "/" else { continue }
            if url.host == "service" {
                serviceLaunch = true
                if launchFinished { hideSetupWindow() }
            }
            if url.host == "sidechat", url.path.isEmpty || url.path == "/" {
                if launchFinished { SideChatCompanionController.shared.show() }
                else { pendingSideChat = true }
            }
            // chatgpt-safari://service only wakes the private command listener.
        }
    }

    private func hideSetupWindow() {
        for window in NSApp.windows where window.title == "ChatGPT for Safari" {
            window.orderOut(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        EmbeddedSideChatController.shared.stop()
        automation.close()
        live.close()
        companionServer.stop()
    }
}
