import Foundation
import CoreGraphics

@main
struct SafariLiveInputGuards {
    static func main() throws {
        let base: [String: Any] = [
            "action": "click", "expectedUrl": "https://example.com/current?mode=live#field",
            "windowBounds": ["left": 0, "top": 25, "width": 1200, "height": 900],
            "viewport": ["width": 1200, "height": 800], "point": ["x": 600, "y": 400]
        ]
        func request(_ changes: [String: Any] = [:]) throws -> SafariLiveInput.Request {
            try SafariLiveInput.Request(base.merging(changes, uniquingKeysWith: { _, rhs in rhs }))
        }
        func rejects(_ code: String, _ body: () throws -> Void) {
            do { try body(); preconditionFailure("Expected rejection: \(code)") }
            catch let failure as SafariLiveInput.Failure { precondition(failure.code == code, failure.code) }
            catch { preconditionFailure("Unexpected error: \(error)") }
        }

        _ = try request()
        let modalScope = ["profileId": "profile", "tabId": "12", "documentId": "document", "node": "node", "ownerId": "owner",
                          "accountScope": "account", "sessionId": "original-session", "turnId": "original-turn"]
        let modalPolicy: [String: Any] = ["kind": "dialog", "timeout_ms": 10000, "type": "prompt", "message": "Exact prompt?", "accept": true, "promptText": "Native answer"]
        let planned: [String: Any] = ["policy": modalPolicy, "scope": modalScope]
        let plan = try SafariLiveInput.ModalPlan(planned, request: request())
        precondition(plan.timeout == 10 && plan.matches(type: "prompt", message: "Exact prompt?"))
        precondition(!plan.matches(type: "confirm", message: "Exact prompt?") && !plan.matches(type: "prompt", message: "Exact prompt? extra"))
        precondition(SafariLiveInput.dialogHeaderMatchesOrigin("來自「https://example.com」：", expectedURL: "https://example.com/path"))
        precondition(SafariLiveInput.dialogHeaderMatchesOrigin("The page at \"http://127.0.0.1:62356\" says:", expectedURL: "http://127.0.0.1:62356/"))
        precondition(!SafariLiveInput.dialogHeaderMatchesOrigin("來自「https://example.com.evil.test」：", expectedURL: "https://example.com/"))
        precondition(!SafariLiveInput.dialogHeaderMatchesOrigin("來自「http://127.0.0.1:62357」：", expectedURL: "http://127.0.0.1:62356/"))
        func responseButton(_ operation: String = "accept", type: String = "prompt", count: Int = 2,
                            primary: [Int] = [1, 1], cancel: [Int] = [0, 0], enabled: Set<Int> = [0, 1], pressable: Set<Int> = [0, 1]) throws -> Int {
            try SafariLiveInput.dialogResponseButtonIndex(operation: operation, type: type, buttonCount: count,
                defaultIndices: primary, cancelIndices: cancel, enabled: enabled, pressable: pressable)
        }
        let responseIndices = try [responseButton(), responseButton("dismiss"), responseButton(primary: [0], cancel: [1]),
            responseButton("dismiss", primary: [0], cancel: [1]), responseButton("dismiss", type: "alert", count: 1, primary: [], cancel: [])]
        precondition(responseIndices == [1, 0, 0, 1, 0], "Native semantics, not label, position or array order, identify OK/Cancel")
        for primary in [[], [-1], [0, 1], [2]] {
            rejects("DIALOG_RESPONSE_UNVERIFIABLE") { _ = try responseButton(primary: primary) }
        }
        rejects("DIALOG_RESPONSE_UNVERIFIABLE") { _ = try responseButton(cancel: [1]) }
        rejects("DIALOG_RESPONSE_UNVERIFIABLE") { _ = try responseButton(type: "prompt", count: 1) }
        rejects("DIALOG_RESPONSE_UNAVAILABLE") { _ = try responseButton(enabled: [0]) }
        rejects("DIALOG_RESPONSE_UNAVAILABLE") { _ = try responseButton(pressable: [0]) }
        let nativePromptLabels = SafariLiveInput.nativeDialogLabels("prompt")
        precondition(nativePromptLabels.contains(.init(primary: "好", cancel: "取消")), "Read the installed Safari framework's exact Traditional Chinese prompt pair")
        let localPairs = [SafariLiveInput.DialogButtonLabels(primary: "好", cancel: "取消"), .init(primary: "OK", cancel: "Cancel")]
        let nativePair = try SafariLiveInput.localizedDialogButtonIdentity(titles: ["取消", "好"], type: "prompt", labels: localPairs)
        let reversedPair = try SafariLiveInput.localizedDialogButtonIdentity(titles: ["好", "取消"], type: "prompt", labels: localPairs)
        precondition(nativePair.primary == 1 && nativePair.cancel == 0 && reversedPair.primary == 0 && reversedPair.cancel == 1)
        let nativeButton = try SafariLiveInput.dialogResponseButtonIndex(operation: "accept", type: "prompt", buttonCount: 2,
            defaultIndices: [], cancelIndices: [], enabled: [0, 1], pressable: [0, 1], localized: nativePair)
        precondition(nativeButton == 1, "A complete OS-localized pair supplies positive response identity without AXDefaultButton")
        for titles in [["Cancel", "好"], ["取消", "Unknown"], ["好", "好"], ["取消", "好", "Other"]] {
            rejects("DIALOG_RESPONSE_UNVERIFIABLE") { _ = try SafariLiveInput.localizedDialogButtonIdentity(titles: titles, type: "prompt", labels: localPairs) }
        }
        rejects("DIALOG_RESPONSE_UNVERIFIABLE") {
            _ = try SafariLiveInput.localizedDialogButtonIdentity(titles: ["取消", "好"], type: "prompt", labels: localPairs + [.init(primary: "取消", cancel: "好")])
        }
        rejects("DIALOG_RESPONSE_UNVERIFIABLE") {
            _ = try SafariLiveInput.dialogResponseButtonIndex(operation: "accept", type: "prompt", buttonCount: 2,
                defaultIndices: [0], cancelIndices: [1], enabled: [0, 1], pressable: [0, 1], localized: nativePair)
        }
        let alert = try SafariLiveInput.localizedDialogButtonIdentity(titles: ["關閉"], type: "alert", labels: SafariLiveInput.nativeDialogLabels("alert"))
        precondition(alert.primary == 0 && alert.cancel == nil)
        let alertWindow = CGRect(x: -1200, y: 25, width: 1200, height: 900), alertDialog = CGRect(x: -1100, y: 400, width: 300, height: 200)
        let alertButton = CGRect(x: -1000, y: 500, width: 100, height: 30)
        let alertPoint = try SafariLiveInput.nativeDialogButtonPoint(button: alertButton, dialog: alertDialog, window: alertWindow)
        precondition(alertPoint == CGPoint(x: -950, y: 515), "Use the exact native button center, including negative-screen coordinates")
        precondition(SafariLiveInput.nativePointerMatches(alertPoint, expected: alertPoint))
        precondition(SafariLiveInput.nativePointerMatches(CGPoint(x: -949.5, y: 515.5), expected: alertPoint))
        precondition(!SafariLiveInput.nativePointerMatches(CGPoint(x: -948, y: 515), expected: alertPoint))
        precondition(!SafariLiveInput.nativePointerMatches(CGPoint(x: CGFloat.infinity, y: 515), expected: alertPoint))
        for button in [CGRect(x: 0, y: 500, width: 100, height: 30), CGRect(x: -1150, y: 500, width: 100, height: 30),
                       CGRect(x: -1000, y: 500, width: 0, height: 30), CGRect(x: CGFloat.infinity, y: 500, width: 100, height: 30)] {
            rejects("DIALOG_BUTTON_BOUNDS_CHANGED") { _ = try SafariLiveInput.nativeDialogButtonPoint(button: button, dialog: alertDialog, window: alertWindow) }
        }
        for update: [String: Any] in [["accept": NSNumber(value: 1)], ["type": "alert", "accept": false], ["timeout_ms": 10001],
                                     ["timeout_ms": 0], ["type": "confirm"], ["message": String(repeating: "x", count: 8001)], ["unknown": true]] {
            rejects("INVALID_NATIVE_MODAL") { _ = try SafariLiveInput.ModalPlan(["policy": modalPolicy.merging(update) { _, n in n }, "scope": modalScope], request: request()) }
        }
        for scope in [modalScope.filter { $0.key != "accountScope" }, modalScope.merging(["tabId": "012"]) { _, n in n }] {
            rejects("INVALID_NATIVE_MODAL") { _ = try SafariLiveInput.ModalPlan(["policy": modalPolicy, "scope": scope], request: request()) }
        }
        for update: [String: Any] in [["action": "key", "key": "Enter"], ["clickCount": 2], ["button": "right"], ["modifiers": ["Shift"]]] {
            rejects("INVALID_NATIVE_MODAL") { _ = try SafariLiveInput.ModalPlan(planned, request: request(update)) }
        }
        let uploadFixture = FileManager.default.temporaryDirectory.appendingPathComponent("native-upload-plan-" + UUID().uuidString + ".txt")
        try Data("Owned upload plan".utf8).write(to: uploadFixture, options: .withoutOverwriting)
        defer { try? FileManager.default.removeItem(at: uploadFixture) }
        let uploadPolicy: [String: Any] = ["kind": "upload", "timeout_ms": 10000, "files": [uploadFixture.path]]
        let upload = try SafariLiveInput.ModalPlan(["policy": uploadPolicy, "scope": modalScope, "isMultiple": false], request: request())
        precondition(upload.kind == "upload" && upload.files.count == 1 && upload.files[0].path == uploadFixture.path)
        rejects("INVALID_NATIVE_MODAL") { _ = try SafariLiveInput.ModalPlan(["policy": uploadPolicy, "scope": modalScope, "isMultiple": NSNumber(value: 1)], request: request()) }
        rejects("INVALID_FILES") { _ = try SafariLiveInput.ModalPlan(["policy": uploadPolicy.merging(["files": ["relative.txt"]]) { _, n in n }, "scope": modalScope, "isMultiple": false], request: request()) }
        let focusTarget: [String: Any] = ["action": "focus", "expectedUrl": "https://example.com/current?mode=live#field",
                                          "windowBounds": ["left": 0, "top": 25, "width": 1200, "height": 900]]
        let target = try SafariLiveInput.Target(focusTarget)
        precondition(target.windowBounds == CGRect(x: 0, y: 25, width: 1200, height: 900))
        rejects("INVALID_ARGUMENTS") { _ = try SafariLiveInput.Request(focusTarget) }
        rejects("INVALID_ARGUMENTS") { _ = try SafariLiveInput.Target(focusTarget.merging(["expectedUrl": "file:///etc/passwd"], uniquingKeysWith: { _, rhs in rhs })) }
        rejects("INVALID_ARGUMENTS") { _ = try SafariLiveInput.Target(focusTarget.merging(["windowBounds": ["left": 0, "top": 25, "width": true, "height": 900]], uniquingKeysWith: { _, rhs in rhs })) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["expectedUrl": "file:///etc/passwd"]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["expectedUrl": "https://name:password@example.com"]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["viewport": ["width": 0, "height": 800]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["point": ["x": 1200, "y": 1]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["point": ["x": true, "y": 1]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["point": ["x": Double.infinity, "y": 1]]) }
        rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": "Command+Q"]) }
        rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": "Command+L"]) }
        for key in ["Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "Space",
                    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"] {
            _ = try request(["action": "key", "key": key])
        }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "type", "text": ""]) }
        _ = try request(["action": "type", "text": "", "replaceAll": true])
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "type", "text": "clear", "replaceAll": NSNumber(value: 1)]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "type", "text": String(repeating: "a", count: 20_001)]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "scroll", "deltaY": Double.nan]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "scroll", "deltaY": 0]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "scroll", "deltaX": 10_001]) }
        _ = try request(["action": "scroll", "deltaY": 300])
        rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": "q", "modifiers": ["Meta"]]) }
        rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": "l", "modifiers": ["Meta"]]) }
        for key in ["Meta+w", "Meta+Shift+c", "Meta+Shift+Backspace", "Meta+Alt+ArrowRight", "Control+ArrowLeft", "Control+Space", "Control+Tab", "Control+Alt+q"] {
            rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": key]) }
        }
        _ = try request(["action": "key", "key": "Meta+Shift+z"])
        _ = try request(["action": "key", "key": "Alt+Shift+ArrowLeft"])
        _ = try request(["action": "key", "key": "ControlOrMeta+a"])
        _ = try request(["clickCount": 2, "button": "right", "modifiers": ["Shift"]])
        rejects("INVALID_ARGUMENTS") { _ = try request(["clickCount": 1.5]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["clickCount": true]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["modifiers": ["Hyper"]]) }
        _ = try request(["action": "move"])
        _ = try request(["action": "drag", "path": [["x": 600, "y": 400], ["x": 700, "y": 500]]])
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "drag", "path": [["x": 601, "y": 400], ["x": 700, "y": 500]]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "drag", "path": [["x": 600, "y": 400], ["x": 1200, "y": 500]]]) }
        _ = try request(["action": "select", "options": [["label": "Blue", "index": 1]]])
        _ = try request(["action": "select", "options": [], "multiple": true])
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "select", "options": []]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "select", "options": [["label": "Blue", "index": true]]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "select", "multiple": true, "options": [["label": "Red", "index": 0], ["label": "Blue", "index": 0]]]) }
        _ = try SafariLiveInput.captureClip(["x": 1, "y": 2, "width": 200, "height": 100], viewport: CGSize(width: 1200, height: 800))
        rejects("INVALID_ARGUMENTS") { _ = try SafariLiveInput.captureClip(["x": 1, "y": 2, "width": 1200, "height": 100], viewport: CGSize(width: 1200, height: 800)) }

        let window = CGRect(x: -1300, y: 25, width: 1200, height: 900)
        let visible = CGRect(x: -1300, y: 125, width: 1200, height: 800)
        let mapped = try SafariLiveInput.mapPoint(CGPoint(x: 600, y: 400), viewport: CGSize(width: 1200, height: 800), scrollFrame: visible, windowFrame: window)
        precondition(mapped.point == CGPoint(x: -700, y: 525))
        precondition(mapped.scaleX == 1 && mapped.scaleY == 1)
        let zoomed = try SafariLiveInput.mapPoint(CGPoint(x: 400, y: 200), viewport: CGSize(width: 800, height: 1600.0 / 3), scrollFrame: visible, windowFrame: window)
        precondition(zoomed.point == CGPoint(x: -700, y: 425))
        precondition(abs(zoomed.scaleX - 1.5) < 0.0001)
        rejects("VIEWPORT_CHANGED") {
            _ = try SafariLiveInput.mapPoint(.zero, viewport: CGSize(width: 1200, height: 800),
                                            scrollFrame: CGRect(x: -1300, y: 125, width: 1200, height: 4000), windowFrame: window)
        }
        rejects("VIEWPORT_CHANGED") {
            _ = try SafariLiveInput.mapPoint(.zero, viewport: CGSize(width: 1200, height: 800),
                                            scrollFrame: CGRect(x: -1300, y: 125, width: 500, height: 800), windowFrame: window)
        }

        let unicode = String(repeating: "a", count: 19) + "🙂繁體中文" + String(repeating: "🎉", count: 35)
        let chunks = SafariLiveInput.unicodeChunks(unicode)
        precondition(chunks.flatMap { $0 } == Array(unicode.utf16))
        for chunk in chunks {
            precondition(!chunk.isEmpty && chunk.count <= 20)
            precondition(!(0xDC00...0xDFFF).contains(chunk.first!))
            precondition(!(0xD800...0xDBFF).contains(chunk.last!))
        }
        precondition(SafariLiveInput.unicodeChunks("").isEmpty)
        let failure = SafariLiveInput.Failure(code: "WINDOW_NOT_FOUND", message: "No matching window.",
                                              details: ["expectedWindowBounds": ["left": 0, "top": 25, "width": 1200, "height": 900],
                                                        "observedSafariWindows": [["axWindowsStatus": 0, "windowCount": 1,
                                                                                     "windows": [["frame": ["left": 0, "top": 0, "width": 1200, "height": 900]]]]]])
        let response = SafariLiveInput.failureResponse(failure)
        let serialized = try JSONSerialization.data(withJSONObject: response)
        let restored = try JSONSerialization.jsonObject(with: serialized) as! [String: Any]
        let nativeError = restored["error"] as! [String: Any]
        precondition(nativeError["code"] as? String == "WINDOW_NOT_FOUND")
        precondition(nativeError["data"] is [String: Any])
        precondition(nativeError["eventsPosted"] as? Int == 0)
        precondition(nativeError["mayHavePostedInput"] as? Bool == false)
        let lockedSession = SafariLiveInput.sessionStatus(["CGSSessionScreenIsLocked": true,
                                                           "kCGSSessionOnConsoleKey": true,
                                                           "kCGSessionLoginDoneKey": true,
                                                           "kCGSSessionUserNameKey": "must-not-be-returned"])
        precondition(lockedSession["screenLocked"] == true)
        precondition(lockedSession["sessionOnConsole"] == true)
        precondition(lockedSession["sessionLoginDone"] == true)
        precondition(lockedSession.count == 4)
        let unknownSession = SafariLiveInput.sessionStatus([:])
        precondition(unknownSession["screenLocked"] == nil, "A missing lock flag is unknown, not unlocked.")
        precondition(SafariLiveInput.sessionStatus(nil) == ["sessionStateAvailable": false])
        precondition(SafariLiveInput.sessionStatus(["CGSSessionScreenIsLocked": "true"])["screenLocked"] == nil)
        let idleInput = SafariLiveInput.InputState(flags: [.maskAlphaShift, .maskSecondaryFn], leftMouseDown: false, rightMouseDown: false)
        precondition(!idleInput.active && idleInput.heldModifiers.isEmpty)
        let modifiers = SafariLiveInput.InputState(flags: [.maskCommand, .maskControl, .maskAlternate, .maskShift], leftMouseDown: false, rightMouseDown: false)
        precondition(modifiers.active && modifiers.heldModifiers == ["Command", "Control", "Option", "Shift"])
        let mouse = SafariLiveInput.InputState(flags: [], leftMouseDown: true, rightMouseDown: false)
        precondition(mouse.active && mouse.heldModifiers.isEmpty)
        precondition(mouse.data["leftMouseDown"] as? Bool == true)
        precondition(mouse.data.count == 4, "Input diagnostics must not contain typed keys or text.")
        precondition(SafariLiveInput.InputState(flags: [], leftMouseDown: false, rightMouseDown: false, middleMouseDown: true).active)
        var cancelled: [String: Any]?
        let input = SafariLiveInput()
        input.handle(base, isAuthorized: { false }) { cancelled = $0 }
        let deadline = Date().addingTimeInterval(3)
        while cancelled == nil, Date() < deadline { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) }
        precondition((cancelled?["error"] as? [String: Any])?["code"] as? String == "STALE_OPERATION")
        precondition((cancelled?["error"] as? [String: Any])?["eventsPosted"] as? Int == 0)
        print("Safari live native input/focus target guards, safe keys, viewport mapping, and Unicode event chunks passed. No activation or input events were posted.")
    }
}
