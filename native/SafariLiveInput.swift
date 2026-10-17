import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security
import ScreenCaptureKit

/// Trusted input for the Safari tab already selected by the Web Extension.
/// The extension owns DOM freshness/actionability; this class owns native focus,
/// page identity, viewport mapping, and delivery. Only the explicit focus action
/// activates the matched Safari window; input actions never activate or retry.
// Mutable leases and AX operations are confined to queue. The asynchronous
// capture callback returns to that queue before reading or changing them.
final class SafariLiveInput: @unchecked Sendable {
    struct Failure: Error {
        let code: String
        let message: String
        var eventsPosted: Int = 0
        var details: [String: Any]? = nil
    }

    struct Target {
        let expectedURL: String
        let windowBounds: CGRect
        let allowDialog: Bool

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
            guard command["allowJavaScriptDialog"] == nil || SafariLiveInput.boolean(command["allowJavaScriptDialog"]) != nil else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "allowJavaScriptDialog must be a boolean.")
            }
            self.allowDialog = SafariLiveInput.boolean(command["allowJavaScriptDialog"]) ?? false
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
        let clickCount: Int
        let button: CGMouseButton
        let modifiers: CGEventFlags
        let path: [CGPoint]
        let options: [SelectOption]
        let multiple: Bool

        init(_ command: [String: Any]) throws {
            guard let action = command["action"] as? String,
                  ["click", "type", "key", "scroll", "move", "drag", "select"].contains(action) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected click, type, key, scroll, move, drag, or select.")
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
            let modifierNames = command["modifiers"] as? [String] ?? []
            guard command["modifiers"] == nil || command["modifiers"] is [String], modifierNames.count <= 4,
                  let modifiers = SafariLiveInput.modifierFlags(modifierNames) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Use only Meta, Control, Alt, and Shift modifiers.")
            }
            if action == "key", key.flatMap({ SafariLiveInput.nativeKey($0, additional: modifiers) }) == nil {
                throw Failure(code: "UNSUPPORTED_KEY", message: "Use a page key or page-editing shortcut; browser and system shortcuts are unavailable.")
            }
            let clickCount = command["clickCount"].flatMap(SafariLiveInput.number) ?? 1
            guard command["clickCount"] == nil || SafariLiveInput.number(command["clickCount"]) != nil,
                  clickCount.rounded() == clickCount, (1...3).contains(clickCount),
                  let button = ["left": CGMouseButton.left, "right": .right, "middle": .center][command["button"] as? String ?? "left"] else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Use left, right, or middle mouse button and clickCount between 1 and 3.")
            }
            var path = [CGPoint]()
            if action == "drag" {
                guard let points = command["path"] as? [[String: Any]], (2...128).contains(points.count) else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "A drag requires 2 to 128 viewport points.")
                }
                for item in points {
                    guard let px = SafariLiveInput.number(item["x"]), let py = SafariLiveInput.number(item["y"]),
                          px >= 0, py >= 0, px < viewportWidth, py < viewportHeight else {
                        throw Failure(code: "INVALID_ARGUMENTS", message: "Every drag point must be inside the observed viewport.")
                    }
                    path.append(CGPoint(x: px, y: py))
                }
                guard path.first == CGPoint(x: x, y: y) else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "The drag point must match the first path point.")
                }
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
            self.clickCount = Int(clickCount)
            self.button = button
            self.modifiers = modifiers
            self.path = path
            if action == "select" {
                guard let raw = command["options"] as? [[String: Any]], raw.count <= 128,
                      command["multiple"] == nil || SafariLiveInput.boolean(command["multiple"]) != nil else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "Select requires resolved option labels and indexes.")
                }
                options = try raw.map(SelectOption.init)
                multiple = SafariLiveInput.boolean(command["multiple"]) ?? false
                guard multiple || options.count == 1, Set(options.map(\.index)).count == options.count else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "A single select needs exactly one distinct option.")
                }
            } else { options = []; multiple = false }
        }

    }

    struct SelectOption {
        let label: String
        let index: Int
        init(_ raw: [String: Any]) throws {
            guard let label = raw["label"] as? String, label.utf16.count <= 8000,
                  let index = SafariLiveInput.number(raw["index"]), index.rounded() == index,
                  index >= 0, index < 100_000 else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Every native select option needs its exact observed label and index.")
            }
            self.label = label
            self.index = Int(index)
        }
    }

    /// A one-command response authorized before its native opening click.
    /// No response or file selection survives this input operation.
    struct ModalPlan {
        let policy: [String: Any]
        let scope: [String: String]
        let kind: String
        let timeout: TimeInterval
        let type: String?
        let message: String?
        let accept: Bool?
        let promptText: String?
        let files: [SafariFileChooser.LocalFile]
        let multiple: Bool

        init(_ raw: Any?, request: Request) throws {
            guard request.action == "click", request.clickCount == 1, request.button == .left, request.modifiers.isEmpty,
                  let raw = raw as? [String: Any], let policy = raw["policy"] as? [String: Any],
                  let scope = raw["scope"] as? [String: String],
                  Set(scope.keys) == ["profileId", "tabId", "documentId", "node", "ownerId", "accountScope", "sessionId", "turnId"],
                  scope.values.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 && !$0.contains("\0") }),
                  let tab = Int(scope["tabId"]!), tab > 0, String(tab) == scope["tabId"],
                  let kind = policy["kind"] as? String, ["dialog", "upload"].contains(kind),
                  let timeout = SafariLiveInput.number(policy["timeout_ms"]), (1...10_000).contains(timeout), timeout.rounded() == timeout else {
                throw Failure(code: "INVALID_NATIVE_MODAL", message: "A native modal response requires one plain click and its exact original owner/account/profile/turn/tab/document/node scope.")
            }
            self.policy = policy; self.scope = scope; self.kind = kind; self.timeout = timeout / 1000
            if kind == "dialog" {
                guard Set(policy.keys).isSubset(of: ["kind", "timeout_ms", "type", "message", "accept", "promptText"]),
                      let type = policy["type"] as? String, ["alert", "confirm", "prompt"].contains(type),
                      let message = policy["message"] as? String, message.utf16.count <= 8000,
                      let accept = SafariLiveInput.boolean(policy["accept"]), type != "alert" || accept,
                      policy["promptText"] == nil || (type == "prompt" && accept && policy["promptText"] is String),
                      (policy["promptText"] as? String)?.utf16.count ?? 0 <= 20_000 else {
                    throw Failure(code: "INVALID_NATIVE_MODAL", message: "Specify the exact alert/confirm/prompt message and an explicit accept boolean; promptText is only valid when accepting a prompt.")
                }
                self.type = type; self.message = message; self.accept = accept; promptText = policy["promptText"] as? String
                files = []; multiple = false
            } else {
                guard Set(policy.keys) == ["kind", "timeout_ms", "files"], let multiple = SafariLiveInput.boolean(raw["isMultiple"]) else {
                    throw Failure(code: "INVALID_NATIVE_MODAL", message: "An approved native upload requires explicit files and the exact observed source input's multiple flag.")
                }
                do { files = try SafariFileChooser.files(policy["files"], multiple: multiple) }
                catch let failure as SafariFileChooser.Failure { throw Failure(code: failure.code, message: failure.message) }
                self.multiple = multiple; type = nil; message = nil; accept = nil; promptText = nil
            }
        }

        func matches(type: String, message: String) -> Bool {
            kind == "dialog" && self.type == type && self.message == message
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
        let middleMouseDown: Bool

        init(flags: CGEventFlags, leftMouseDown: Bool, rightMouseDown: Bool, middleMouseDown: Bool = false) {
            heldModifiers = [(CGEventFlags.maskCommand, "Command"), (.maskControl, "Control"),
                             (.maskAlternate, "Option"), (.maskShift, "Shift")]
                .filter { flags.contains($0.0) }.map { $0.1 }
            self.leftMouseDown = leftMouseDown
            self.rightMouseDown = rightMouseDown
            self.middleMouseDown = middleMouseDown
        }

        var active: Bool { !heldModifiers.isEmpty || leftMouseDown || rightMouseDown || middleMouseDown }
        var data: [String: Any] {
            ["heldModifiers": heldModifiers, "leftMouseDown": leftMouseDown, "rightMouseDown": rightMouseDown, "middleMouseDown": middleMouseDown]
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

    private static func modifierFlags(_ names: [String]) -> CGEventFlags? {
        var result = CGEventFlags()
        for name in names {
            switch name.lowercased() {
            case "meta", "command", "controlormeta": result.insert(.maskCommand)
            case "control", "ctrl": result.insert(.maskControl)
            case "alt", "option": result.insert(.maskAlternate)
            case "shift": result.insert(.maskShift)
            default: return nil
            }
        }
        return result
    }

    private static func nativeKey(_ value: String, additional: CGEventFlags = []) -> NativeKey? {
        var components = value.split(separator: "+").map(String.init)
        guard let name = components.popLast(), let parsed = modifierFlags(components) else { return nil }
        let flags = parsed.union(additional)
        let characters: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,
            "b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,
            "=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"l":37,
            "j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"`":50]
        // Page edit shortcuts must not turn a claimed-page operation into an
        // app/window/address-bar command. Navigation has its own explicit API.
        let normalized = name.count == 1 ? name.lowercased() : name
        if flags.contains(.maskCommand) {
            guard !flags.contains(.maskControl), !flags.contains(.maskAlternate),
                  ["a", "c", "v", "x", "z", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace"].contains(normalized),
                  !flags.contains(.maskShift) || ["v", "z", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].contains(normalized) else { return nil }
        }
        if flags.contains(.maskControl), (flags.contains(.maskAlternate)
            || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Tab", "Escape", "Enter"].contains(normalized)) { return nil }
        guard let base = keys[name] ?? characters[name.lowercased()].map({ NativeKey(code: $0, flags: []) }) else { return nil }
        return NativeKey(code: base.code, flags: base.flags.union(flags))
    }

    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.live-input")
    private var dialogLease: (id: String, node: AXUIElement, window: AXUIElement, url: String)?
    private let bookmarks = SafariBookmarks()
    private let armedFileChooser = SafariFileChooser()
    private let nativeClipboard = SafariNativeClipboard()
    private var currentAuthorization: (() -> Bool)?

    func acknowledgeClipboard(_ input: [String: Any]) { nativeClipboard.acknowledge(input) }

    init() {
        // NSRunningApplication's dynamic properties refresh with the main run
        // loop. Create Workspace there rather than on our non-runloop queue.
        Self.onMain { _ = NSWorkspace.shared.runningApplications }
    }

    func handle(_ command: [String: Any], isAuthorized: @escaping () -> Bool = { true }, reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            currentAuthorization = isAuthorized
            defer { currentAuthorization = nil }
            do {
                try requireCurrentAuthorization()
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
                if action == "dialog" {
                    reply(["ok": true, "result": try handleDialog(command)]); return
                }
                if action == "modalStatus" {
                    reply(["ok": true, "result": try modalStatus(command)]); return
                }
                let request = try Request(command)
                let plan = try command["modalPlan"].map { try ModalPlan($0, request: request) }
                let clipboard = try command["clipboardPlan"].map { try SafariNativeClipboard.Plan($0, key: request.key) }
                guard clipboard == nil || request.action == "key" && plan == nil else {
                    throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "A transient clipboard shortcut cannot attach to a click, modal response or unrelated input action.")
                }
                let result = try perform(request, modalPlan: plan, clipboardPlan: clipboard)
                reply(["ok": true, "result": result])
            } catch let failure as Failure {
                reply(Self.failureResponse(failure))
            } catch let failure as SafariNativeClipboard.Failure {
                reply(Self.failureResponse(Failure(code: failure.code, message: failure.message)))
            } catch {
                reply(["ok": false, "error": ["code": "NATIVE_INPUT_FAILED", "message": "Native Safari input failed."]])
            }
        }
    }

    func capture(_ command: [String: Any], isAuthorized: @escaping () -> Bool,
                 reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            do {
                guard Self.onMain(isAuthorized) else {
                    throw Failure(code: "STALE_OPERATION", message: "The page capture no longer belongs to an active command.")
                }
                guard CGPreflightScreenCaptureAccess() else {
                    throw Failure(code: "SCREEN_CAPTURE_PERMISSION_REQUIRED", message: "Allow ChatGPT for Safari to record its selected Safari window in System Settings > Privacy & Security > Screen & System Audio Recording.")
                }
                let viewport = command["viewport"] as? [String: Any] ?? [:]
                guard let width = Self.number(viewport["width"]), let height = Self.number(viewport["height"]) else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "A page capture requires the observed viewport.")
                }
                var input = command
                input["action"] = "move"
                input["point"] = ["x": width / 2, "y": height / 2]
                let request = try Request(input)
                let context = try context(for: request)
                let clip = try Self.captureClip(command["clip"], viewport: request.viewport)
                Task {
                    do {
                        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                        let windows = content.windows.filter { window in
                            window.owningApplication?.processID == context.pid &&
                            Self.close(window.frame, request.windowBounds, tolerance: 8)
                        }
                        guard windows.count == 1, let window = windows.first else {
                            throw Failure(code: "CAPTURE_WINDOW_CHANGED", message: "The selected Safari window does not have one exact capture identity.")
                        }
                        let capturedFrame = window.frame
                        let configuration = SCStreamConfiguration()
                        configuration.width = Int(window.frame.width.rounded())
                        configuration.height = Int(window.frame.height.rounded())
                        configuration.showsCursor = false
                        if #available(macOS 14.2, *) { configuration.ignoreShadowsSingleWindow = true }
                        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration)
                        self.queue.async {
                            do {
                                guard Self.onMain(isAuthorized) else {
                                    throw Failure(code: "STALE_OPERATION", message: "The page capture owner changed; the captured image was discarded.")
                                }
                                try self.validateStable(context)
                                let scaleX = CGFloat(image.width) / capturedFrame.width
                                let scaleY = CGFloat(image.height) / capturedFrame.height
                                let rect = CGRect(x: (context.scrollFrame.minX - capturedFrame.minX + clip.minX * context.mapped.scaleX) * scaleX,
                                                  y: (context.scrollFrame.minY - capturedFrame.minY + clip.minY * context.mapped.scaleY) * scaleY,
                                                  width: clip.width * context.mapped.scaleX * scaleX,
                                                  height: clip.height * context.mapped.scaleY * scaleY).integral
                                guard CGRect(x: 0, y: 0, width: image.width, height: image.height).contains(rect),
                                      let cropped = image.cropping(to: rect),
                                      let png = NSBitmapImageRep(cgImage: cropped).representation(using: .png, properties: [:]), png.count <= 8 * 1024 * 1024 else {
                                    throw Failure(code: "CAPTURE_BOUNDS_CHANGED", message: "The page capture could not be cropped to its verified viewport.")
                                }
                                reply(["ok": true, "result": ["dataUrl": "data:image/png;base64," + png.base64EncodedString(),
                                    "width": cropped.width, "height": cropped.height]])
                            } catch let failure as Failure { reply(Self.failureResponse(failure)) }
                            catch { reply(Self.failureResponse(Failure(code: "CAPTURE_FAILED", message: "Safari page capture failed."))) }
                        }
                    } catch let failure as Failure { reply(Self.failureResponse(failure)) }
                    catch { reply(Self.failureResponse(Failure(code: "CAPTURE_FAILED", message: "The native Safari capture service did not return an image."))) }
                }
            } catch let failure as Failure { reply(Self.failureResponse(failure)) }
            catch { reply(Self.failureResponse(Failure(code: "CAPTURE_FAILED", message: "Safari page capture failed."))) }
        }
    }

    func manageBookmarks(_ command: [String: Any], profileIdentity: String, isAuthorized: @escaping () -> Bool,
                         reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            var guardStage = "none"
            do {
                guard Self.onMain(isAuthorized), let method = command["method"] as? String,
                      ["getTree", "search", "get", "getChildren", "getSubTree", "update", "createFolder", "create", "remove", "removeTree", "move"].contains(method),
                      let args = command["arguments"] as? [Any] else {
                    throw Failure(code: "STALE_OPERATION", message: "This bookmark operation has no current sidebar authorization.")
                }
                let target = try Target(command)
                var diagnostics: [String: Any] = [:]
                _ = try focusTarget(target, diagnostics: &diagnostics)
                guard let front = frontmostApplication(), Self.isAppleSafari(front),
                      let window = element(AXUIElementCreateApplication(front.processIdentifier), kAXFocusedWindowAttribute),
                      let identifier = string(window, kAXIdentifierAttribute), identifier.hasPrefix("SafariWindow?") else {
                    throw Failure(code: "WINDOW_CHANGED", message: "The temporary Safari bookmark window is unavailable.")
                }
                let app = AXUIElementCreateApplication(front.processIdentifier)
                var editorPhase = false
                let deadline = Date().addingTimeInterval(20)
                func stableWindow(postedButton: CGMouseButton? = nil) -> Bool {
                    guard Self.onMain(isAuthorized) else { guardStage = "owner"; return false }
                    guard self.frontmostApplication()?.processIdentifier == front.processIdentifier else { guardStage = "frontmost_process"; return false }
                    guard self.focusedApplicationPID() == front.processIdentifier else { guardStage = "focused_application"; return false }
                    guard let focused = self.element(app, kAXFocusedWindowAttribute), CFEqual(focused, window) else { guardStage = "focused_window"; return false }
                    guard self.string(window, kAXIdentifierAttribute) == identifier else { guardStage = "window_identity"; return false }
                    guard let bounds = self.frame(window), Self.close(bounds, target.windowBounds, tolerance: 8) else { guardStage = "window_bounds"; return false }
                    guard Date() < deadline else { guardStage = "deadline"; return false }
                    let input = self.inputState(.combinedSessionState)
                    guard input.heldModifiers.isEmpty,
                          (!input.leftMouseDown || postedButton == .left),
                          (!input.rightMouseDown || postedButton == .right),
                          (!input.middleMouseDown || postedButton == .center) else { guardStage = "input"; return false }
                    return true
                }
                func surfaceNodes() -> [AXUIElement]? {
                    SafariBookmarks.editorSurfaceNodes(window, children: {
                        (attribute($0, kAXChildrenAttribute) as? [AXUIElement] ?? [])
                            + (attribute($0, "AXSheets") as? [AXUIElement] ?? [])
                    }, role: { string($0, kAXRoleAttribute) }, identifier: { string($0, kAXIdentifierAttribute) }, equal: { CFEqual($0, $1) })
                }
                let addressValue = { [self] in
                    let address = surfaceNodes()?.first { self.string($0, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }
                    return address.flatMap { self.string($0, kAXValueAttribute) }
                }
                let utilityAddress = { (value: String?) in
                    value == target.expectedURL || value == String(target.expectedURL.dropFirst("http://".count))
                }
                func editorObservation() -> (readiness: SafariBookmarks.EditorReadiness, addressKind: String, outlineCount: Int,
                                              addressMatchesOutline: Bool, titleMatchesOutline: Bool, hasWebArea: Bool, documentKind: String, surfaceComplete: Bool) {
                    let surface = surfaceNodes(), nodes = surface ?? []
                    let address = nodes.first { string($0, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }.flatMap { string($0, kAXValueAttribute) }
                    let outlines = nodes.filter { string($0, kAXIdentifierAttribute) == "Bookmarks" && string($0, kAXRoleAttribute) == kAXOutlineRole }
                    let label = outlines.count == 1 ? string(outlines[0], kAXDescriptionAttribute) : nil
                    let addressMatchesOutline = label.map { !$0.isEmpty && address == $0 } ?? false
                    let titleMatchesOutline = label.map { !$0.isEmpty && string(window, kAXTitleAttribute) == $0 } ?? false
                    let hasWebArea = nodes.contains { string($0, kAXRoleAttribute) == "AXWebArea" }
                    let document = string(window, kAXDocumentAttribute) ?? pageURL(window)
                    let documentKind = document == nil ? "unavailable" : document == "bookmarks://" ? "bookmarks" : utilityAddress(document) ? "utility" : "other"
                    let addressKind = utilityAddress(address) ? "utility" : address == "bookmarks://" ? "bookmarks" : address == nil || address == "" ? "empty" : addressMatchesOutline ? "outline_label" : "other"
                    return (SafariBookmarks.editorReadiness(address: address, utilityURL: target.expectedURL, nativeOutlineCount: outlines.count,
                                nativeTitleMatchesOutline: titleMatchesOutline, hasWebArea: hasWebArea), addressKind, min(outlines.count, 2),
                            addressMatchesOutline, titleMatchesOutline, hasWebArea, documentKind, surface != nil)
                }
                let boundPage = {
                    if editorPhase {
                        let observation = editorObservation()
                        guard observation.surfaceComplete else { guardStage = "editor_surface"; return false }
                        guard observation.readiness == .ready else { guardStage = "editor_identity"; return false }
                    } else if !utilityAddress(addressValue()) { guardStage = "utility_identity"; return false }
                    guardStage = "none"
                    return true
                }
                let valid = { stableWindow() && boundPage() }
                let validWithPostedButton = { (button: CGMouseButton) in stableWindow(postedButton: button) && boundPage() }
                func openEditor() throws {
                    guard valid(), let menuBar = element(app, kAXMenuBarAttribute),
                          let menu = nativeNodes(menuBar).first(where: { string($0, kAXIdentifierAttribute) == "SafariBookmarksMenu" }),
                          AXUIElementPerformAction(menu, kAXPressAction as CFString) == .success else {
                        throw Failure(code: "BOOKMARK_EDITOR_UNAVAILABLE", message: "Safari's native bookmarks menu is unavailable.")
                    }
                    guard valid(), let editor = nativeNodes(menuBar).first(where: { string($0, kAXIdentifierAttribute) == "EditBookmarks" }),
                          AXUIElementPerformAction(editor, kAXPressAction as CFString) == .success else {
                        throw Failure(code: "BOOKMARK_EDITOR_UNAVAILABLE", message: "Safari's native bookmarks editor could not be opened.")
                    }
                    editorPhase = true
                    let transitionDeadline = Date().addingTimeInterval(2)
                    var observation = editorObservation()
                    var windowStable = true
                    while Date() < transitionDeadline {
                        windowStable = stableWindow()
                        guard windowStable else { break }
                        observation = editorObservation()
                        switch observation.readiness {
                        case .ready: return
                        case .changed: break
                        case .waiting:
                            Thread.sleep(forTimeInterval: 0.025)
                            continue
                        }
                        break
                    }
                    throw Failure(code: "BOOKMARK_EDITOR_UNAVAILABLE", message: "Safari did not expose the exact temporary window's native bookmarks editor. Native editor result: addressKind=\(observation.addressKind), documentKind=\(observation.documentKind), outlineCount=\(observation.outlineCount), windowStable=\(windowStable), addressMatchesOutline=\(observation.addressMatchesOutline), titleMatchesOutline=\(observation.titleMatchesOutline), hasWebArea=\(observation.hasWebArea), surfaceComplete=\(observation.surfaceComplete), guardStage=\(guardStage).")
                }
                func utilityPage(_ operation: () throws -> Void) throws {
                    guard valid(), let address = nativeNodes(window).first(where: { string($0, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }),
                          AXUIElementSetAttributeValue(address, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
                        throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari could not focus the temporary window's native address field.")
                    }
                    let focusDeadline = Date().addingTimeInterval(1)
                    while stableWindow(), Date() < focusDeadline {
                        if let focused = element(app, kAXFocusedUIElementAttribute), CFEqual(focused, address) { break }
                        Thread.sleep(forTimeInterval: 0.025)
                    }
                    guard let focused = element(app, kAXFocusedUIElementAttribute), CFEqual(focused, address), stableWindow(),
                          AXUIElementSetAttributeValue(address, kAXValueAttribute as CFString, target.expectedURL as CFString) == .success,
                          utilityAddress(addressValue()), let source = CGEventSource(stateID: .combinedSessionState) else {
                        throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari could not prepare the exact capability-bound bookmark utility page.")
                    }
                    try postKey(source: source, code: 36, flags: [])
                    editorPhase = false
                    let transitionDeadline = Date().addingTimeInterval(3)
                    var loaded = false
                    while stableWindow(), utilityAddress(addressValue()), Date() < transitionDeadline {
                        let pages = nativeNodes(window).filter { string($0, kAXRoleAttribute) == "AXWebArea" && pageURL($0) == target.expectedURL }
                        if pages.count == 1 { loaded = true; break }
                        Thread.sleep(forTimeInterval: 0.025)
                    }
                    guard loaded, valid() else { throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari did not load the exact capability-bound bookmark utility page.") }
                    try operation()
                    try openEditor()
                }
                try openEditor()
                guard valid() else { throw Failure(code: "FOCUS_CHANGED", message: "The temporary bookmarks window changed. No bookmark command was replayed.") }
                let result = try bookmarks.perform(method: method, args: args, window: window, profileIdentity: profileIdentity,
                    utilityURL: target.expectedURL, withUtilityPage: utilityPage,
                    assertCurrentWithPostedButton: validWithPostedButton, assertCurrent: valid)
                guard bookmarks.lastRestorationConfirmed else {
                    throw Failure(code: "BOOKMARK_RESTORATION_UNCONFIRMED", message: "The bookmark command finished, but the editor's temporary expansion could not be restored. Inspect current state before repeating it.",
                                  details: ["mutationApplied": ["update", "createFolder", "create", "remove", "removeTree", "move"].contains(method), "doNotReplay": true])
                }
                reply(["ok": true, "result": result])
            } catch let failure as SafariBookmarks.Failure {
                let message = failure.code == "FOCUS_CHANGED" ? failure.message + " Native guard stage: \(guardStage)." : failure.message
                reply(Self.failureResponse(Failure(code: failure.code, message: message,
                    details: ["mutationApplied": failure.mutationApplied, "doNotReplay": failure.mutationApplied])))
            } catch let failure as Failure {
                reply(Self.failureResponse(failure.code == "FOCUS_CHANGED"
                    ? Failure(code: failure.code, message: failure.message + " Native guard stage: \(guardStage).", details: failure.details) : failure))
            }
            catch { reply(Self.failureResponse(Failure(code: "BOOKMARK_OPERATION_FAILED", message: "Safari's native bookmark operation failed."))) }
        }
    }

    static func captureClip(_ raw: Any?, viewport: CGSize) throws -> CGRect {
        guard let raw else { return CGRect(origin: .zero, size: viewport) }
        guard let values = raw as? [String: Any], let x = number(values["x"]), let y = number(values["y"]),
              let width = number(values["width"]), let height = number(values["height"]),
              x >= 0, y >= 0, width > 0, height > 0, x + width <= viewport.width, y + height <= viewport.height else {
            throw Failure(code: "INVALID_ARGUMENTS", message: "The capture clip must be inside the observed viewport.")
        }
        return CGRect(x: x, y: y, width: width, height: height)
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
        // Application identifiers explain a foreground refusal without
        // collecting window titles, documents, or account information.
        result["frontmostApplication"] = mainFront?.bundleIdentifier ?? "unknown"
        if let focusedPID {
            result["focusedApplication"] = Self.onMain { NSRunningApplication(processIdentifier: focusedPID)?.bundleIdentifier } ?? "unknown"
        }
        result["inputState"] = inputStatesData()
        result["clipboard"] = nativeClipboard.recoveryStatus()
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
        try requireCurrentAuthorization()
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
                    || (target.allowDialog && (try? verifiedDialog(window, target: target)) != nil)
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
        let matchingDialog = target.allowDialog && (try? verifiedDialog(window, target: target)) != nil
        if !exposed.isEmpty, exposed.filter({ pageURL($0) == target.expectedURL }).count != 1, !matchingDialog {
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
            try requireCurrentAuthorization()
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
                let matchingDialog = target.allowDialog && (try? verifiedDialog(window, target: target)) != nil
                if let focusedWindow, CFEqual(focusedWindow, window), (matchingPages == 1 || matchingDialog),
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
                   rightMouseDown: CGEventSource.buttonState(source, button: .right),
                   middleMouseDown: CGEventSource.buttonState(source, button: .center))
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

    private func perform(_ request: Request, modalPlan: ModalPlan? = nil, clipboardPlan: SafariNativeClipboard.Plan? = nil) throws -> [String: Any] {
        var eventCount = 0
        do {
            return try performNative(request, eventCount: &eventCount, modalPlan: modalPlan, clipboardPlan: clipboardPlan)
        } catch var failure as Failure {
            failure.eventsPosted = max(failure.eventsPosted, eventCount)
            if modalPlan != nil || clipboardPlan != nil, eventCount > 0 {
                failure.details = (failure.details ?? [:]).merging(["mutationApplied": true, "doNotReplay": true]) { _, new in new }
            }
            throw failure
        }
    }

    private func performNative(_ request: Request, eventCount: inout Int, modalPlan: ModalPlan? = nil,
                               clipboardPlan: SafariNativeClipboard.Plan? = nil) throws -> [String: Any] {
        let context = try context(for: request)
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create the native event source.")
        }
        if let clipboardPlan {
            let focused = try focusedPageElement(context, editable: clipboardPlan.operation != "copy")
            do {
                let value = try nativeClipboard.perform(clipboardPlan, validate: { try self.validateStable(context, expectedFocus: focused) }, sendKey: { posted in
                    try self.validateStable(context, expectedFocus: focused)
                    let key = Self.nativeKey(request.key!)!
                    try self.postKey(source: source, code: key.code, flags: key.flags, didPost: {
                        eventCount += 2; posted()
                    })
                })
                return ["action": request.action, "backend": "macOS Accessibility + CGEvent", "eventsPosted": eventCount,
                        "pageIdentityVerified": true, "nativeClipboard": value]
            } catch let failure as SafariNativeClipboard.Failure {
                throw Failure(code: failure.code, message: failure.message)
            }
        }
        switch request.action {
        case "select":
            try selectOptions(context, eventCount: &eventCount)
        case "click":
            let types = Self.mouseTypes(request.button)
            for count in 1...request.clickCount {
                try validateStable(context)
                try hitTest(context)
                guard let down = CGEvent(mouseEventSource: source, mouseType: types.down, mouseCursorPosition: context.mapped.point, mouseButton: request.button),
                      let up = CGEvent(mouseEventSource: source, mouseType: types.up, mouseCursorPosition: context.mapped.point, mouseButton: request.button) else {
                    throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create native mouse events.")
                }
                for event in [down, up] {
                    event.flags = request.modifiers
                    event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
                    event.post(tap: .cghidEventTap)
                    eventCount += 1
                }
            }
        case "move":
            try validateStable(context)
            try hitTest(context)
            guard let event = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: context.mapped.point, mouseButton: request.button) else {
                throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create the native pointer event.")
            }
            event.flags = request.modifiers
            event.post(tap: .cghidEventTap)
            eventCount = 1
        case "drag":
            let points = try request.path.map { try Self.mapPoint($0, viewport: request.viewport,
                scrollFrame: context.scrollFrame, windowFrame: request.windowBounds).point }
            let types = Self.mouseTypes(request.button)
            try validateStable(context)
            try hitTest(context)
            var last = points[0]
            guard let down = CGEvent(mouseEventSource: source, mouseType: types.down, mouseCursorPosition: last, mouseButton: request.button) else {
                throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create the native drag start.")
            }
            down.flags = request.modifiers
            down.post(tap: .cghidEventTap)
            eventCount += 1
            // Release only our delivered button even when focus changes, so an
            // interrupted batch cannot leave a global mouse button held down.
            defer {
                if let up = CGEvent(mouseEventSource: source, mouseType: types.up, mouseCursorPosition: last, mouseButton: request.button) {
                    up.flags = []
                    up.post(tap: .cghidEventTap)
                    eventCount += 1
                }
            }
            for point in points.dropFirst() {
                try validateStable(context, postedButton: request.button, postedModifiers: request.modifiers)
                var hit: AXUIElement?
                guard AXUIElementCopyElementAtPosition(context.app, Float(point.x), Float(point.y), &hit) == .success,
                      let hit, isDescendant(hit, of: context.webArea) else {
                    throw Failure(code: "TARGET_OBSCURED", message: "The native drag path left the selected page.")
                }
                guard let event = CGEvent(mouseEventSource: source, mouseType: types.drag, mouseCursorPosition: point, mouseButton: request.button) else {
                    throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create a native drag event.")
                }
                event.flags = request.modifiers
                event.post(tap: .cghidEventTap)
                eventCount += 1
                last = point
                Thread.sleep(forTimeInterval: 0.01)
            }
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
            let key = Self.nativeKey(request.key!, additional: request.modifiers)!
            let needsEditor = (key.flags.contains(.maskCommand) && ![CGKeyCode(0), 8].contains(key.code))
                || key.flags.contains(.maskControl)
                || (key.flags.contains(.maskAlternate) && [CGKeyCode(123), 124, 125, 126].contains(key.code))
            let focused = try focusedPageElement(context, editable: needsEditor)
            try validateStable(context, expectedFocus: focused)
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
            move.flags = request.modifiers
            scroll.flags = request.modifiers
            scroll.location = context.mapped.point
            scroll.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            move.post(tap: .cghidEventTap)
            scroll.post(tap: .cghidEventTap)
            eventCount = 2
        default:
            throw Failure(code: "INVALID_ARGUMENTS", message: "Unknown native input action.")
        }
        var result: [String: Any] = ["action": request.action, "backend": "macOS Accessibility + CGEvent",
                                    "eventsPosted": eventCount, "pageIdentityVerified": true]
        if let modalPlan {
            result["nativeModal"] = try completeModal(modalPlan, context: context, eventCount: &eventCount)
            result["eventsPosted"] = eventCount
            return result
        }
        if request.action == "click" {
            // The delivered click may synchronously block WebKit with a real
            // JavaScript modal. Observe native state, never inject another read
            // into that blocked document or repeat the click.
            // Safari presents its modal after dispatch and the sheet animation;
            // the installed build exceeded 150 ms and a subsequent DOM read
            // then blocked behind prompt(). Observe without replaying input.
            let deadline = Date().addingTimeInterval(1)
            repeat {
                let nodes = nativeNodes(context.window)
                if nodes.contains(where: { string($0, kAXIdentifierAttribute) == "AXSafariModalDialog" }) {
                    result["dialogOpen"] = true; break
                }
                if nodes.contains(where: { string($0, kAXIdentifierAttribute) == "open-panel" }) {
                    result["fileChooserOpen"] = true; break
                }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
        }
        return result
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

    private func validateStable(_ context: Context, expectedFocus: AXUIElement? = nil,
                                postedButton: CGMouseButton? = nil, postedModifiers: CGEventFlags = []) throws {
        try requireCurrentAuthorization()
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
        let allowedNames = InputState(flags: postedModifiers, leftMouseDown: false, rightMouseDown: false).heldModifiers
        let unexpectedInput = input.heldModifiers.contains { !allowedNames.contains($0) }
            || (input.leftMouseDown && postedButton != .left) || (input.rightMouseDown && postedButton != .right)
            || (input.middleMouseDown && postedButton != .center)
        guard !unexpectedInput else {
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

    private static func mouseTypes(_ button: CGMouseButton) -> (down: CGEventType, up: CGEventType, drag: CGEventType) {
        switch button {
        case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
        case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
        default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
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

    private func postKey(source: CGEventSource, code: CGKeyCode, flags: CGEventFlags, didPost: () -> Void = {}) throws {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not create native keyboard events.")
        }
        down.flags = flags
        up.flags = []
        down.post(tap: .cghidEventTap)
        didPost()
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

    private func nativeNodes(_ root: AXUIElement) -> [AXUIElement] {
        var result = [AXUIElement](), pending = [(root, 0)], index = 0
        while index < pending.count, index < 2048 {
            let (node, depth) = pending[index]; index += 1
            result.append(node)
            if string(node, kAXRoleAttribute) == "AXWebArea" { continue }
            guard depth < 24 else { continue }
            // Safari exposes attached native panels through AXSheets as well
            // as AXChildren. A modal need not occur in both collections.
            let children = (attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [])
                + (attribute(node, "AXSheets") as? [AXUIElement] ?? [])
            for child in children.prefix(max(0, 2048 - pending.count)) {
                if !pending.contains(where: { CFEqual($0.0, child) }) { pending.append((child, depth + 1)) }
            }
        }
        return result
    }

    private func verifiedDialog(_ window: AXUIElement, target: Target) throws -> AXUIElement? {
        let nodes = nativeNodes(window)
        let dialogs = nodes.filter { string($0, kAXIdentifierAttribute) == "AXSafariModalDialog" }
        guard !dialogs.isEmpty else { return nil }
        guard dialogs.count == 1, let dialog = dialogs.first,
              var origin = URLComponents(string: target.expectedURL) else {
            throw Failure(code: "DIALOG_IDENTITY_CHANGED", message: "Safari did not expose one exact JavaScript dialog.")
        }
        origin.path = ""; origin.query = nil; origin.fragment = nil
        let originString = origin.string ?? ""
        // The Safari-authored origin header is a direct static-text child.
        // Never treat the dialog's own value, message subtree, or prompt field
        // as origin evidence: those values are controlled by the webpage.
        let headers = (attribute(dialog, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter {
            string($0, kAXRoleAttribute) == kAXStaticTextRole && string($0, kAXIdentifierAttribute) != "SFDialogViewMessageText"
        }.compactMap { string($0, kAXValueAttribute) ?? string($0, kAXDescriptionAttribute) }
        let address = nodes.first { string($0, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }
            .flatMap { string($0, kAXValueAttribute) }
        var noScheme = URLComponents(string: target.expectedURL)!
        noScheme.scheme = nil
        let displayed = String((noScheme.string ?? "").dropFirst(2)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let observed = address?.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !originString.isEmpty, headers.count == 1, Self.dialogHeaderMatchesOrigin(headers[0], expectedURL: target.expectedURL),
              address == target.expectedURL || observed == displayed else {
            throw Failure(code: "DIALOG_IDENTITY_CHANGED", message: "The JavaScript dialog's origin or selected page no longer matches the requested tab.")
        }
        return dialog
    }

    static func dialogHeaderMatchesOrigin(_ header: String, expectedURL: String) -> Bool {
        guard var origin = URLComponents(string: expectedURL), ["http", "https"].contains(origin.scheme ?? ""),
              origin.host?.isEmpty == false, origin.user == nil, origin.password == nil else { return false }
        origin.path = ""; origin.query = nil; origin.fragment = nil
        guard let value = origin.string else { return false }
        let escaped = NSRegularExpression.escapedPattern(for: value)
        return header.range(of: "(^|[\\s「“\"'])" + escaped + "($|[\\s」”\"'：])", options: .regularExpression) != nil
    }

    private func dialogWindow(_ target: Target, expectedWindow: AXUIElement? = nil) throws -> AXUIElement {
        try requireCurrentAuthorization()
        try requireUnlockedSession()
        guard AXIsProcessTrusted(), let front = frontmostApplication(), Self.isAppleSafari(front),
              focusedApplicationPID() == front.processIdentifier else {
            throw Failure(code: "SAFARI_NOT_FRONTMOST", message: "Safari must remain frontmost while handling its JavaScript dialog.")
        }
        let app = AXUIElementCreateApplication(front.processIdentifier)
        guard !inputState(.combinedSessionState).active else {
            throw Failure(code: "USER_INPUT_ACTIVE", message: "Release held modifier keys and mouse buttons before handling Safari dialogs.")
        }
        guard let focused = element(app, kAXFocusedWindowAttribute) else {
            throw Failure(code: "WINDOW_CHANGED", message: "The JavaScript dialog belongs to a different Safari window.")
        }
        // An attached upload sheet can itself be AXFocusedWindow and has
        // different bounds. Resolve only its exact native source ancestor;
        // completeModal still compares that source with the opening-click
        // window object before permitting any response or file selection.
        var candidates = expectedWindow.map { [$0] } ?? [focused]
        if expectedWindow == nil {
            for candidate in (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).prefix(64)
                where !candidates.contains(where: { CFEqual($0, candidate) }) { candidates.append(candidate) }
        }
        let matches = candidates.filter { candidate in
            frame(candidate).map { Self.close($0, target.windowBounds, tolerance: 8) } == true
                && SafariFileChooser.focusedModalBelongsToSource(focused, source: candidate)
        }
        guard matches.count == 1, let window = matches.first else {
            throw Failure(code: "WINDOW_CHANGED", message: "The native modal does not retain the exact focused source Safari window.")
        }
        return window
    }

    static func dialogResponseButtonIndex(operation: String, type: String, buttonCount: Int,
                                          defaultIndices: [Int], cancelIndices: [Int], enabled: Set<Int>, pressable: Set<Int>) throws -> Int {
        guard ["accept", "dismiss"].contains(operation), ["alert", "confirm", "prompt"].contains(type),
              type == "alert" ? buttonCount == 1 : buttonCount == 2 else {
            throw Failure(code: "DIALOG_RESPONSE_UNVERIFIABLE", message: "Safari did not expose the exact native response-button structure.")
        }
        let selected: Int
        if type == "alert" {
            guard defaultIndices.allSatisfy({ $0 == 0 }), cancelIndices.allSatisfy({ $0 == 0 }) else {
                throw Failure(code: "DIALOG_RESPONSE_UNVERIFIABLE", message: "Safari's native alert-button identity was inconsistent.")
            }
            selected = 0
        } else {
            guard let primary = defaultIndices.first, let cancel = cancelIndices.first,
                  (0..<buttonCount).contains(primary), (0..<buttonCount).contains(cancel), primary != cancel,
                  defaultIndices.allSatisfy({ $0 == primary }), cancelIndices.allSatisfy({ $0 == cancel }) else {
                throw Failure(code: "DIALOG_RESPONSE_UNVERIFIABLE", message: "Safari did not identify distinct default and cancel buttons inside this exact native dialog.")
            }
            selected = operation == "accept" ? primary : cancel
        }
        guard enabled.contains(selected), pressable.contains(selected) else {
            throw Failure(code: "DIALOG_RESPONSE_UNAVAILABLE", message: "The exact native response button is not enabled or does not support AXPress.")
        }
        return selected
    }

    private func dialogResponseButton(_ dialog: AXUIElement, window: AXUIElement, operation: String, type: String) throws -> AXUIElement {
        let buttons = (attribute(dialog, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter { string($0, kAXRoleAttribute) == kAXButtonRole }
        let allButtons = nativeNodes(dialog).filter { string($0, kAXRoleAttribute) == kAXButtonRole }
        guard allButtons.count == buttons.count else {
            throw Failure(code: "DIALOG_RESPONSE_UNVERIFIABLE", message: "The native dialog contains an unexpected nested response control.")
        }
        func indices(_ name: String) -> [Int] {
            [dialog, window].compactMap { element($0, name) }.map { value in buttons.firstIndex(where: { CFEqual($0, value) }) ?? -1 }
        }
        let enabled = Set(buttons.indices.filter { bool(buttons[$0], kAXEnabledAttribute) == true })
        let pressable = Set(buttons.indices.filter { index in
            var actions: CFArray?
            return AXUIElementCopyActionNames(buttons[index], &actions) == .success && (actions as? [String])?.contains(kAXPressAction) == true
        })
        let index = try Self.dialogResponseButtonIndex(operation: operation, type: type, buttonCount: buttons.count,
            defaultIndices: indices(kAXDefaultButtonAttribute), cancelIndices: indices(kAXCancelButtonAttribute), enabled: enabled, pressable: pressable)
        return buttons[index]
    }

    private func requireCurrentAuthorization() throws {
        guard currentAuthorization.map({ Self.onMain($0) }) ?? true else {
            throw Failure(code: "STALE_OPERATION", message: "The Safari command expired or its owner changed. No further input was delivered.")
        }
    }

    private func selectOptions(_ context: Context, eventCount: inout Int) throws {
        try validateStable(context)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(context.app, Float(context.mapped.point.x), Float(context.mapped.point.y), &hit) == .success else {
            throw Failure(code: "TARGET_OBSCURED", message: "Safari did not expose the selected form control.")
        }
        var candidate = hit
        var control: AXUIElement?
        for _ in 0..<12 {
            guard let node = candidate, isDescendant(node, of: context.webArea) else { break }
            if [kAXPopUpButtonRole, kAXListRole].contains(string(node, kAXRoleAttribute) ?? "") { control = node; break }
            candidate = element(node, kAXParentAttribute)
        }
        guard let control else { throw Failure(code: "SELECT_UNAVAILABLE", message: "The target is not an accessible native select control.") }
        if context.request.multiple {
            let children = attribute(control, kAXChildrenAttribute) as? [AXUIElement] ?? []
            var settable = DarwinBoolean(false)
            guard string(control, kAXRoleAttribute) == kAXListRole,
                  AXUIElementIsAttributeSettable(control, kAXSelectedChildrenAttribute as CFString, &settable) == .success,
                  settable.boolValue else {
                throw Failure(code: "SELECT_UNAVAILABLE", message: "Safari did not expose native multiple-selection control for this element.")
            }
            let targets = try context.request.options.map { option -> AXUIElement in
                guard children.indices.contains(option.index),
                      option.label == (string(children[option.index], kAXTitleAttribute) ?? string(children[option.index], kAXValueAttribute)),
                      attribute(children[option.index], kAXEnabledAttribute) as? Bool != false else {
                    throw Failure(code: "SELECT_OPTIONS_CHANGED", message: "The native options no longer match the observed page options.")
                }
                return children[option.index]
            }
            try validateStable(context)
            guard AXUIElementSetAttributeValue(control, kAXSelectedChildrenAttribute as CFString, targets as CFArray) == .success else {
                throw Failure(code: "SELECT_FAILED", message: "Safari rejected the native option selection.")
            }
            eventCount += 1
            return
        }
        guard string(control, kAXRoleAttribute) == kAXPopUpButtonRole,
              AXUIElementPerformAction(control, kAXPressAction as CFString) == .success else {
            throw Failure(code: "SELECT_UNAVAILABLE", message: "Safari could not open that native select menu.")
        }
        eventCount += 1
        var menu: AXUIElement?
        let deadline = Date().addingTimeInterval(0.6)
        repeat {
            try validateStable(context)
            let menus = nativeNodes(context.window).filter { string($0, kAXRoleAttribute) == kAXMenuRole }
            if menus.count == 1 { menu = menus[0]; break }
            Thread.sleep(forTimeInterval: 0.015)
        } while Date() < deadline
        guard let menu else { throw Failure(code: "SELECT_MENU_UNAVAILABLE", message: "The select menu opened without an exact native identity. No option was selected.") }
        var committed = false
        defer {
            if !committed, frontmostApplication()?.processIdentifier == context.pid,
               let focused = element(context.app, kAXFocusedWindowAttribute), CFEqual(focused, context.window),
               nativeNodes(context.window).contains(where: { CFEqual($0, menu) }) {
                _ = AXUIElementPerformAction(menu, kAXCancelAction as CFString)
            }
        }
        let items = (attribute(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []).filter { string($0, kAXRoleAttribute) == kAXMenuItemRole }
        let option = context.request.options[0]
        guard items.indices.contains(option.index),
              (string(items[option.index], kAXTitleAttribute) ?? string(items[option.index], kAXValueAttribute)) == option.label,
              attribute(items[option.index], kAXEnabledAttribute) as? Bool != false else {
            throw Failure(code: "SELECT_OPTIONS_CHANGED", message: "The native menu no longer matches the observed option index and label.")
        }
        try validateStable(context)
        guard AXUIElementPerformAction(items[option.index], kAXPressAction as CFString) == .success else {
            throw Failure(code: "SELECT_FAILED", message: "Safari rejected the selected native menu option.")
        }
        eventCount += 1
        committed = true
    }

    /// Safari suspends its extension callback loop while a native modal is open.
    /// Observe and consume the explicit response in the app before replying to
    /// the opening click, without a later JS round trip or a repeated click.
    private func completeModal(_ plan: ModalPlan, context: Context, eventCount: inout Int) throws -> [String: Any] {
        let base: [String: Any] = ["expectedUrl": context.request.expectedURL,
                                  "windowBounds": Self.boundsData(context.request.windowBounds)]
        let target = try Target(base)
        let deadline = Date().addingTimeInterval(plan.timeout)
        let originalAuthorization = currentAuthorization
        currentAuthorization = { Date() < deadline && (originalAuthorization?() ?? true) }
        defer { currentAuthorization = originalAuthorization }
        // Wait only for our already-posted mouse-up to reach the native queue;
        // this is not a retry or a substitute for observing the actual modal.
        Thread.sleep(forTimeInterval: 0.05)
        repeat {
            if Date() >= deadline { break }
            try requireCurrentAuthorization()
            let window = try dialogWindow(target, expectedWindow: context.window)
            guard CFEqual(window, context.window), focusedApplicationPID() == context.pid else {
                throw Failure(code: "WINDOW_CHANGED", message: "The native modal's original Safari window changed after its delivered click.")
            }
            let dialog = try verifiedDialog(window, target: target)
            let panels = nativeNodes(window).filter { string($0, kAXIdentifierAttribute) == "open-panel" }
            if let dialog {
                guard plan.kind == "dialog", panels.isEmpty else {
                    throw Failure(code: "NATIVE_MODAL_MISMATCH", message: "Safari opened a JavaScript dialog instead of the explicitly approved upload. Nothing was dismissed or uploaded.")
                }
                let inspected = try handleDialog(base.merging(["operation": "inspect"]) { _, new in new })
                guard let observed = inspected["dialog"] as? [String: Any],
                      let id = observed["id"] as? String, let type = observed["type"] as? String,
                      let message = nativeNodes(dialog).first(where: { string($0, kAXIdentifierAttribute) == "SFDialogViewMessageText" })
                        .flatMap({ string($0, kAXValueAttribute) }), plan.matches(type: type, message: message) else {
                    dialogLease = nil
                    throw Failure(code: "NATIVE_MODAL_MISMATCH", message: "The actual JavaScript dialog type or exact message differs from the preregistered response. The dialog was left open; no response was guessed.")
                }
                guard let still = try verifiedDialog(window, target: target), CFEqual(still, dialog) else {
                    throw Failure(code: "STALE_DIALOG", message: "The preregistered dialog changed before its one-time response.")
                }
                var response = base.merging(["operation": plan.accept! ? "accept" : "dismiss", "dialogId": id]) { _, new in new }
                if let prompt = plan.promptText { response["promptText"] = prompt }
                do { _ = try handleDialog(response) }
                catch var failure as Failure { failure.eventsPosted += eventCount; throw failure }
                eventCount += 1
                return ["kind": "dialog", "type": type, "message": message, "accepted": plan.accept!,
                        "promptTextApplied": plan.promptText != nil, "responseVerified": true, "done": true]
            }
            if !panels.isEmpty {
                guard plan.kind == "upload", panels.count == 1 else {
                    throw Failure(code: "NATIVE_MODAL_MISMATCH", message: "Safari opened a file chooser instead of the exact preregistered JavaScript dialog. No file was chosen and the panel was left open.")
                }
                do {
                    guard try SafariFileChooser.files(plan.policy["files"], multiple: plan.multiple) == plan.files else {
                        throw Failure(code: "UPLOAD_FILE_CHANGED", message: "An approved local file changed identity after the opening click. Nothing was uploaded.")
                    }
                    var command = base.merging(["action": "fileChooser", "operation": "inspect", "isMultiple": plan.multiple,
                                                "scope": plan.scope.filter { $0.key != "accountScope" }]) { _, new in new }
                    let authorized = { (try? self.requireCurrentAuthorization()) != nil && Date() < deadline }
                    let inspected = try armedFileChooser.perform(command, authorized: authorized)
                    guard let chooser = inspected["fileChooser"] as? [String: Any], let id = chooser["id"] as? String else {
                        throw Failure(code: "FILE_CHOOSER_UNVERIFIABLE", message: "The approved source input did not retain an exact native file chooser.")
                    }
                    command["operation"] = "setFiles"; command["chooserId"] = id; command["files"] = plan.policy["files"]
                    _ = try armedFileChooser.perform(command, authorized: authorized)
                    return ["kind": "upload", "done": true, "fileCount": plan.files.count, "responseVerified": true]
                } catch let failure as SafariFileChooser.Failure {
                    throw Failure(code: failure.code, message: failure.message, eventsPosted: eventCount,
                                  details: ["mutationApplied": failure.mutationApplied, "doNotReplay": true])
                }
            }
            Thread.sleep(forTimeInterval: 0.025)
        } while Date() < deadline
        throw Failure(code: "NATIVE_MODAL_TIMEOUT", message: "The delivered click did not produce its exact preregistered native modal before the deadline. No response, automatic dismissal, or input replay was performed.")
    }

    private func handleDialog(_ command: [String: Any]) throws -> [String: Any] {
        let target = try Target(command)
        let window = try dialogWindow(target)
        guard let operation = command["operation"] as? String, ["inspect", "accept", "dismiss"].contains(operation) else {
            throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a JavaScript dialog inspection or response.")
        }
        guard let dialog = try verifiedDialog(window, target: target) else {
            dialogLease = nil
            guard topLevelWebAreas(window).filter({ pageURL($0) == target.expectedURL }).count == 1 else {
                throw Failure(code: "PAGE_CHANGED", message: "The requested page is not selected in Safari.")
            }
            if operation == "inspect" { return ["dialog": NSNull()] }
            throw Failure(code: "DIALOG_CLOSED", message: "That JavaScript dialog already closed. No response was repeated.")
        }
        let nodes = nativeNodes(dialog)
        let fields = nodes.filter { string($0, kAXRoleAttribute) == kAXTextFieldRole }
        let buttons = nodes.filter { string($0, kAXRoleAttribute) == kAXButtonRole }
        guard fields.count <= 1, (1...2).contains(buttons.count),
              let message = nodes.first(where: { string($0, kAXIdentifierAttribute) == "SFDialogViewMessageText" })
                .flatMap({ string($0, kAXValueAttribute) }) else {
            throw Failure(code: "DIALOG_UNSUPPORTED", message: "Safari did not expose a recognized JavaScript alert, confirm, or prompt.")
        }
        let type = fields.isEmpty ? (buttons.count == 1 ? "alert" : "confirm") : "prompt"
        if operation == "inspect" {
            if dialogLease.map({ !CFEqual($0.node, dialog) || !CFEqual($0.window, window) || $0.url != target.expectedURL }) ?? true {
                dialogLease = (UUID().uuidString, dialog, window, target.expectedURL)
            }
            var value: [String: Any] = ["id": dialogLease!.id, "type": type, "message": String(message.prefix(8000))]
            if let field = fields.first { value["defaultValue"] = string(field, kAXValueAttribute) ?? "" }
            return ["dialog": value]
        }
        guard let lease = dialogLease, command["dialogId"] as? String == lease.id,
              CFEqual(lease.node, dialog), CFEqual(lease.window, window), lease.url == target.expectedURL else {
            throw Failure(code: "STALE_DIALOG", message: "Inspect the current JavaScript dialog before responding; an earlier dialog cannot be replayed.")
        }
        let button = try dialogResponseButton(dialog, window: window, operation: operation, type: type)
        _ = try dialogWindow(target, expectedWindow: window)
        if let prompt = command["promptText"] as? String {
            guard operation == "accept", type == "prompt", prompt.utf16.count <= 20_000, let field = fields.first,
                  AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, prompt as CFString) == .success,
                  string(field, kAXValueAttribute) == prompt else {
                throw Failure(code: "DIALOG_INPUT_FAILED", message: "Safari did not accept text in that JavaScript prompt.")
            }
        }
        _ = try dialogWindow(target, expectedWindow: window)
        guard let current = try verifiedDialog(window, target: target), CFEqual(current, dialog),
              CFEqual(try dialogResponseButton(current, window: window, operation: operation, type: type), button) else {
            throw Failure(code: "STALE_DIALOG", message: "The JavaScript dialog changed before the response was delivered.")
        }
        dialogLease = nil
        // Setting AXValue does not establish the prompt field's keyboard
        // responder. Press Safari's exact native semantic button once instead
        // of assuming Return reaches that responder. No key/click fallback or
        // replay is allowed after an uncertain native response.
        guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else {
            throw Failure(code: "DIALOG_RESPONSE_UNCERTAIN", message: "Safari did not confirm its one-time native dialog button action. Inspect current state; do not repeat it.", eventsPosted: 1,
                          details: ["mutationApplied": true, "doNotReplay": true])
        }
        let deadline = Date().addingTimeInterval(1)
        do {
            repeat {
                _ = try dialogWindow(target, expectedWindow: window)
                if !nativeNodes(window).contains(where: { string($0, kAXIdentifierAttribute) == "AXSafariModalDialog" && CFEqual($0, dialog) }) {
                    return ["done": true, "eventsPosted": 1, "nativeResponse": "AXPress"]
                }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
        } catch {
            throw Failure(code: "DIALOG_OUTCOME_UNCONFIRMED", message: "The native dialog button was pressed, but its exact source window or foreground changed before closure was confirmed. Inspect current state; do not repeat it.", eventsPosted: 1,
                          details: ["mutationApplied": true, "doNotReplay": true])
        }
        throw Failure(code: "DIALOG_OUTCOME_UNCONFIRMED", message: "The native dialog button response was delivered but closure was not confirmed. Inspect current state; do not repeat it.", eventsPosted: 1,
                      details: ["mutationApplied": true, "doNotReplay": true])
    }

    /// Observes a late modal after a delivered input blocked DOM readback.
    /// Never activates a window, posts input, or infers a modal from a timeout.
    private func modalStatus(_ command: [String: Any]) throws -> [String: Any] {
        let target = try Target(command)
        let window = try dialogWindow(target)
        if try verifiedDialog(window, target: target) != nil {
            return ["dialogOpen": true, "fileChooserOpen": false]
        }
        let nodes = nativeNodes(window)
        let address = nodes.first { string($0, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }
            .flatMap { string($0, kAXValueAttribute) }
        guard let address, SafariFileChooser.matchesPageAddress(address, expected: target.expectedURL) else {
            throw Failure(code: "PAGE_CHANGED", message: "The delivered input's selected page changed before modal observation.")
        }
        let panels = nodes.filter { string($0, kAXIdentifierAttribute) == "open-panel" }
        guard panels.count <= 1 else {
            throw Failure(code: "FILE_CHOOSER_UNVERIFIABLE", message: "Safari exposed more than one native upload panel.")
        }
        return ["dialogOpen": false, "fileChooserOpen": panels.count == 1]
    }
}
