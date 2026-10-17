import Foundation

@main struct Test {
    static func main() {
        var writes = 0, captures = 0, inputs: [[String: Any]] = [], cancelled: [String] = [], authorization: (() -> Bool)?
        let broker = SafariLiveBroker(download: { _, _, allowed, reply in
                precondition(allowed()); writes += 1; reply(["ok": true, "result": [:]])
            },
            cancelDownload: { cancelled.append($0) }, organize: { _, allowed, reply in
                authorization = allowed
                precondition(allowed())
                reply(["ok": true, "result": [:]])
            }, capture: { _, allowed, reply in
                precondition(allowed()); captures += 1; reply(["ok": true, "result": [:]])
            }, guardedInput: { input, allowed, reply in
                authorization = allowed
                precondition(allowed()); inputs.append(input); reply(["ok": true, "result": [:]])
            }, input: { input, reply in inputs.append(input); reply(["ok": true, "result": [:]]) })
        let profile = UUID().uuidString, session = UUID().uuidString
        var request: [String: Any] = [:]
        func poll() {
            broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) {
                if let current = ($0["requests"] as? [[String: Any]])?.first { request = current }
            }
        }
        func run(_ action: String, _ args: [String: Any]) {
            broker.handle(["action": "live", "agentOwner": "owner", "command": ["action": action,
                "arguments": args.merging(["handle": "live:\(profile):12"]) { current, _ in current }]]) { _ in }
            poll()
        }
        @discardableResult func native(_ action: String, input: [String: Any], expectOK: Bool) -> [String: Any] {
            var response: [String: Any] = [:]
            broker.handle(["action": action, "id": request["id"] ?? "missing", "profileId": profile,
                           "sessionId": session, "input": input]) { precondition($0["ok"] as? Bool == expectOK); response = $0 }
            return response
        }
        poll()
        run("read_page", [:])
        native("liveDownload", input: ["action": "begin", "filename": "forbidden.txt"], expectOK: false)
        native("liveOrganize", input: ["action": "createGroup"], expectOK: false)
        native("liveInput", input: ["action": "click"], expectOK: false)
        native("liveCapture", input: [:], expectOK: false)
        native("liveDialog", input: ["action": "inspect"], expectOK: false)
        broker.cancelAgent(owner: "owner")
        precondition(writes == 0)

        run("screenshot", [:])
        native("liveInput", input: ["action": "click"], expectOK: false)
        native("liveInput", input: ["action": "focus"], expectOK: true)
        native("liveCapture", input: [:], expectOK: true)
        precondition(captures == 1)
        broker.cancelAgent(owner: "owner")
        native("liveCapture", input: [:], expectOK: false)
        run("dialog", [:])
        native("liveInput", input: ["action": "focus", "allowJavaScriptDialog": true], expectOK: true)
        native("liveDialog", input: ["action": "type"], expectOK: false)
        native("liveDialog", input: ["action": "inspect"], expectOK: true)
        precondition(inputs.last?["action"] as? String == "dialog" && inputs.last?["operation"] as? String == "inspect")
        broker.cancelAgent(owner: "owner")
        run("asset_bundle", [:])
        native("liveDownload", input: ["action": "bundleBegin"], expectOK: true)
        broker.cancelAgent(owner: "owner")
        writes = 0
        run("interact", [:])
        let inputReply = native("liveInput", input: ["action": "type", "text": "synthetic"], expectOK: true)
        let sequence = inputReply["inputReceiptSequence"] as! Int
        broker.handle(["action": "liveInputAck", "id": request["id"]!, "profileId": profile,
                       "sessionId": session, "receiptSequence": sequence + 1]) { precondition($0["ok"] as? Bool == false) }
        broker.handle(["action": "liveInputAck", "id": request["id"]!, "profileId": profile,
                       "sessionId": session, "receiptSequence": sequence]) { precondition($0["ok"] as? Bool == true) }
        broker.handle(["action": "live", "command": ["action": "status"]]) {
            let observed = ($0["result"] as! [String: Any])["lastInputObservation"] as! [String: Any]
            precondition(observed["stage"] as? String == "extension_ack" && observed["sequence"] as? Int == sequence)
        }
        precondition(authorization?() == true)
        broker.cancelAgent(owner: "owner")
        precondition(authorization?() == false, "Input already admitted to a serial queue must still observe owner cancellation")

        run("download_link", [:])
        native("liveDownload", input: ["action": "begin", "filename": "allowed.txt"], expectOK: true)
        precondition(writes == 1)
        let downloadID = request["id"] as! String
        broker.cancelAgent(owner: "owner")
        precondition(cancelled.contains(downloadID))
        native("liveDownload", input: ["action": "append"], expectOK: false)
        precondition(writes == 1, "Cancelled downloads cannot append another chunk")

