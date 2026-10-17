import Foundation

/// Routes authenticated desktop commands to the persistent extension in each
/// real Safari profile. A delivered mutation is never retried or replayed.
final class SafariLiveBroker {
    typealias Reply = ([String: Any]) -> Void
    private struct Profile {
        let session: String
        var seen: Date
        let selection: [String: Any]?
        let nativeProfile: String?
        let nativeProfileObserved: Bool
    }
    private struct Operation {
        let id: String
        let profile: String
        let session: String
        let command: [String: Any]
        let agentOwner: String?
        let reply: Reply
        var delivered = false
        var fileChooserTarget: [String: Any]?
        var inputTarget: [String: Any]?
        var modalInputDelivered = false
        var clipboardInputDelivered = false
    }
    private let input: ([String: Any], @escaping Reply) -> Void
    private let guardedInput: (([String: Any], @escaping () -> Bool, @escaping Reply) -> Void)?
    private let download: ([String: Any], String, @escaping () -> Bool, @escaping Reply) -> Void
    private let cancelDownload: (String) -> Void
    private let organize: ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void
    private let capture: ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void
    private let fileChooser: ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void
    private let viewport: ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void
    private let cancelViewport: (String?) -> Void
    private let viewportStatus: (@escaping Reply) -> Void
    private let clipboardReceipt: ([String: Any]) -> Void
    private struct ClipboardReceipt { let id: String; let profile: String; let session: String; let scope: [String: String]; let expires: Date }
    private var clipboardReceipts: [String: ClipboardReceipt] = [:]
    private var profiles: [String: Profile] = [:]
    private var operation: Operation?
    private var busy = false
    private var closed = false
    private var activeAgentOwner: String?
    private var agentGeneration = 0
    private var lastInputObservation: [String: Any]?
    private var inputSequence = 0
    private var inputObservedAt = Date()
    private var inputOperation: String?

    init(download: @escaping ([String: Any], String, @escaping () -> Bool, @escaping Reply) -> Void = { _, _, _, reply in
            reply(SafariLiveBroker.failure("DOWNLOAD_UNAVAILABLE", "The native download writer is unavailable."))
         }, cancelDownload: @escaping (String) -> Void = { _ in },
         organize: @escaping ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void = { _, _, reply in
            reply(SafariLiveBroker.failure("ORGANIZATION_UNAVAILABLE", "Native Safari tab organization is unavailable."))
         }, capture: @escaping ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void = { _, _, reply in
            reply(SafariLiveBroker.failure("CAPTURE_UNAVAILABLE", "Native Safari page capture is unavailable."))
         }, guardedInput: (([String: Any], @escaping () -> Bool, @escaping Reply) -> Void)? = nil,
         fileChooser: @escaping ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void = { _, _, reply in
            reply(SafariLiveBroker.failure("FILE_CHOOSER_UNAVAILABLE", "Native Safari upload selection is unavailable."))
         },
          viewport: @escaping ([String: Any], @escaping () -> Bool, @escaping Reply) -> Void = { _, _, reply in
             reply(SafariLiveBroker.failure("VIEWPORT_UNAVAILABLE", "Native Safari viewport sizing is unavailable."))
          }, cancelViewport: @escaping (String?) -> Void = { _ in },
          viewportStatus: @escaping (@escaping Reply) -> Void = { reply in reply(["leaseActive": false, "restoration": "not-needed"]) },
         clipboardReceipt: @escaping ([String: Any]) -> Void = { _ in },
         input: @escaping ([String: Any], @escaping Reply) -> Void) {
        self.input = input
        self.guardedInput = guardedInput
        self.download = download
        self.cancelDownload = cancelDownload
        self.organize = organize
        self.capture = capture
        self.fileChooser = fileChooser
        self.viewport = viewport
        self.cancelViewport = cancelViewport
        self.viewportStatus = viewportStatus
        self.clipboardReceipt = clipboardReceipt
    }

