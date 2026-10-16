import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// Trusted input for the Safari tab already selected by the Web Extension.
/// The extension owns DOM freshness/actionability; this class owns native focus,
/// page identity, viewport mapping, and delivery. It never activates an app or retries.
final class SafariLiveInput {
    struct Failure: Error {
        let code: String
        let message: String
        var eventsPosted: Int = 0
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
                  ["click", "type", "key", "scroll"].contains(action),
                  let expectedURL = command["expectedUrl"] as? String,
                  Self.isPageURL(expectedURL),
                  let bounds = command["windowBounds"] as? [String: Any],
                  let left = SafariLiveInput.number(bounds["left"]),
                  let top = SafariLiveInput.number(bounds["top"]),
                  let width = SafariLiveInput.number(bounds["width"]),
                  let height = SafariLiveInput.number(bounds["height"]),
                  abs(left) <= 100_000, abs(top) <= 100_000,
                  width > 0, height > 0, width <= 100_000, height <= 100_000,
                  let viewport = command["viewport"] as? [String: Any],
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
            self.expectedURL = expectedURL
            self.windowBounds = CGRect(x: left, y: top, width: width, height: height)
            self.viewport = CGSize(width: viewportWidth, height: viewportHeight)
            self.point = CGPoint(x: x, y: y)
            self.text = text
            self.replaceAll = replaceAll
            self.key = key
            self.deltaX = deltaX
            self.deltaY = deltaY
        }

        private static func isPageURL(_ value: String) -> Bool {
            guard let url = URLComponents(string: value),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  let host = url.host, !host.isEmpty,
                  url.user == nil, url.password == nil else { return false }
            return url.url != nil
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
                let request = try Request(command)
                let result = try perform(request)
                reply(["ok": true, "result": result])
            } catch let failure as Failure {
                reply(["ok": false, "error": ["code": failure.code, "message": failure.message,
                                               "eventsPosted": failure.eventsPosted,
                                               "mayHavePostedInput": failure.eventsPosted > 0]])
            } catch {
                reply(["ok": false, "error": ["code": "NATIVE_INPUT_FAILED", "message": "Native Safari input failed."]])
            }
        }
    }

    private func status() -> [String: Any] {
        let trusted = AXIsProcessTrusted()
        let posting = CGPreflightPostEventAccess()
        return [
            "backend": "macOS Accessibility + CGEvent",
            "scope": "existing_safari_tabs",
            "accessibilityTrusted": trusted,
            "postEventAccess": posting,
            "canPostInput": trusted && posting,
            "safariRunning": NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").contains { !$0.isTerminated },
            "safariFrontmost": NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Safari"
        ]
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
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
            throw Failure(code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Allow ChatGPT for Safari in System Settings > Privacy & Security > Accessibility before using native input.")
        }
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.bundleIdentifier == "com.apple.Safari", !front.isTerminated else {
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
        guard let front = NSWorkspace.shared.frontmostApplication,
              front.bundleIdentifier == "com.apple.Safari", front.processIdentifier == context.pid,
              let window = element(context.app, kAXFocusedWindowAttribute), CFEqual(window, context.window),
              let windowFrame = frame(window), Self.close(windowFrame, context.request.windowBounds, tolerance: 8),
              let scrollFrame = frame(context.scrollArea), Self.close(scrollFrame, context.scrollFrame, tolerance: 1.5),
              pageURL(context.webArea) == context.request.expectedURL else {
            throw Failure(code: "FOCUS_CHANGED", message: "Safari's focus, window, page, or viewport changed. Stop and read the page again before continuing.")
        }
        let held = CGEventSource.flagsState(.combinedSessionState).intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        guard held.isEmpty,
              !CGEventSource.buttonState(.combinedSessionState, button: .left),
              !CGEventSource.buttonState(.combinedSessionState, button: .right) else {
            throw Failure(code: "USER_INPUT_ACTIVE", message: "Release held modifier keys and mouse buttons before native Safari input.")
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
        while index < pending.count, index < 4_096 {
            let (current, depth) = pending[index]
            index += 1
            if string(current, kAXRoleAttribute) == "AXWebArea" {
                // Do not descend into page content or confuse an iframe with its tab.
                result.append(current)
                continue
            }
            guard depth < 30, let children = attribute(current, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            for child in children.prefix(4_096 - min(pending.count, 4_096)) {
                pending.append((child, depth + 1))
            }
        }
        return result
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
