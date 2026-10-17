import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security

/// Trusted input for the Safari tab already selected by the Web Extension.
/// The extension owns DOM freshness/actionability; this class owns native focus,
/// page identity, viewport mapping, and delivery. Only the explicit focus action
/// activates the matched Safari window; input actions never activate or retry.
final class SafariLiveInput {
    struct Failure: Error {
        let code: String
        let message: String
        var eventsPosted: Int = 0
        var details: [String: Any]? = nil
    }

    struct Target {
        let expectedURL: String
        let windowBounds: CGRect

        init(_ command: [String: Any]) throws {
            guard let expectedURL = command["expectedUrl"] as? String,
                  Self.isPageURL(expectedURL),
                  let bounds = command["windowBounds"] as? [String: Any],
                  let left = SafariLiveInput.number(bounds["left"]),
                  let top = SafariLiveInput.number(bounds["top"]),
                  let width = SafariLiveInput.number(bounds["width"]),
                  let height = SafariLiveInput.number(bounds["height"]),
                  abs(left) <= 100_000, abs(top) <= 100_000,
                  width > 0, height > 0, width <= 100_000, height <= 100_000 else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a live HTTP(S) page and finite Safari window bounds.")
            }
            self.expectedURL = expectedURL
            self.windowBounds = CGRect(x: left, y: top, width: width, height: height)
        }