    func handle(_ command: [String: Any], reply: @escaping Reply) {
        precondition(Thread.isMainThread)
        switch command["action"] as? String {
        case "livePoll": poll(command, reply: reply)
        case "liveResolve": resolve(command, reply: reply)
        case "liveClipboardReceipt":
            guard let input = command["input"] as? [String: Any], let token = input["token"] as? String,
                  let entry = clipboardReceipts[token], entry.expires > Date(), entry.id == command["id"] as? String,
                  entry.profile == command["profileId"] as? String, entry.session == command["sessionId"] as? String,
                  entry.scope == input["scope"] as? [String: String] else {
                reply(Self.failure("STALE_CLIPBOARD_RECEIPT", "This clipboard observation has no matching delivered native shortcut.")); return
            }
            // A terminal observation can finish clipboard restoration after an
            // owner/turn ends. It grants no input or page-read authority.
            clipboardReceipts.removeValue(forKey: token)
            clipboardReceipt(input); reply(["ok": true])
        case "liveViewport":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  current.command["action"] as? String == "viewport",
                  let owner = current.agentOwner,
                  let args = current.command["arguments"] as? [String: Any],
                  let originalScope = args["scope"] as? [String: String],
                  let native = command["input"] as? [String: Any],
                  let scope = native["scope"] as? [String: String],
                  scope["profileId"] == current.profile, scope["ownerId"] == owner,
                  originalScope.allSatisfy({ scope[$0.key] == $0.value }),
                  Set(scope.keys) == Set(originalScope.keys).union(["documentId"]),
                  native["expectedUrl"] as? String == args["expectedUrl"] as? String,
                  args["handle"] as? String == "live:\(current.profile):\(scope["tabId"] ?? "")",
                  let action = native["operation"] as? String,
                  (args["operation"] as? String == "set" ? ["begin", "resize", "check", "restore", "commitReturnPage"].contains(action) : action == "restore") else {
                reply(Self.failure("STALE_OPERATION", "Native viewport sizing requires this exact delivered owner/profile/turn/tab command.")); return
            }
            if action == "commitReturnPage" {
                guard let returned = args["returnTarget"] as? [String: Any],
                      native["returnUrl"] as? String == returned["url"] as? String,
                      native["returnTabId"] as? Int == returned["tabId"] as? Int else {
                    reply(Self.failure("STALE_OPERATION", "Viewport rollback can bind only the exact successfully restored sidebar owner page.")); return
                }
            }
            viewport(native, { [weak self] in self?.operation?.id == current.id }, reply)
        case "liveInputCallbackTimeout":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String, inputOperation == current.id else {
                reply(Self.failure("STALE_OPERATION", "This callback observation belongs to an expired input.")); return
            }
            lastInputObservation?["callbackTimeoutReported"] = true
            reply(["ok": true])
        case "liveInputAck":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  command["receiptSequence"] as? Int == inputSequence,
                  inputOperation == current.id, lastInputObservation?["stage"] as? String == "native_replied" else {
                reply(Self.failure("STALE_OPERATION", "The native input receipt belongs to an expired command.")); return
            }
            lastInputObservation?["stage"] = "extension_ack"
            inputObservedAt = Date()
            reply(["ok": true])
        case "liveInput":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  let native = command["input"] as? [String: Any],
                  ["click", "type", "key", "scroll", "focus", "move", "drag", "select"].contains(native["action"] as? String ?? ""),
                  (native["action"] as? String == "focus"
                    ? ["interact", "organize", "dom_query", "screenshot", "dialog"].contains(current.command["action"] as? String ?? "")
                    : current.command["action"] as? String == "interact"),
                  (native["allowJavaScriptDialog"] as? Bool != true || current.command["action"] as? String == "dialog") else {
                reply(Self.failure("STALE_OPERATION", "The live Safari input no longer belongs to an active command.")); return
            }
            let arguments = current.command["arguments"] as? [String: Any] ?? [:]
            let clipboardInteractions = (arguments["interactions"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "clipboard" }
            if native["clipboardPlan"] != nil || !clipboardInteractions.isEmpty {
                guard current.command["action"] as? String == "interact", let owner = current.agentOwner,
                      let agent = arguments["agentScope"] as? [String: String], agent["ownerId"] == owner,
                      arguments["nativeModal"] == nil, clipboardInteractions.count == 1,
                      (arguments["interactions"] as? [Any])?.count == 1 else {
                    reply(Self.failure("INVALID_NATIVE_CLIPBOARD", "A transient clipboard shortcut requires one original agent interaction and its signed-in owner.")); return
                }
                if native["action"] as? String == "focus" {
                    guard native["clipboardPlan"] == nil else { reply(Self.failure("INVALID_NATIVE_CLIPBOARD", "Clipboard contents cannot attach to focus.")); return }
                } else {
                    let expected = clipboardInteractions[0]
                    guard !current.clipboardInputDelivered, native["action"] as? String == "key",
                          let plan = native["clipboardPlan"] as? [String: Any], let scope = plan["scope"] as? [String: String], scope.count == 8,
                          let receiptToken = plan["receiptToken"] as? String, UUID(uuidString: receiptToken) != nil,
                          scope["profileId"] == current.profile, scope["ownerId"] == owner,
                          ["accountScope", "sessionId", "turnId"].allSatisfy({ scope[$0] != nil && scope[$0] == agent[$0] }),
                          scope["documentId"] == arguments["documentId"] as? String, scope["node"] == expected["node"] as? String,
                          arguments["handle"] as? String == "live:\(current.profile):\(scope["tabId"] ?? "")",
                          arguments["expectedUrl"] as? String == native["expectedUrl"] as? String,
                          let operation = plan["operation"] as? String, operation == expected["operation"] as? String,
                          native["key"] as? String == ["copy": "Meta+c", "cut": "Meta+x", "paste": "Meta+v"][operation] else {
                        reply(Self.failure("INVALID_NATIVE_CLIPBOARD", "A native clipboard shortcut may be delivered once only for its exact authorized account, turn, document and focused node.")); return
                    }
                    if operation == "paste" {
                        guard let items = expected["items"] as? NSArray, let supplied = plan["items"] as? NSArray, items.isEqual(supplied) else {
                            reply(Self.failure("INVALID_NATIVE_CLIPBOARD", "Native paste bytes differ from the explicit session clipboard items.")); return
                        }
                    } else if plan["items"] != nil { reply(Self.failure("INVALID_NATIVE_CLIPBOARD", "Native copy/cut cannot import supplied clipboard contents.")); return }
                    self.operation?.clipboardInputDelivered = true
                    clipboardReceipts = clipboardReceipts.filter { $0.value.expires > Date() }
                    clipboardReceipts[receiptToken] = ClipboardReceipt(id: current.id, profile: current.profile, session: current.session,
                        scope: scope, expires: Date().addingTimeInterval(120))
                }
            }
            if arguments["nativeModal"] != nil || native["modalPlan"] != nil {
                guard current.command["action"] as? String == "interact", let owner = current.agentOwner,
                      let policy = arguments["nativeModal"] as? NSDictionary,
                      let agent = arguments["agentScope"] as? [String: String], agent["ownerId"] == owner else {
                    reply(Self.failure("INVALID_NATIVE_MODAL", "Preregistered modal responses require the exact original agent command and signed-in owner.")); return
                }
                if native["action"] as? String == "focus" {
                    guard native["modalPlan"] == nil else { reply(Self.failure("INVALID_NATIVE_MODAL", "A modal response cannot attach to focus.")); return }
                } else {
                    guard !current.modalInputDelivered, native["action"] as? String == "click",
                          let plan = native["modalPlan"] as? [String: Any], let supplied = plan["policy"] as? NSDictionary, policy.isEqual(supplied),
                          let scope = plan["scope"] as? [String: String], scope.count == 8,
                          scope["profileId"] == current.profile, scope["ownerId"] == owner,
                          ["accountScope", "sessionId", "turnId"].allSatisfy({ scope[$0] != nil && scope[$0] == agent[$0] }),
                          scope["documentId"] == arguments["documentId"] as? String,
                          arguments["handle"] as? String == "live:\(current.profile):\(scope["tabId"] ?? "")",
                          native["expectedUrl"] as? String == arguments["expectedUrl"] as? String,
                          let interactions = arguments["interactions"] as? [[String: Any]], interactions.count == 1,
                          interactions[0]["type"] as? String == "click", interactions[0]["node"] as? String == scope["node"] else {
                        reply(Self.failure("INVALID_NATIVE_MODAL", "A modal response may be consumed once only by its exact authorized source click, account, turn, document and node.")); return
                    }
                    if policy["kind"] as? String == "upload" {
                        guard let source = arguments["uploadSource"] as? [String: Any], source["node"] as? String == scope["node"],
                              let observed = source["isMultiple"] as? Bool, plan["isMultiple"] as? Bool == observed else {
                            reply(Self.failure("UPLOAD_SOURCE_CHANGED", "The native upload no longer matches the original approved file input.")); return
                        }
                    }
                    operation?.modalInputDelivered = true
                }
            }
            dispatchInput(native, current: current, reply: reply)
        case "liveModal":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  current.command["action"] as? String == "interact",
                  let target = current.inputTarget, var native = command["input"] as? [String: Any],
                  native["expectedUrl"] as? String == target["expectedUrl"] as? String,
                  let bounds = native["windowBounds"] as? NSDictionary,
                  let deliveredBounds = target["windowBounds"] as? NSDictionary, bounds.isEqual(deliveredBounds) else {
                reply(Self.failure("STALE_OPERATION", "Modal observation requires this command's exact delivered native input target.")); return
            }
            native["action"] = "modalStatus"
            dispatchInput(native, current: current, reply: reply)
        case "liveCapture", "liveDialog":
            let isCapture = command["action"] as? String == "liveCapture"
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  current.command["action"] as? String == (isCapture ? "screenshot" : "dialog"),
                  var native = command["input"] as? [String: Any] else {
                reply(Self.failure("STALE_OPERATION", "This native browser operation no longer belongs to an active Safari command.")); return
            }
            if isCapture { capture(native, { [weak self] in self?.operation?.id == current.id }, reply) }
            else {
                guard let action = native["action"] as? String, ["inspect", "accept", "dismiss"].contains(action) else {
                    reply(Self.failure("INVALID_COMMAND", "Unknown JavaScript dialog operation.")); return
                }
                native["operation"] = action
                native["action"] = "dialog"
                dispatchInput(native, current: current, reply: reply)
            }
        case "liveFileChooser":
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String, current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  var native = command["input"] as? [String: Any], let scope = native["scope"] as? [String: String],
                  scope["profileId"] == current.profile, let owner = current.agentOwner, scope["ownerId"] == owner,
                  let args = current.command["arguments"] as? [String: Any],
                  (args["handle"] as? String)?.split(separator: ":").last.map(String.init) == scope["tabId"],
                  let action = native["operation"] as? String else {
                reply(Self.failure("STALE_OPERATION", "This upload request has no matching delivered Safari command and owner.")); return
            }
            if current.command["action"] as? String == "interact" {
                guard action == "inspect", let target = current.fileChooserTarget,
                      let base = args["fileChooserScope"] as? [String: String], base.count == 6, scope.count == 7,
                      base.allSatisfy({ scope[$0.key] == $0.value }), scope["documentId"] == args["documentId"] as? String,
                      native["expectedUrl"] as? String == target["expectedUrl"] as? String,
                      let bounds = native["windowBounds"] as? NSDictionary, let observedBounds = target["windowBounds"] as? NSDictionary,
                      bounds.isEqual(observedBounds) else {
                    reply(Self.failure("UNVERIFIED_FILE_CHOOSER", "Upload inspection requires the exact native panel opened by this delivered input.")); return
                }
            } else {
                guard current.command["action"] as? String == "filechooser", ["setFiles", "cancel"].contains(action),
                      action == args["operation"] as? String, scope == args["scope"] as? [String: String],
                      native["chooserId"] as? String == args["chooserId"] as? String,
                      (action != "setFiles" || native["files"] as? [String] == args["files"] as? [String]) else {
                    reply(Self.failure("INVALID_COMMAND", "The upload differs from the original authorized chooser request.")); return
                }
            }
            native["action"] = "fileChooser"
            fileChooser(native, { [weak self] in self?.operation?.id == current.id }, reply)
        case "liveDownload", "liveOrganize":
            let isDownload = command["action"] as? String == "liveDownload"
            guard let current = operation, current.delivered,
                  current.id == command["id"] as? String,
                  current.profile == command["profileId"] as? String,
                  current.session == command["sessionId"] as? String,
                  (isDownload ? ["download_link", "asset_bundle", "content_export", "download_intent_transfer"].contains(current.command["action"] as? String ?? "")
                    : current.command["action"] as? String == "organize"),
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
                    result["selectionDiagnostics"] = self.profiles.compactMapValues(\.selection)
                    if var observed = self.lastInputObservation {
                        observed["ageMs"] = max(0, Int(Date().timeIntervalSince(self.inputObservedAt) * 1000))
                        result["lastInputObservation"] = observed
                    }
                    self.viewportStatus { status in
                        result["viewport"] = status
                        reply(["ok": true, "result": result])
                    }
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

    private func dispatchInput(_ native: [String: Any], current: Operation, reply: @escaping Reply) {
        let authorized = { [weak self] in self?.operation?.id == current.id }
        inputSequence += 1
        let sequence = inputSequence
        inputOperation = current.id
        inputObservedAt = Date()
        lastInputObservation = ["sequence": sequence, "stage": "input_received", "action": native["action"] as? String ?? "unknown"]
        let completed: Reply = { [weak self] result in
            if self?.inputSequence == sequence {
                let value = result["result"] as? [String: Any] ?? [:]
                let code = (result["error"] as? [String: Any])?["code"] as? String ?? ""
                self?.lastInputObservation = ["sequence": sequence, "stage": "native_replied", "ok": result["ok"] as? Bool ?? false,
                    "errorCode": code.range(of: "^[A-Z_]{0,80}$", options: .regularExpression) != nil ? code : "UNCLASSIFIED",
                    "action": native["action"] as? String ?? "unknown",
                    "eventsPosted": value["eventsPosted"] as? Int ?? 0,
                    "dialogOpen": value["dialogOpen"] as? Bool ?? false,
                    "fileChooserOpen": value["fileChooserOpen"] as? Bool ?? false]
                if let clipboard = value["nativeClipboard"] as? [String: Any] {
                    // Diagnostics retain only fixed metadata, never MIME data.
                    self?.lastInputObservation?["clipboard"] = [
                        "operation": ["copy", "cut", "paste"].contains(clipboard["operation"] as? String ?? "") ? clipboard["operation"]! : "unknown",
                        "trustedPageReceipt": clipboard["trustedPageReceipt"] as? Bool ?? false,
                        "nativeDataRead": clipboard["nativeDataRead"] as? Bool ?? false,
                        "restoration": ["restored", "unchanged", "newer-change-preserved"].contains(clipboard["clipboardRestoration"] as? String ?? "") ? clipboard["clipboardRestoration"]! : "unconfirmed"]
                }
                self?.inputObservedAt = Date()
            }
            if result["ok"] as? Bool == true,
               let value = result["result"] as? [String: Any], (value["eventsPosted"] as? Int ?? 0) > 0,
               self?.operation?.id == current.id, current.command["action"] as? String == "interact" {
                self?.operation?.inputTarget = ["expectedUrl": native["expectedUrl"] as Any, "windowBounds": native["windowBounds"] as Any]
            }
            if result["ok"] as? Bool == true, (result["result"] as? [String: Any])?["fileChooserOpen"] as? Bool == true,
               self?.operation?.id == current.id {
                self?.operation?.fileChooserTarget = ["expectedUrl": native["expectedUrl"] as Any, "windowBounds": native["windowBounds"] as Any]
            }
            var envelope = result
            envelope["inputReceiptSequence"] = sequence
            reply(envelope)
        }
        if let guardedInput { guardedInput(native, authorized, completed) }
        else { input(native, completed) } // Preserve the original injected-input contract.
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
        let native = (command["_nativeSafariProfile"] as? String).flatMap { UUID(uuidString: $0)?.uuidString }
        profiles[profile] = Profile(session: session, seen: Date(), selection: Self.selectionDiagnostics(command["selection"]), nativeProfile: native,
                                    nativeProfileObserved: command["_nativeSafariProfileObserved"] as? Bool == true)
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
        if inputOperation == current.id { lastInputObservation?["stage"] = "resolve_received"; inputObservedAt = Date() }
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
               "organize", "download_link_inspect", "download_link", "download_intent_transfer", "download_intent_redirect", "dom_query", "screenshot", "dialog", "asset_bundle", "content_export", "filechooser", "viewport"].contains(action) else {
            reply(Self.failure("UNKNOWN_ACTION", "Unknown live Safari tool.")); return
        }
        if ["download_intent_transfer", "download_intent_redirect"].contains(action), agentOwner == nil {
            reply(Self.failure("INVALID_COMMAND", "A captured download intent requires its original signed-in sidebar owner.")); return
        }
        discover(deadline: Date().addingTimeInterval(5)) { ids in
            if let agentOwner, self.activeAgentOwner != agentOwner || self.agentGeneration != generation {
                reply(Self.failure("AGENT_OWNER_CHANGED", "The sidebar closed before command delivery. No input was executed.")); return
            }
            guard !ids.isEmpty else {
                reply(Self.failure(self.profiles.isEmpty ? "EXTENSION_DISCONNECTED" : "EXTENSION_UNRESPONSIVE",
                    self.profiles.isEmpty ? "Enable ChatGPT in Safari Extensions and allow access to the target website."
                      : "Safari's existing background connection stopped responding. Inspect pending browser dialogs and current page state; do not replay possibly delivered input.")); return
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

    func isProfileBound(_ profile: String, nativeProfile: UUID?) -> Bool {
        precondition(Thread.isMainThread)
        guard let bound = profiles[profile], bound.nativeProfileObserved, availableProfiles().contains(profile) else { return false }
        return bound.nativeProfile == nativeProfile?.uuidString
    }

    /// Bounded native-group lifecycle evidence, without page data or capabilities.
    static func selectionDiagnostics(_ input: Any?) -> [String: Any]? {
        guard let input = input as? [String: Any], let phase = input["phase"] as? String,
              ["idle", "native", "verified", "rejected", "inventory_unavailable"].contains(phase) else { return nil }
        var result: [String: Any] = ["phase": phase]
        if let action = input["action"] as? String,
           ["createGroup", "moveToGroup", "moveToUngrouped"].contains(action) { result["action"] = action }
        if let failure = input["failure"] as? [String: Any],
           let stage = failure["stage"] as? String,
           ["native", "source_proof", "selected_proof", "owner_rebind", "owner_unmount", "owner_mount", "owner_commit"].contains(stage),
           let code = failure["code"] as? String,
           ["FOCUS_CHANGED", "LIVE_TIMEOUT", "COMPANION_NOT_RUNNING", "STALE_TARGET", "AGENT_OWNER_CHANGED", "UNCLASSIFIED",
            "REBIND_STATE", "REBIND_CONTEXT", "REBIND_SNAPSHOT", "REBIND_CONVERSATION"].contains(code) {
            result["failure"] = ["stage": stage, "code": code]
        }
        func identifier(_ value: Any?) -> Int? {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
                  number.doubleValue >= -1, number.doubleValue < Double(Int.max) else { return nil }
            return number.intValue
        }
        for key in ["before", "after"] {
            result[key] = ((input[key] as? [[String: Any]]) ?? []).prefix(256).compactMap { item -> [String: Any]? in
                guard let tab = identifier(item["tabId"]), tab > 0,
                      let window = identifier(item["windowId"]), window > 0,
                      let active = item["active"] as? Bool else { return nil }
                return ["tabId": tab, "windowId": window, "active": active]
            }
        }
        let events: Set<String> = ["tabCreated", "tabRemoved", "tabActivated", "tabAttached", "tabDetached",
                                   "windowCreated", "windowRemoved", "windowFocusChanged"]
        result["events"] = ((input["events"] as? [[String: Any]]) ?? []).suffix(64).compactMap { item -> [String: Any]? in
            guard let type = item["type"] as? String, events.contains(type) else { return nil }
            var event: [String: Any] = ["type": type]
            for key in ["tabId", "windowId", "oldWindowId", "newWindowId"] {
                if let id = identifier(item[key]) { event[key] = id }
            }
            return event
        }
        return result
    }

    func cancelAgent(owner: String) {
        precondition(Thread.isMainThread)
        cancelViewport(owner)
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
        cancelViewport(nil)
        if let pending = operation { operation = nil; cancelDownload(pending.id); pending.reply(Self.failure("APP_CLOSED", "The live Safari companion was closed.")) }
        profiles.removeAll()
    }

    private static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["ok": false, "error": ["code": code, "message": message]]
    }
}