        run("download_intent_transfer", [:])
        native("liveDownload", input: ["action": "begin", "filename": "intent.txt"], expectOK: true)
        precondition(writes == 2)
        broker.cancelAgent(owner: "owner")
        native("liveDownload", input: ["action": "append"], expectOK: false)
        precondition(writes == 2, "A captured-intent transfer cannot write after original owner cancellation")
        var ownerlessIntentRejected = false
        broker.handle(["action": "live", "command": ["action": "download_intent_transfer",
            "arguments": ["handle": "live:\(profile):12"]]]) {
            ownerlessIntentRejected = $0["ok"] as? Bool == false
        }
        precondition(ownerlessIntentRejected, "A captured intent is not a public desktop download writer")

        run("download_intent_redirect", [:])
        native("liveDownload", input: ["action": "begin", "filename": "forbidden-redirect.txt"], expectOK: false)
        precondition(writes == 2, "Redirect header inspection is not private-writer authority")
        broker.cancelAgent(owner: "owner")
        var ownerlessRedirectRejected = false
        broker.handle(["action": "live", "command": ["action": "download_intent_redirect",
            "arguments": ["handle": "live:\(profile):12"]]]) {
            ownerlessRedirectRejected = $0["ok"] as? Bool == false
        }
        precondition(ownerlessRedirectRejected)