        private static func isPageURL(_ value: String) -> Bool {
            guard let url = URLComponents(string: value),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil else { return false }
            return url.url != nil
        }
    }

    struct Request {
        let action: String
        let expectedURL: String
        let windowBounds: CGRect
        let viewport: CGSize
        let point: CGPoint
        let text: String?
        let replaceAll: Bool
        let key: String?
        let deltaX: Double
        let deltaY: Double

        init(_ command: [String: Any]) throws {
            guard let action = command["action"] as? String,
                  ["click", "type", "key", "scroll"].contains(action) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected click, type, key, or scroll.")
            }
            let target = try Target(command)
            guard let viewport = command["viewport"] as? [String: Any],
                  let viewportWidth = SafariLiveInput.number(viewport["width"]),
                  let viewportHeight = SafariLiveInput.number(viewport["height"]),
                  viewportWidth > 0, viewportHeight > 0,
                  viewportWidth <= 50_000, viewportHeight <= 50_000,
                  let point = command["point"] as? [String: Any],
                  let x = SafariLiveInput.number(point["x"]),
                  let y = SafariLiveInput.number(point["y"]),
                  x >= 0, y >= 0, x < viewportWidth, y < viewportHeight else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a live HTTP(S) page, window bounds, viewport, and a point inside that viewport.")
            }
            if command["replaceAll"] != nil, SafariLiveInput.boolean(command["replaceAll"]) == nil {
                throw Failure(code: "INVALID_ARGUMENTS", message: "replaceAll must be a boolean.")
            }
            let replaceAll = SafariLiveInput.boolean(command["replaceAll"]) ?? false
            let text = command["text"] as? String
            if action == "type" {
                guard let text, text.utf16.count <= 20_000,
                      !text.isEmpty || replaceAll else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "type requires text of at most 20,000 UTF-16 units; empty text requires replaceAll.")
                }
            }
            let key = command["key"] as? String
            if action == "key", key.flatMap({ SafariLiveInput.keys[$0] }) == nil {
                throw Failure(code: "UNSUPPORTED_KEY", message: "Use Enter, Tab, Shift+Tab, Escape, Backspace, Delete, Space, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Home, End, PageUp, or PageDown.")
            }
            let deltaX = SafariLiveInput.number(command["deltaX"]) ?? 0
            let deltaY = SafariLiveInput.number(command["deltaY"]) ?? 0
            if action == "scroll" {
                guard (command["deltaX"] == nil || SafariLiveInput.number(command["deltaX"]) != nil),
                      (command["deltaY"] == nil || SafariLiveInput.number(command["deltaY"]) != nil),
                      abs(deltaX) <= 10_000, abs(deltaY) <= 10_000,
                      deltaX != 0 || deltaY != 0 else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "scroll requires a nonzero finite delta, at most 10,000 pixels on either axis.")
                }
            }
            self.action = action
            self.expectedURL = target.expectedURL
            self.windowBounds = target.windowBounds
            self.viewport = CGSize(width: viewportWidth, height: viewportHeight)
            self.point = CGPoint(x: x, y: y)
            self.text = text
            self.replaceAll = replaceAll
            self.key = key
            self.deltaX = deltaX
            self.deltaY = deltaY
        }

    }

    struct MappedPoint {
        let point: CGPoint
        let scaleX: CGFloat
        let scaleY: CGFloat
    }

    private struct Context {
        let request: Request
        let pid: pid_t
        let app: AXUIElement
        let window: AXUIElement
        let webArea: AXUIElement
        let scrollArea: AXUIElement
        let scrollFrame: CGRect
        let mapped: MappedPoint
    }

    private struct NativeKey {
        let code: CGKeyCode
        let flags: CGEventFlags
    }

    struct InputState {
        let heldModifiers: [String]
        let leftMouseDown: Bool
        let rightMouseDown: Bool

        init(flags: CGEventFlags, leftMouseDown: Bool, rightMouseDown: Bool) {
            heldModifiers = [(CGEventFlags.maskCommand, "Command"), (.maskControl, "Control"),
                             (.maskAlternate, "Option"), (.maskShift, "Shift")]
                .filter { flags.contains($0.0) }.map { $0.1 }
            self.leftMouseDown = leftMouseDown
            self.rightMouseDown = rightMouseDown
        }

        var active: Bool { !heldModifiers.isEmpty || leftMouseDown || rightMouseDown }
        var data: [String: Any] {
            ["heldModifiers": heldModifiers, "leftMouseDown": leftMouseDown, "rightMouseDown": rightMouseDown]
        }
    }

    private struct WindowInventory {
        let matches: [(NSRunningApplication, AXUIElement, AXUIElement)]
        let windowCount: Int
        let complete: Bool
    }

    private static let keys: [String: NativeKey] = [
        "Enter": NativeKey(code: 36, flags: []),
        "Tab": NativeKey(code: 48, flags: []),
        "Shift+Tab": NativeKey(code: 48, flags: .maskShift),
        "Escape": NativeKey(code: 53, flags: []),
        "Backspace": NativeKey(code: 51, flags: []),
        "Delete": NativeKey(code: 117, flags: []),
        "Space": NativeKey(code: 49, flags: []),
        "ArrowLeft": NativeKey(code: 123, flags: []),
        "ArrowRight": NativeKey(code: 124, flags: []),
        "ArrowUp": NativeKey(code: 126, flags: []),
        "ArrowDown": NativeKey(code: 125, flags: []),
        "Home": NativeKey(code: 115, flags: []),
        "End": NativeKey(code: 119, flags: []),
        "PageUp": NativeKey(code: 116, flags: []),
        "PageDown": NativeKey(code: 121, flags: [])
    ]

    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.live-input")

    init() {
        // NSRunningApplication's dynamic properties refresh with the main run
        // loop. Create Workspace there rather than on our non-runloop queue.
        Self.onMain { _ = NSWorkspace.shared.runningApplications }
    }

    func handle(_ command: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            do {
                guard let action = command["action"] as? String else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a native input action.")
                }
                if action == "status" {
                    reply(["ok": true, "result": status()]); return
                }
                if action == "permissions" {
                    if command["prompt"] != nil, Self.boolean(command["prompt"]) == nil {
                        throw Failure(code: "INVALID_ARGUMENTS", message: "prompt must be a boolean.")
                    }
                    if Self.boolean(command["prompt"]) == true {
                        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
                    }
                    reply(["ok": true, "result": status()]); return
                }
                if action == "focus" {
                    reply(["ok": true, "result": try focus(Target(command))]); return
                }
                let request = try Request(command)
                let result = try perform(request)
                reply(["ok": true, "result": result])
            } catch let failure as Failure {
                reply(Self.failureResponse(failure))
            } catch {
                reply(["ok": false, "error": ["code": "NATIVE_INPUT_FAILED", "message": "Native Safari input failed."]])
            }
        }
    }

    private func status() -> [String: Any] {
        let trusted = AXIsProcessTrusted()
        let posting = CGPreflightPostEventAccess()
        let session = Self.currentSessionStatus()
        let backgroundFront = NSWorkspace.shared.frontmostApplication
        let mainFront = frontmostApplication()
        let focusedPID = focusedApplicationPID()
        var result: [String: Any] = [
            "backend": "macOS Accessibility + CGEvent",
            "scope": "existing_safari_tabs",
            "accessibilityTrusted": trusted,
            "postEventAccess": posting,
            "canPostInput": trusted && posting && session["screenLocked"] != true,
            "safariRunning": safariApplications().contains { !$0.isTerminated },
            "safariFrontmost": mainFront?.bundleIdentifier == "com.apple.Safari" && (focusedPID == nil || focusedPID == mainFront?.processIdentifier),
            "mainThreadSafariFrontmost": mainFront?.bundleIdentifier == "com.apple.Safari",
            "backgroundThreadSafariFrontmost": backgroundFront?.bundleIdentifier == "com.apple.Safari"
        ]
        result["inputState"] = inputStatesData()
        if let focusedPID {
            result["accessibilitySafariFrontmost"] = safariApplications().contains { $0.processIdentifier == focusedPID }
            result["frontmostObserversAgree"] = focusedPID == mainFront?.processIdentifier
        }
        result.merge(session, uniquingKeysWith: { _, rhs in rhs })
        return result
    }

    /// Read only the session-state booleans, never account names or identifiers.
    static func sessionStatus(_ dictionary: [String: Any]?) -> [String: Bool] {
        var result = ["sessionStateAvailable": dictionary != nil]
        guard let dictionary else { return result }
        for (source, destination) in [("CGSSessionScreenIsLocked", "screenLocked"),
                                      (kCGSessionOnConsoleKey as String, "sessionOnConsole"),
                                      (kCGSessionLoginDoneKey as String, "sessionLoginDone")] {
            if let value = boolean(dictionary[source]) { result[destination] = value }
        }
        return result
    }

    private static func currentSessionStatus() -> [String: Bool] {
        sessionStatus(CGSessionCopyCurrentDictionary() as? [String: Any])
    }

    private func requireUnlockedSession() throws {
        let session = Self.currentSessionStatus()
        if session["screenLocked"] == true {
            throw Failure(code: "SESSION_LOCKED", message: "Unlock this Mac before focusing Safari or sending native input.", details: session)
        }
    }

    private func focus(_ target: Target) throws -> [String: Any] {
        var diagnostics: [String: Any] = ["expectedWindowBounds": Self.boundsData(target.windowBounds),
                                           "session": Self.currentSessionStatus(), "stage": "session"]
        do {
            return try focusTarget(target, diagnostics: &diagnostics)
        } catch var failure as Failure {
            diagnostics["session"] = Self.currentSessionStatus()
            failure.details = diagnostics
            throw failure
        }
    }

    private func focusTarget(_ target: Target, diagnostics: inout [String: Any]) throws -> [String: Any] {
        try requireUnlockedSession()
        diagnostics["stage"] = "permissions"
        guard AXIsProcessTrusted() else {
            throw Failure(code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Allow ChatGPT for Safari in System Settings > Privacy & Security > Accessibility before focusing Safari for native input.")
        }
        let applications = safariApplications()
            .filter { !$0.isTerminated && Self.isAppleSafari($0) }
        diagnostics["signedSafariProcessCount"] = applications.count
        diagnostics["stage"] = "window-enumeration"
        guard !applications.isEmpty else {
            throw Failure(code: "SAFARI_NOT_RUNNING", message: "No Apple-signed Safari process is running.")
        }
        var inventory = windowInventory(applications, target: target, diagnostics: &diagnostics)
        var activatedForDiscovery = false
        // An unlocked background Safari can return a successful empty AXWindows
        // array. One explicit Safari activation lets AX publish its windows; it
        // does not authorize input until bounds and page identity are verified.
        if inventory.complete, inventory.windowCount == 0, applications.count == 1,
           focusedApplicationPID() != applications[0].processIdentifier {
            let application = applications[0]
            diagnostics["stage"] = "activation-for-window-discovery"
            try requireUnlockedSession()
            try activateSafari(application, diagnostics: &diagnostics)
            activatedForDiscovery = true
            let deadline = Date().addingTimeInterval(3)
            var observedSafari = false
            repeat {
                try requireUnlockedSession()
                guard !application.isTerminated else {
                    throw Failure(code: "SAFARI_NOT_RUNNING", message: "Safari quit during window discovery.")
                }
                if focusedApplicationPID() == application.processIdentifier {
                    observedSafari = true
                } else if observedSafari {
                    throw Failure(code: "FOCUS_CHANGED", message: "Another app took focus during Safari window discovery. No input was posted.")
                }
                inventory = windowInventory(applications, target: target, diagnostics: &diagnostics)
                if inventory.windowCount > 0 { break }
                Thread.sleep(forTimeInterval: 0.05)
            } while Date() < deadline
        }
        diagnostics["activatedForWindowDiscovery"] = activatedForDiscovery
        guard inventory.complete else {
            throw Failure(code: "WINDOW_INVENTORY_UNAVAILABLE", message: "Safari did not expose a complete accessibility window inventory. No input was posted.")
        }
        // Two ordinary Safari windows can have identical restored bounds.
        // Resolve that observed ambiguity with the selected page's real AX
        // identity, never with window order or whichever window is frontmost.
        if inventory.matches.count > 1 {
            let pageMatches = inventory.matches.filter { _, _, window in
                topLevelWebAreas(window).filter { pageURL($0) == target.expectedURL }.count == 1
            }
            diagnostics["pageIdentifiedWindowCount"] = pageMatches.count
            inventory = WindowInventory(matches: pageMatches, windowCount: inventory.windowCount, complete: inventory.complete)
        }
        guard inventory.matches.count == 1, let (application, app, window) = inventory.matches.first else {
            throw Failure(code: inventory.matches.isEmpty ? "WINDOW_NOT_FOUND" : "AMBIGUOUS_WINDOW", message: "The selected tab must identify exactly one Apple Safari window by its current bounds and page identity.")
        }
        diagnostics["stage"] = "pre-activation-identity"
        // Safari can omit background/fullscreen WebAreas. Validate any exposed
        // identity now; otherwise verify the exact page after activation, before input.
        let exposed = topLevelWebAreas(window)
        diagnostics["exposedWebAreaCount"] = exposed.count
        diagnostics["matchingPageCount"] = exposed.filter({ pageURL($0) == target.expectedURL }).count
        if !exposed.isEmpty, exposed.filter({ pageURL($0) == target.expectedURL }).count != 1 {
            throw Failure(code: "PAGE_CHANGED", message: "The matched Safari window is not displaying the selected page.")
        }
        guard let currentFrame = frame(window), Self.close(currentFrame, target.windowBounds, tolerance: 8) else {
            throw Failure(code: "WINDOW_CHANGED", message: "The selected Safari window moved before activation.")
        }
        diagnostics["stage"] = "activation"
        try requireUnlockedSession()
        if !activatedForDiscovery { try activateSafari(application, diagnostics: &diagnostics) }
        let raiseStatus = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        diagnostics["axRaiseStatus"] = raiseStatus.rawValue
        guard raiseStatus == .success else {
            throw Failure(code: "WINDOW_RAISE_FAILED", message: "Safari did not accept raising the selected window. No input was posted.")
        }
        diagnostics["stage"] = "focus-observation"
        let deadline = Date().addingTimeInterval(3)
        var observedSafari = false
        repeat {
            try requireUnlockedSession()
            guard !application.isTerminated,
                  let currentFrame = frame(window), Self.close(currentFrame, target.windowBounds, tolerance: 8) else {
                throw Failure(code: "WINDOW_CHANGED", message: "The selected Safari window changed during activation.")
            }
            let front = frontmostApplication()
            let focusedPID = focusedApplicationPID()
            diagnostics["mainThreadFrontmostIsSelectedSafari"] = front?.processIdentifier == application.processIdentifier
            diagnostics["accessibilityFrontmostIsSelectedSafari"] = focusedPID == application.processIdentifier
            diagnostics["frontmostIsSelectedSafari"] = focusedPID == application.processIdentifier
            if focusedPID == application.processIdentifier {
                observedSafari = true
                let focusedWindow = element(app, kAXFocusedWindowAttribute)
                diagnostics["focusedWindowIsSelectedWindow"] = focusedWindow.map { CFEqual($0, window) } ?? false
                if let focusedWindow, let observedFrame = frame(focusedWindow) {
                    diagnostics["focusedWindowBounds"] = Self.boundsData(observedFrame)
                }
                let areas = topLevelWebAreas(window)
                let matchingPages = areas.filter({ pageURL($0) == target.expectedURL }).count
                diagnostics["exposedWebAreaCount"] = areas.count
                diagnostics["matchingPageCount"] = matchingPages
                if let focusedWindow, CFEqual(focusedWindow, window), matchingPages == 1,
                   front?.processIdentifier == application.processIdentifier {
                    return ["action": "focus", "backend": "macOS Accessibility",
                            "focused": true, "pageIdentityVerified": true, "eventsPosted": 0]
                }
            } else if observedSafari {
                throw Failure(code: "FOCUS_CHANGED", message: "Another app took focus while Safari was being selected. No input was posted.")
            }
            Thread.sleep(forTimeInterval: 0.05)
        } while Date() < deadline
        throw Failure(code: "SAFARI_FOCUS_UNCONFIRMED", message: "Safari did not expose the selected focused window and expected page within the activation deadline. No input was posted.")
    }

    private func windowInventory(_ applications: [NSRunningApplication], target: Target,
                                 diagnostics: inout [String: Any]) -> WindowInventory {
        var matches: [(NSRunningApplication, AXUIElement, AXUIElement)] = []
        var observations: [[String: Any]] = []
        var windowCount = 0
        var complete = true
        for application in applications {
            let app = AXUIElementCreateApplication(application.processIdentifier)
            AXUIElementSetMessagingTimeout(app, 0.5)
            var rawWindows: CFTypeRef?
            let windowsStatus = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows)
            let windows = rawWindows as? [AXUIElement]
            windowCount += windows?.count ?? 0
            complete = complete && windowsStatus == .success && windows != nil && (windows?.count ?? 0) <= 64
            var windowObservations: [[String: Any]] = []
            for window in (windows ?? []).prefix(64) {
                let observedFrame = frame(window)
                windowObservations.append(observedFrame.map { ["frame": Self.boundsData($0)] } ?? ["frameAvailable": false])
                if let frame = observedFrame, Self.close(frame, target.windowBounds, tolerance: 8) {
                    matches.append((application, app, window))
                }
            }
            if observations.count < 4 {
                observations.append(["axWindowsStatus": windowsStatus.rawValue,
                                     "axWindowsValueAvailable": windows != nil,
                                     "windowCount": windows?.count ?? 0,
                                     "framesTruncated": (windows?.count ?? 0) > 64,
                                     "windows": windowObservations])
            }
        }
        diagnostics["observedSafariWindows"] = observations
        diagnostics["processObservationsTruncated"] = applications.count > observations.count
        diagnostics["matchingWindowCount"] = matches.count
        return WindowInventory(matches: matches, windowCount: windowCount, complete: complete)
    }

    private func activateSafari(_ application: NSRunningApplication, diagnostics: inout [String: Any]) throws {
        guard Self.isAppleSafari(application) else {
            throw Failure(code: "SAFARI_NOT_RUNNING", message: "The selected Apple Safari process is no longer available.")
        }
        // AXFrontmost is the public application-specific accessibility focus
        // attribute. The user's AX grant authorizes this explicit Safari action;
        // it does not depend on cooperative AppKit activation from a background app.
        let app = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.5)
        var settable = DarwinBoolean(false)
        let queryStatus = AXUIElementIsAttributeSettable(app, kAXFrontmostAttribute as CFString, &settable)
        diagnostics["axFrontmostSettableQueryStatus"] = queryStatus.rawValue
        diagnostics["axFrontmostSettable"] = settable.boolValue
        guard queryStatus == .success, settable.boolValue else {
            throw Failure(code: "SAFARI_FOCUS_UNAVAILABLE", message: "Safari did not expose writable native accessibility focus. No input was posted.")
        }
        let status = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        diagnostics["axFrontmostSetStatus"] = status.rawValue
        guard status == .success else {
            throw Failure(code: "SAFARI_ACTIVATION_REJECTED", message: "macOS rejected the native accessibility request to focus Safari. No input was posted.")
        }
    }

    private static func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }

    private func safariApplications() -> [NSRunningApplication] {
        Self.onMain { NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari") }
    }

    private func frontmostApplication() -> NSRunningApplication? {
        Self.onMain { NSWorkspace.shared.frontmostApplication }
    }

    private func focusedApplicationPID() -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        guard let focused = element(system, kAXFocusedApplicationAttribute) else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(focused, &pid) == .success, pid > 0 else { return nil }
        return pid
    }

    private func inputState(_ source: CGEventSourceStateID) -> InputState {
        InputState(flags: CGEventSource.flagsState(source),
                   leftMouseDown: CGEventSource.buttonState(source, button: .left),
                   rightMouseDown: CGEventSource.buttonState(source, button: .right))
    }

    private func inputStatesData(combined: InputState? = nil) -> [String: Any] {
        ["combinedSessionState": (combined ?? inputState(.combinedSessionState)).data,
         "hidSystemState": inputState(.hidSystemState).data]
    }

    private static func isAppleSafari(_ application: NSRunningApplication) -> Bool {
        guard application.bundleIdentifier == "com.apple.Safari", !application.isTerminated else { return false }
        var code: SecCode?
        var requirement: SecRequirement?
        return SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: application.processIdentifier] as CFDictionary, [], &code) == errSecSuccess &&
            SecRequirementCreateWithString("anchor apple and identifier \"com.apple.Safari\"" as CFString, [], &requirement) == errSecSuccess &&
            code != nil && requirement != nil && SecCodeCheckValidity(code!, [], requirement!) == errSecSuccess
    }

    static func failureResponse(_ failure: Failure) -> [String: Any] {
        var error: [String: Any] = ["code": failure.code, "message": failure.message,
                                    "eventsPosted": failure.eventsPosted,
                                    "mayHavePostedInput": failure.eventsPosted > 0]
        if let details = failure.details { error["data"] = details }
        return ["ok": false, "error": error]
    }

    private static func boundsData(_ rect: CGRect) -> [String: Double] {
        ["left": rect.minX, "top": rect.minY, "width": rect.width, "height": rect.height]
    }

    private func perform(_ request: Request) throws -> [String: Any] {
        var eventCount = 0
        do {
            return try performNative(request, eventCount: &eventCount)
        } catch var failure as Failure {
            failure.eventsPosted = eventCount
            throw failure
        }
    }

    private func performNative(_ request: Request, eventCount: inout Int) throws -> [String: Any] {
        let context = try context(for: request)
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create the native event source.")
        }
        switch request.action {
        case "click":
            try validateStable(context)
            try hitTest(context)
            guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: context.mapped.point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: context.mapped.point, mouseButton: .left) else {
                throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create native mouse events.")
            }
            for event in [down, up] {
                event.flags = []
                event.setIntegerValueField(.mouseEventClickState, value: 1)
                event.post(tap: .cghidEventTap)
            }
            eventCount = 2
        case "type":
            let focused = try focusedPageElement(context, editable: true)
            if request.replaceAll {
                try validateStable(context, expectedFocus: focused)
                try postKey(source: source, code: 0, flags: .maskCommand)
                eventCount += 2
                // A new value is delivered through native key events, not AX value writes.
                if request.text?.isEmpty == true {
                    try validateStable(context, expectedFocus: focused)
                    try postKey(source: source, code: 51, flags: [])
                    eventCount += 2
                }
            }
            for chunk in Self.unicodeChunks(request.text ?? "") {
                try validateStable(context, expectedFocus: focused)
                guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                    throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create native Unicode keyboard events.")
                }
                chunk.withUnsafeBufferPointer { buffer in
                    for event in [down, up] {
                        event.flags = []
                        event.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress!)
                        event.post(tap: .cghidEventTap)
                    }
                }
                eventCount += 2
            }
        case "key":
            let focused = try focusedPageElement(context, editable: false)
            try validateStable(context, expectedFocus: focused)
            let key = Self.keys[request.key!]!
            try postKey(source: source, code: key.code, flags: key.flags)
            eventCount = 2
        case "scroll":
            try validateStable(context)
            try hitTest(context)
            guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: context.mapped.point, mouseButton: .left),
                  let scroll = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                                       wheel1: Int32((-request.deltaY * context.mapped.scaleY).rounded()),
                                       wheel2: Int32((-request.deltaX * context.mapped.scaleX).rounded()), wheel3: 0) else {
                throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create native scroll events.")
            }
            move.flags = []
            scroll.flags = []
            scroll.location = context.mapped.point
            scroll.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            move.post(tap: .cghidEventTap)
            scroll.post(tap: .cghidEventTap)
            eventCount = 2
        default:
            throw Failure(code: "INVALID_ARGUMENTS", message: "Unknown native input action.")
        }
        return ["action": request.action, "backend": "macOS Accessibility + CGEvent",
                "eventsPosted": eventCount, "pageIdentityVerified": true]
    }

    private func context(for request: Request) throws -> Context {
        try requireUnlockedSession()
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
            throw Failure(code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Allow ChatGPT for Safari in System Settings > Privacy & Security > Accessibility before using native input.")
        }
        guard let front = frontmostApplication(),
              Self.isAppleSafari(front), focusedApplicationPID() == front.processIdentifier else {
            throw Failure(code: "SAFARI_NOT_FRONTMOST", message: "Safari must remain frontmost while controlling its current tab.")
        }
        let app = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 2)
        guard let window = element(app, kAXFocusedWindowAttribute),
              let windowFrame = frame(window), Self.close(windowFrame, request.windowBounds, tolerance: 8) else {
            throw Failure(code: "WINDOW_CHANGED", message: "Safari's focused window no longer matches the selected tab's window.")
        }
        let areas = topLevelWebAreas(window).filter { pageURL($0) == request.expectedURL }
        guard areas.count == 1, let webArea = areas.first else {
            throw Failure(code: "PAGE_CHANGED", message: "Safari's focused window does not expose exactly one page with the expected URL.")
        }
        guard let scrollArea = enclosingScrollArea(webArea, before: window),
              let scrollFrame = frame(scrollArea) else {
            throw Failure(code: "VIEWPORT_UNAVAILABLE", message: "Safari did not expose the page's visible accessibility scroll area.")
        }
        let mapped = try Self.mapPoint(request.point, viewport: request.viewport,
                                       scrollFrame: scrollFrame, windowFrame: windowFrame)
        let context = Context(request: request, pid: front.processIdentifier, app: app,
                              window: window, webArea: webArea, scrollArea: scrollArea,
                              scrollFrame: scrollFrame, mapped: mapped)
        try validateStable(context)
        try hitTest(context)
        return context
    }

    private func validateStable(_ context: Context, expectedFocus: AXUIElement? = nil) throws {
        try requireUnlockedSession()
        guard let front = frontmostApplication(),
              front.bundleIdentifier == "com.apple.Safari", front.processIdentifier == context.pid,
              focusedApplicationPID() == context.pid,
              let window = element(context.app, kAXFocusedWindowAttribute), CFEqual(window, context.window),
              let windowFrame = frame(window), Self.close(windowFrame, context.request.windowBounds, tolerance: 8),
              let scrollFrame = frame(context.scrollArea), Self.close(scrollFrame, context.scrollFrame, tolerance: 1.5),
              pageURL(context.webArea) == context.request.expectedURL else {
            throw Failure(code: "FOCUS_CHANGED", message: "Safari's focus, window, page, or viewport changed. Stop and read the page again before continuing.")
        }
        let input = inputState(.combinedSessionState)
        guard !input.active else {
            throw Failure(code: "USER_INPUT_ACTIVE", message: "Release held modifier keys and mouse buttons before native Safari input.",
                          details: ["inputState": inputStatesData(combined: input)])
        }
        if let expectedFocus {
            guard let focused = element(context.app, kAXFocusedUIElementAttribute),
                  CFEqual(focused, expectedFocus), isDescendant(focused, of: context.webArea) else {
                throw Failure(code: "FOCUS_CHANGED", message: "The page's keyboard target changed. Stop and read the page again before continuing.")
            }
        }
    }

    private func focusedPageElement(_ context: Context, editable: Bool) throws -> AXUIElement {
        guard let focused = element(context.app, kAXFocusedUIElementAttribute),
              isDescendant(focused, of: context.webArea),
              bool(focused, kAXEnabledAttribute) != false else {
            throw Failure(code: "PAGE_NOT_FOCUSED", message: "Native keyboard focus must be inside the selected page, not Safari's toolbar or a dialog.")
        }
        if editable {
            let role = string(focused, kAXRoleAttribute)
            let editableRole = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role ?? "")
            guard editableRole || bool(focused, "AXEditable") == true else {
                throw Failure(code: "EDITABLE_NOT_FOCUSED", message: "Click and verify the page's editable field before typing.")
            }
        }
        return focused
    }

    private func hitTest(_ context: Context) throws {
        var hit: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(context.app, Float(context.mapped.point.x), Float(context.mapped.point.y), &hit)
        guard result == .success, let hit, isDescendant(hit, of: context.webArea) else {
            throw Failure(code: "TARGET_OBSCURED", message: "The native pointer target is not inside the selected page; another Safari surface may cover it.")
        }
    }

    private func postKey(source: CGEventSource, code: CGKeyCode, flags: CGEventFlags) throws {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create native keyboard events.")
        }
        down.flags = flags
        up.flags = []
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    /// AXWebArea can cover the complete document; its parent scroll area is the
    /// actual on-screen viewport. CSS pixels are scaled for Safari page zoom.
    static func mapPoint(_ point: CGPoint, viewport: CGSize, scrollFrame: CGRect,
                         windowFrame: CGRect) throws -> MappedPoint {
        guard viewport.width > 0, viewport.height > 0,
              scrollFrame.width > 0, scrollFrame.height > 0,
              windowFrame.insetBy(dx: -8, dy: -8).contains(scrollFrame),
              point.x >= 0, point.y >= 0, point.x < viewport.width, point.y < viewport.height else {
            throw Failure(code: "VIEWPORT_CHANGED", message: "The page point or native viewport is outside the selected Safari window.")
        }
        let sx = scrollFrame.width / viewport.width
        let sy = scrollFrame.height / viewport.height
        guard sx >= 0.25, sx <= 5, sy >= 0.25, sy <= 5,
              abs(sx - sy) <= max(0.08 * max(sx, sy), 20 / min(viewport.width, viewport.height)) else {
            throw Failure(code: "VIEWPORT_CHANGED", message: "The DOM viewport no longer matches Safari's visible page area.")
        }
        return MappedPoint(point: CGPoint(x: scrollFrame.minX + point.x * sx,
                                          y: scrollFrame.minY + point.y * sy), scaleX: sx, scaleY: sy)
    }

    static func unicodeChunks(_ text: String) -> [[UniChar]] {
        let units = Array(text.utf16)
        var chunks: [[UniChar]] = []
        var start = 0
        while start < units.count {
            var end = min(start + 20, units.count)
            if end < units.count, (0xD800...0xDBFF).contains(units[end - 1]) { end -= 1 }
            chunks.append(Array(units[start..<end]))
            start = end
        }
        return chunks
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func close(_ lhs: CGRect, _ rhs: CGRect, tolerance: CGFloat) -> Bool {
        abs(lhs.minX - rhs.minX) <= tolerance && abs(lhs.minY - rhs.minY) <= tolerance &&
        abs(lhs.width - rhs.width) <= tolerance && abs(lhs.height - rhs.height) <= tolerance
    }

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func element(_ owner: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(owner, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    private func string(_ element: AXUIElement, _ name: String) -> String? {
        attribute(element, name) as? String
    }

    private func bool(_ element: AXUIElement, _ name: String) -> Bool? {
        attribute(element, name) as? Bool
    }

    private func frame(_ element: AXUIElement) -> CGRect? {
        guard let rawPosition = attribute(element, kAXPositionAttribute),
              let rawSize = attribute(element, kAXSizeAttribute),
              CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        let position = rawPosition as! AXValue, size = rawSize as! AXValue
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetType(position) == .cgPoint, AXValueGetType(size) == .cgSize,
              AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions),
              point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite else { return nil }
        return CGRect(origin: point, size: dimensions)
    }

    private func pageURL(_ area: AXUIElement) -> String? {
        let value = attribute(area, kAXURLAttribute)
        if let url = value as? URL { return url.absoluteString }
        return value as? String
    }

    private func topLevelWebAreas(_ window: AXUIElement) -> [AXUIElement] {
        var result: [AXUIElement] = []
        var pending: [(AXUIElement, Int)] = [(window, 0)]
        var index = 0
        let deadline = Date().addingTimeInterval(0.6)
        while index < pending.count, index < 4_096, Date() < deadline {
            let (current, depth) = pending[index]
            index += 1
            if string(current, kAXRoleAttribute) == "AXWebArea" {
                // Do not descend into page content or confuse an iframe with its tab.
                result.append(current)
                continue
            }
            guard depth < 30 else { return [] }
            guard let children = attribute(current, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            guard children.count <= 4_096 - pending.count else { return [] }
            for child in children {
                pending.append((child, depth + 1))
            }
        }
        // A partial tree cannot establish unique page identity.
        return index == pending.count ? result : []
    }

    private func enclosingScrollArea(_ webArea: AXUIElement, before window: AXUIElement) -> AXUIElement? {
        var current = element(webArea, kAXParentAttribute)
        for _ in 0..<30 {
            guard let node = current, !CFEqual(node, window) else { return nil }
            if string(node, kAXRoleAttribute) == kAXScrollAreaRole { return node }
            current = element(node, kAXParentAttribute)
        }
        return nil
    }

    private func isDescendant(_ child: AXUIElement, of ancestor: AXUIElement) -> Bool {
        var current: AXUIElement? = child
        for _ in 0..<64 {
            guard let node = current else { return false }
            if CFEqual(node, ancestor) { return true }
            current = element(node, kAXParentAttribute)
        }
        return false
    }
}
