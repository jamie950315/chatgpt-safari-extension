import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    private let companionServer = CompanionControlServer()
    private let automation = SafariAutomation()
    private let liveInput = SafariLiveInput()
    private let downloads = SafariDownloadWriter()
    private let downloadQueue = DispatchQueue(label: "dev.jamie.chatgpt-safari.download-io")
    private let tabOrganization = SafariTabOrganization()
    private let personalData = SafariPersonalData()
    private let notifications = SafariNotifications()
    private let fileChooser = SafariFileChooser()
    private let viewport = SafariViewport()
    private lazy var live = SafariLiveBroker(download: { [weak self] input, operation, authorized, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.downloadQueue.async {
            let result = self.downloads.handle(input, operationID: operation, isAuthorized: {
                DispatchQueue.main.sync { authorized() }
            })
            DispatchQueue.main.async { reply(result) }
        }
    }, cancelDownload: { [weak self] operation in
        guard let self else { return }
        self.downloadQueue.async { self.downloads.cancel(operationID: operation) }
    },
    organize: { [weak self] input, authorized, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.tabOrganization.handle(input, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
    }, capture: { [weak self] input, authorized, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.liveInput.capture(input, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
    }, guardedInput: { [weak self] input, authorized, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.liveInput.handle(input, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
    }, fileChooser: { [weak self] input, authorized, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.fileChooser.handle(input, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
    }, viewport: { [weak self] input, authorized, reply in
        guard let self else { reply(["ok": false, "error": ["code": "APP_CLOSED", "message": "The Safari companion was closed."]]); return }
        self.viewport.handle(input, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
    }, cancelViewport: { [weak self] owner in
        self?.viewport.cancel(owner: owner)
    }, viewportStatus: { [weak self] reply in
        guard let self else { reply(["leaseActive": false, "restoration": "unconfirmed"]); return }
        self.viewport.status { result in DispatchQueue.main.async { reply(result) } }
    }, clipboardReceipt: { [weak self] input in
        self?.liveInput.acknowledgeClipboard(input)
    }) { [weak self] command, reply in
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
            } else if command["action"] as? String == "personalData", let self {
                let controller = EmbeddedSideChatController.shared
                let nativeProfile = (command["_nativeSafariProfile"] as? String).flatMap(UUID.init(uuidString:))
                guard let owner = command["ownerToken"] as? String, let profile = command["profileId"] as? String,
                      command["_nativeSafariProfileObserved"] as? Bool == true,
                      self.live.isProfileBound(profile, nativeProfile: nativeProfile),
                      let epoch = controller.authorization(owner: owner, profile: profile),
                      let request = command["command"] as? [String: Any], request["profileId"] as? String == profile else {
                    reply(["ok": false, "error": ["code": "STALE_OWNER", "message": "The personal-data request has no verified Safari profile and signed-in sidebar owner."]]); return
                }
                let authorized = { [weak self] in
                    controller.authorization(owner: owner, profile: profile) == epoch
                      && self?.live.isProfileBound(profile, nativeProfile: nativeProfile) == true
                }
                if request["action"] as? String == "utilityEntry" {
                    do { reply(["ok": true, "result": ["url": try self.companionServer.utilityEntry()]]) }
                    catch { reply(["ok": false, "error": ["code": "UTILITY_UNAVAILABLE", "message": "The temporary Safari bookmark page is unavailable."]]) }
                } else if ["bookmarks", "bookmarksContinue", "bookmarksCancel"].contains(request["action"] as? String ?? "") {
                    guard let expected = try? self.companionServer.utilityEntry(), request["expectedUrl"] as? String == expected else {
                        reply(["ok": false, "error": ["code": "INVALID_UTILITY_PAGE", "message": "Bookmarks must use the app's temporary operation page."]]); return
                    }
                    var signedRequest = request
                    signedRequest["_bookmarkOwnerToken"] = owner
                    if request["action"] as? String == "bookmarks" {
                        let deadline = SafariBookmarks.OperationDeadline()
                        self.liveInput.manageBookmarks(signedRequest, profileIdentity: profile + ":" + epoch.uuidString, deadline: deadline,
                            isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
                    } else {
                        self.liveInput.continueBookmarks(signedRequest, profileIdentity: profile + ":" + epoch.uuidString,
                            isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
                    }
                } else if request["action"] as? String == "notification" {
                    self.notifications.handle(request, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
                } else {
                    self.personalData.handle(request, nativeProfileUUID: nativeProfile, isAuthorized: authorized) { result in DispatchQueue.main.async { reply(result) } }
                }
            } else if ["live", "livePoll", "liveResolve", "liveInputAck", "liveInputCallbackTimeout", "liveClipboardReceipt", "liveInput", "liveDownload", "liveOrganize", "liveCapture", "liveDialog", "liveModal", "liveFileChooser", "liveViewport"].contains(command["action"] as? String ?? ""), let self {
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

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        live.close()
        // Keep the main runloop available for cancellation predicates while
        // the serial writer finishes and removes only its own partial files.
        downloadQueue.async {
            self.downloads.close()
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        EmbeddedSideChatController.shared.stop()
        automation.close()
        live.close()
        companionServer.stop()
    }
}