        run("organize", ["operation": "inspect", "expectedUrl": "https://example.com/"])
        native("liveOrganize", input: ["action": "createGroup", "expectedUrl": "https://example.com/"], expectOK: false)
        native("liveOrganize", input: ["action": "inspect", "expectedUrl": "https://different.example/"], expectOK: false)
        native("liveOrganize", input: ["action": "inspect", "expectedUrl": "https://example.com/"], expectOK: true)
        precondition(authorization?() == true)
        broker.cancelAgent(owner: "owner")
        precondition(authorization?() == false, "An in-flight native helper must observe owner cancellation")
        native("liveOrganize", input: ["action": "inspect", "expectedUrl": "https://example.com/"], expectOK: false)
        precondition(!broker.isProfileBound(profile, nativeProfile: nil), "An absent trusted observation is not a default-profile binding")
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session, "_nativeSafariProfileObserved": true]) { _ in }
        precondition(broker.isProfileBound(profile, nativeProfile: nil))
        let namedProfile = UUID()
        precondition(!broker.isProfileBound(profile, nativeProfile: namedProfile))
        broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session,
                       "_nativeSafariProfileObserved": true, "_nativeSafariProfile": namedProfile.uuidString]) { _ in }
        precondition(broker.isProfileBound(profile, nativeProfile: namedProfile) && !broker.isProfileBound(profile, nativeProfile: nil))
        broker.close()
        let diagnostic = SafariLiveBroker.selectionDiagnostics([
            "phase": "rejected", "action": "createGroup", "token": "must-not-escape",
            "failure": ["stage": "owner_mount", "code": "UNCLASSIFIED", "message": "must-not-escape"],
            "before": [["tabId": 12, "windowId": 34, "active": true, "url": "must-not-escape"]],
            "events": [["type": "windowFocusChanged", "windowId": -1, "title": "must-not-escape"],
                       ["type": "unknown", "tabId": 12]]])!
        let encoded = String(data: try! JSONSerialization.data(withJSONObject: diagnostic), encoding: .utf8)!
        precondition(!encoded.contains("must-not-escape") && !encoded.contains("unknown"))
        precondition((diagnostic["events"] as! [[String: Any]]).count == 1)
        precondition((diagnostic["failure"] as? [String: String]) == ["stage": "owner_mount", "code": "UNCLASSIFIED"])
        precondition(SafariLiveBroker.selectionDiagnostics(["phase": "rejected", "failure": ["stage": "secret-path", "code": "UNCLASSIFIED"]])?["failure"] == nil)
        precondition(SafariLiveBroker.selectionDiagnostics(["phase": "rejected", "failure": ["stage": "owner_mount", "code": "secret-token"]])?["failure"] == nil)
        precondition(SafariLiveBroker.selectionDiagnostics(["phase": "rejected", "failure": ["stage": "owner_rebind", "code": "REBIND_CONTEXT"]])?["failure"] != nil)
        precondition(SafariLiveBroker.selectionDiagnostics(["phase": "untrusted"]) == nil)
        var panelOpened = false, chooserCalls = 0
        let chooserBroker = SafariLiveBroker(fileChooser: { _, allowed, reply in
            precondition(allowed()); chooserCalls += 1; reply(["ok": true, "result": [:]])
        }, input: { command, reply in reply(["ok": true, "result": ["fileChooserOpen": panelOpened,
            "eventsPosted": command["action"] as? String == "click" ? 2 : 0]]) })
        let document = "owned-document", url = "http://example.test/owned"
        let bounds: [String: Any] = ["left": 0, "top": 0, "width": 1000, "height": 800]
        let baseScope = ["profileId": profile, "tabId": "12", "documentId": document,
                         "ownerId": "owner", "sessionId": "task", "turnId": "turn"]
        let fullScope = baseScope.merging(["node": "file-input"]) { _, value in value }
        chooserBroker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) { _ in }
        func chooserRun(_ action: String, args: [String: Any]) {
            chooserBroker.handle(["action": "live", "agentOwner": "owner", "command": ["action": action,
                "arguments": args.merging(["handle": "live:\(profile):12"]) { value, _ in value }]]) { _ in }
            chooserBroker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) {
                request = ($0["requests"] as! [[String: Any]])[0]
            }
        }
        func chooserNative(_ action: String, _ input: [String: Any], ok: Bool) {
            chooserBroker.handle(["action": action, "id": request["id"]!, "profileId": profile,
                "sessionId": session, "input": input]) { precondition($0["ok"] as? Bool == ok) }
        }
        chooserRun("interact", args: ["documentId": document, "fileChooserScope": baseScope])
        let inspect: [String: Any] = ["operation": "inspect", "scope": fullScope, "expectedUrl": url, "windowBounds": bounds]
        chooserNative("liveFileChooser", inspect, ok: false)
        chooserNative("liveModal", ["expectedUrl": url, "windowBounds": bounds], ok: false)
        panelOpened = true
        chooserNative("liveInput", ["action": "click", "expectedUrl": url, "windowBounds": bounds], ok: true)
        chooserNative("liveModal", ["expectedUrl": "http://other.test/", "windowBounds": bounds], ok: false)
        chooserNative("liveModal", ["expectedUrl": url, "windowBounds": bounds], ok: true)
        chooserNative("liveFileChooser", inspect.merging(["expectedUrl": "http://other.test/"]) { _, value in value }, ok: false)
        chooserNative("liveFileChooser", inspect.merging(["scope": fullScope.merging(["documentId": "stale"]) { _, value in value }]) { _, value in value }, ok: false)
        chooserNative("liveFileChooser", inspect, ok: true)
        chooserBroker.cancelAgent(owner: "owner")
        chooserNative("liveModal", ["expectedUrl": url, "windowBounds": bounds], ok: false)
        chooserNative("liveFileChooser", inspect, ok: false)
        chooserRun("filechooser", args: ["operation": "setFiles", "chooserId": "native-id", "scope": fullScope, "files": ["/synthetic/file.txt"]])
        let upload: [String: Any] = ["operation": "setFiles", "chooserId": "native-id", "scope": fullScope, "files": ["/synthetic/file.txt"]]
        chooserNative("liveFileChooser", upload.merging(["files": ["/other/file.txt"]]) { _, value in value }, ok: false)
        chooserNative("liveFileChooser", upload, ok: true)
        precondition(chooserCalls == 2, "Only the exact native-opened chooser inspection and authorized upload may reach the helper")
        chooserBroker.close()
        // Fixed, bounded telemetry must identify the writer boundary without
        // retaining request identities, filenames, bytes or arbitrary errors.
        var writerReplies: [SafariLiveBroker.Reply] = []
        let observedBroker = SafariLiveBroker(download: { _, _, _, reply in writerReplies.append(reply) },
            input: { _, reply in reply(["ok": true, "result": [:]]) })
        var observedRequest: [String: Any] = [:]
        var observedSession = UUID().uuidString
        func observedPoll() {
            observedBroker.handle(["action": "livePoll", "profileId": profile, "sessionId": observedSession]) {
                if let request = ($0["requests"] as? [[String: Any]])?.first { observedRequest = request }
            }
        }
        func observedRun(_ action: String = "download_intent_transfer", args: [String: Any] = [:]) {
            observedBroker.handle(["action": "live", "agentOwner": "private-owner", "command": ["action": action,
                "arguments": args.merging(["handle": "live:\(profile):12"]) { value, _ in value }]]) { _ in }
            observedPoll()
        }
        func observation() -> [String: Any] {
            var result: [String: Any] = [:]
            observedBroker.handle(["action": "live", "command": ["action": "status"]]) {
                result = (($0["result"] as! [String: Any])["downloadObservation"] as? [String: Any]) ?? [:]
            }
            return result
        }
        func writer(_ input: [String: Any]) {
            observedBroker.handle(["action": "liveDownload", "id": observedRequest["id"]!,
                "profileId": profile, "sessionId": observedSession, "input": input]) { _ in }
        }
        func resolveObserved() {
            observedBroker.handle(["action": "liveResolve", "id": observedRequest["id"]!, "profileId": profile,
                "sessionId": observedSession, "response": ["ok": true, "result": ["path": "/private/saved"]]]) { _ in }
        }
        observedPoll(); observedRun()
        precondition((observation()["events"] as! [[String: Any]]).map { $0["stage"] as! String } == ["outer_start", "outer_delivered"])
        precondition(observation()["firstWriterElapsedMs"] == nil)
        writer(["action": "begin", "filename": "/private/filename", "id": "private-transfer"])
        precondition(observation()["firstWriterElapsedMs"] is Int)
        writerReplies.removeFirst()(["ok": true, "result": ["transferId": "private-transfer"]])
        writer(["action": "append", "sequence": 0, "data": "PRIVATE_BYTES"])
        var events = observation()["events"] as! [[String: Any]]
        precondition(events.last?["stage"] as? String == "writer_ingress" && events.last?["encodedBytes"] as? Int == 13)
        writerReplies.removeFirst()(["ok": true, "result": ["bytesWritten": 9, "sequence": 1, "path": "/private/path"]])
        events = observation()["events"] as! [[String: Any]]
        precondition(events.last?["bytesWritten"] as? Int == 9 && events.last?["replySequence"] as? Int == 1)
        for index in 0..<20 {
            writer(["action": "append", "sequence": index, "data": "PRIVATE_BYTES"])
            writerReplies.removeFirst()(["ok": false, "error": ["code": "PRIVATE_SECRET", "message": "private-message"]])
        }
        precondition((observation()["events"] as! [[String: Any]]).count == 32)
        precondition((observation()["eventCount"] as! Int) > 32)
        precondition((observation()["events"] as! [[String: Any]]).last?["errorCode"] as? String == "UNCLASSIFIED")
        writer(["action": "finish", "sequence": 1, "expectedBytes": 9])
        writerReplies.removeFirst()(["ok": true, "result": ["bytesWritten": 9, "path": "/private/final"]])
        resolveObserved()
        precondition((observation()["events"] as! [[String: Any]]).last?["stage"] as? String == "outer_end")
        let encodedObservation = String(decoding: try! JSONSerialization.data(withJSONObject: observation()), as: UTF8.self)
        for secret in ["private", "PRIVATE", profile, observedSession, observedRequest["id"] as! String] {
            precondition(!encodedObservation.contains(secret), "Telemetry must contain only fixed stages and bounded counts")
        }
        observedRun(); writer(["action": "begin", "filename": "private-old"])
        let lateReply = writerReplies.removeFirst()
        observedBroker.cancelAgent(owner: "private-owner")
        events = observation()["events"] as! [[String: Any]]
        precondition(events.last?["stage"] as? String == "outer_cancel" && events.last?["errorCode"] as? String == "AGENT_OWNER_CHANGED")
        observedRun("interact", args: ["downloadIntent": ["intentId": "private-intent"]])
        let freshSequence = observation()["sequence"] as! Int
        lateReply(["ok": true, "result": ["bytesWritten": 999]])
        precondition(observation()["sequence"] as? Int == freshSequence && observation()["eventCount"] as? Int == 2,
                     "A late writer callback must not overwrite a newer operation")
        observedSession = UUID().uuidString; observedPoll()
        precondition((observation()["events"] as! [[String: Any]]).last?["errorCode"] as? String == "BACKGROUND_CHANGED")
        observedRun(); writer(["action": "abort", "transferId": "private-transfer"])
        writerReplies.removeFirst()(["ok": true, "result": ["aborted": true]])
        precondition((observation()["events"] as! [[String: Any]]).last?["action"] as? String == "abort")
        resolveObserved()
        if CommandLine.arguments.contains("--timeout-observation") {
            observedRun()
            let deadline = Date().addingTimeInterval(43)
            while Date() < deadline && (observation()["events"] as! [[String: Any]]).last?["stage"] as? String != "outer_timeout" {
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
            }
            let timedOut = (observation()["events"] as! [[String: Any]]).last!
            precondition(timedOut["stage"] as? String == "outer_timeout" && timedOut["errorCode"] as? String == "LIVE_TIMEOUT")
            precondition(observation()["firstWriterElapsedMs"] == nil)
            observedPoll()
        }
        observedRun(); observedBroker.close()
        precondition((observation()["events"] as! [[String: Any]]).last?["errorCode"] as? String == "APP_CLOSED")
        print("Live native download and organization scope/cancellation checks passed")
    }
}
