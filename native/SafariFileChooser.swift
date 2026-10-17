import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security

/// Chooses explicit local files in an already-open, source-bound Safari panel.
/// The broker must admit inspect only from its delivered-click modal lease. The
/// DOM input's multiple flag is evidence supplied by that lease, not inferred
/// from the native panel. This helper never reads file contents or page cookies.
final class SafariFileChooser {
    struct Failure: Error {
        let code: String
        let message: String
        var mutationApplied = false
        var doNotReplay = false
    }

    struct Scope: Equatable {
        let values: [String: String]
        init(_ raw: Any?) throws {
            let keys: Set<String> = ["profileId", "tabId", "documentId", "node", "ownerId", "sessionId", "turnId"]
            guard let value = raw as? [String: String], Set(value.keys) == keys,
                  value.values.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 && !$0.contains("\0") }),
                  let id = Int(value["tabId"]!), id > 0, String(id) == value["tabId"] else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "A file chooser requires the exact profile, tab, document, input, owner, session, and turn scope.")
            }
            values = value
        }
    }

    struct Target: Equatable {
        let url: String
        let bounds: CGRect
        let scope: Scope
        let isMultiple: Bool
        init(_ command: [String: Any]) throws {
            guard let url = command["expectedUrl"] as? String, let parsed = URLComponents(string: url),
                  ["http", "https"].contains(parsed.scheme?.lowercased() ?? ""),
                  parsed.host?.isEmpty == false, parsed.user == nil, parsed.password == nil, parsed.url != nil,
                  let bounds = command["windowBounds"] as? [String: Any],
                  let x = Self.number(bounds["left"]), let y = Self.number(bounds["top"]),
                  let width = Self.number(bounds["width"]), let height = Self.number(bounds["height"]),
                  abs(x) <= 100_000, abs(y) <= 100_000, width > 0, height > 0, width <= 100_000, height <= 100_000,
                  let multiple = command["isMultiple"] as? NSNumber, CFGetTypeID(multiple) == CFBooleanGetTypeID() else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "A file chooser needs its observed HTTP(S) page, native window bounds, and DOM input multiple flag.")
            }
            self.url = url; self.bounds = CGRect(x: x, y: y, width: width, height: height)
            scope = try Scope(command["scope"]); isMultiple = multiple.boolValue
        }
        private static func number(_ raw: Any?) -> Double? {
            guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
            return value.doubleValue
        }
    }

    struct LocalFile: Equatable {
        let path: String
        let device: UInt64
        let inode: UInt64
        init(_ raw: String) throws {
            guard raw.hasPrefix("/"), !raw.contains("\0"), raw.utf16.count <= 4096 else {
                throw Failure(code: "INVALID_FILES", message: "Uploads require explicit absolute local file paths without null characters.")
            }
            let url = URL(fileURLWithPath: raw).standardizedFileURL.resolvingSymlinksInPath()
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                  attributes[.type] as? FileAttributeType == .typeRegular,
                  let device = attributes[.systemNumber] as? NSNumber,
                  let inode = attributes[.systemFileNumber] as? NSNumber,
                  (try? url.resourceValues(forKeys: [.isAliasFileKey]).isAliasFile) != true else {
                throw Failure(code: "INVALID_FILES", message: "Every upload path must identify an existing regular local file, not a folder, device, or Finder alias.")
            }
            path = url.path; self.device = device.uint64Value; self.inode = inode.uint64Value
        }
    }

    struct Observation: Equatable { let window: String; let panel: String }
    protocol Driver {
        func observe(_ target: Target, authorized: () -> Bool) throws -> Observation?
        func choose(_ files: [LocalFile], target: Target, observed: Observation, authorized: () -> Bool) throws
        func cancel(_ target: Target, observed: Observation, authorized: () -> Bool) throws
    }
    private struct Lease { let id: String; let target: Target; let observed: Observation }
    private let driver: Driver
    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.file-chooser")
    private var lease: Lease?

    init(driver: Driver? = nil) { self.driver = driver ?? NativeDriver() }

    static func matchesPageAddress(_ observed: String, expected: String) -> Bool {
        let withoutScheme = expected.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression)
        return observed == expected || observed.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == withoutScheme.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func nativeChildren(_ children: [AXUIElement], sheets: [AXUIElement], visited: [AXUIElement]) -> [AXUIElement] {
        var result: [AXUIElement] = []
        for node in children + sheets where !visited.contains(where: { CFEqual($0, node) }) && !result.contains(where: { CFEqual($0, node) }) {
            result.append(node)
        }
        return result
    }

    static func files(_ raw: Any?, multiple: Bool) throws -> [LocalFile] {
        guard let paths = raw as? [String], !paths.isEmpty, paths.count <= 128, multiple || paths.count == 1 else {
            throw Failure(code: "INVALID_FILES", message: "Choose at least one file; multiple files require the observed input's multiple attribute (maximum 128 files).")
        }
        let files = try paths.map(LocalFile.init)
        guard Set(files.map(\.path)).count == files.count else { throw Failure(code: "INVALID_FILES", message: "Upload paths must identify distinct files.") }
        guard Set(files.map { URL(fileURLWithPath: $0.path).deletingLastPathComponent().path }).count == 1 else {
            throw Failure(code: "FILE_CHOOSER_UNSUPPORTED", message: "Native multi-file selection requires files in one directory. Files from different directories were not selected.")
        }
        return files
    }

    func handle(_ command: [String: Any], isAuthorized: @escaping () -> Bool, reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            let authorized = { Thread.isMainThread ? isAuthorized() : DispatchQueue.main.sync(execute: isAuthorized) }
            do { reply(["ok": true, "result": try perform(command, authorized: authorized)]) }
            catch let error as Failure {
                reply(["ok": false, "error": ["code": error.code, "message": error.message,
                    "mutationApplied": error.mutationApplied, "doNotReplay": error.doNotReplay]])
            } catch { reply(["ok": false, "error": ["code": "FILE_CHOOSER_FAILED", "message": "The native file chooser could not complete the operation."]]) }
        }
    }

    // Synchronous protocol entry for the serial native queue and non-UI tests.
    func perform(_ command: [String: Any], authorized: () -> Bool) throws -> [String: Any] {
        guard authorized() else { lease = nil; throw Failure(code: "STALE_OPERATION", message: "The file chooser owner or operation ended.") }
        guard command["action"] as? String == "fileChooser", let operation = command["operation"] as? String,
              ["inspect", "setFiles", "cancel"].contains(operation) else { throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a file chooser inspection, explicit file selection, or cancellation.") }
        let target = try Target(command)
        guard let observed = try driver.observe(target, authorized: authorized) else {
            lease = nil
            if operation == "inspect" { return ["fileChooser": NSNull()] }
            throw Failure(code: "FILE_CHOOSER_CLOSED", message: "The file chooser already closed. No selection was repeated.")
        }
        if operation == "inspect" {
            if let previous = lease, previous.target != target || previous.observed != observed {
                lease = nil
                throw Failure(code: "STALE_FILE_CHOOSER", message: "The open file chooser no longer has the same source document, input, owner, or native panel.")
            }
            if lease == nil { lease = Lease(id: UUID().uuidString, target: target, observed: observed) }
            return ["fileChooser": ["id": lease!.id, "isMultiple": target.isMultiple]]
        }
        guard let current = lease, command["chooserId"] as? String == current.id,
              current.target == target, current.observed == observed else {
            throw Failure(code: "STALE_FILE_CHOOSER", message: "Inspect this source-bound native file chooser before responding. An earlier chooser cannot be reused.")
        }
        guard authorized() else { lease = nil; throw Failure(code: "STALE_OPERATION", message: "The file chooser owner changed before native selection.") }
        if operation == "cancel" {
            lease = nil
            try driver.cancel(target, observed: observed, authorized: authorized)
        } else {
            let files = try Self.files(command["files"], multiple: target.isMultiple)
            // Consume before any native mutation: an uncertain response must not
            // allow replaying Upload against this or a later panel.
            lease = nil
            try driver.choose(files, target: target, observed: observed, authorized: authorized)
        }
        guard authorized() else { throw Failure(code: "STALE_OPERATION", message: "The upload response belongs to an ended owner. Check the page before continuing.", mutationApplied: true, doNotReplay: true) }
        return ["done": true]
    }

    private final class NativeDriver: Driver {
        private struct Context { let pid: pid_t; let app: AXUIElement; let window: AXUIElement; let panel: AXUIElement }
        private var identities: [(node: AXUIElement, id: String)] = []

        init() { Self.onMain { _ = NSWorkspace.shared.runningApplications } }
        private static func onMain<T>(_ body: () -> T) -> T { Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body) }
        private func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
            var result: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, name as CFString, &result) == .success else { return nil }
            return result
        }
        private func string(_ node: AXUIElement, _ name: String) -> String? { attribute(node, name) as? String }
        private func element(_ node: AXUIElement, _ name: String) -> AXUIElement? {
            guard let value = attribute(node, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            return (value as! AXUIElement)
        }
        private func nodes(_ root: AXUIElement) throws -> [AXUIElement] {
            var pending = [(root, 0)], index = 0
            while index < pending.count {
                let (node, depth) = pending[index]; index += 1
                if string(node, kAXRoleAttribute) == "AXWebArea" { continue }
                // Safari's attached open/Go-to panels can be exposed through
                // AXSheets without appearing in AXChildren. Traverse both
                // public edges once; shared edges and cycles are not new nodes.
                let children = SafariFileChooser.nativeChildren(attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [],
                    sheets: attribute(node, "AXSheets") as? [AXUIElement] ?? [], visited: pending.map(\.0))
                guard pending.count + children.count <= 8192, depth < 32 || children.isEmpty else {
                    throw Failure(code: "FILE_CHOOSER_UNVERIFIABLE", message: "The native file chooser tree exceeded its identity bounds.")
                }
                pending += children.map { ($0, depth + 1) }
            }
            return pending.map(\.0)
        }
        private func identity(_ node: AXUIElement) -> String {
            if let prior = identities.first(where: { CFEqual($0.node, node) }) { return prior.id }
            let id = UUID().uuidString
            if identities.count >= 16 { identities.removeFirst() }
            identities.append((node, id)); return id
        }
        private func bounds(_ node: AXUIElement) -> CGRect? {
            guard let p = attribute(node, kAXPositionAttribute), let s = attribute(node, kAXSizeAttribute),
                  CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
            return CGRect(origin: point, size: size)
        }
        private func sameBounds(_ a: CGRect, _ b: CGRect) -> Bool {
            abs(a.minX - b.minX) <= 8 && abs(a.minY - b.minY) <= 8 && abs(a.width - b.width) <= 8 && abs(a.height - b.height) <= 8
        }
        private func guardFront(_ authorized: () -> Bool) throws -> (pid_t, AXUIElement) {
            guard authorized() else { throw Failure(code: "STALE_OPERATION", message: "The file chooser owner or native operation ended.") }
            guard (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool != true,
                  AXIsProcessTrusted() else { throw Failure(code: "ACCESSIBILITY_REQUIRED", message: "An unlocked session and existing Accessibility permission are required for Safari file selection.") }
            guard let front = Self.onMain({ NSWorkspace.shared.frontmostApplication }), front.bundleIdentifier == "com.apple.Safari", !front.isTerminated else {
                throw Failure(code: "SAFARI_NOT_FRONTMOST", message: "Safari must remain frontmost while selecting upload files.")
            }
            var code: SecCode?, requirement: SecRequirement?
            guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: front.processIdentifier] as CFDictionary, [], &code) == errSecSuccess,
                  SecRequirementCreateWithString("anchor apple and identifier \"com.apple.Safari\"" as CFString, [], &requirement) == errSecSuccess,
                  let code, let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
                throw Failure(code: "SAFARI_IDENTITY_CHANGED", message: "The foreground process is not the signature-verified Apple Safari.")
            }
            var focusedPID: pid_t = 0
            guard let focusedApp = element(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute),
                  AXUIElementGetPid(focusedApp, &focusedPID) == .success, focusedPID == front.processIdentifier else {
                throw Failure(code: "SAFARI_NOT_FRONTMOST", message: "The native focused application changed during file selection.")
            }
            let flags = CGEventSource.flagsState(.combinedSessionState)
            guard flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty,
                  !CGEventSource.buttonState(.combinedSessionState, button: .left),
                  !CGEventSource.buttonState(.combinedSessionState, button: .right),
                  !CGEventSource.buttonState(.combinedSessionState, button: .center) else {
                throw Failure(code: "USER_INPUT_ACTIVE", message: "Native upload selection stopped because a modifier key or mouse button is held.")
            }
            let app = AXUIElementCreateApplication(focusedPID)
            AXUIElementSetMessagingTimeout(app, 0.5)
            return (focusedPID, app)
        }
        private func window(_ target: Target, authorized: () -> Bool) throws -> (pid_t, AXUIElement, AXUIElement) {
            let (pid, app) = try guardFront(authorized)
            let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
            // Safari may expose two different windows with identical geometry.
            // Establish each candidate's selected address before requiring one
            // unique source; bounds alone cannot identify the upload window.
            let matching = try windows.filter { candidate in
                guard bounds(candidate).map({ sameBounds($0, target.bounds) }) == true else { return false }
                let addresses = try nodes(candidate).filter { string($0, kAXIdentifierAttribute) == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }
                    .compactMap { string($0, kAXValueAttribute) }
                return addresses.count == 1 && SafariFileChooser.matchesPageAddress(addresses[0], expected: target.url)
            }
            guard matching.count == 1, let window = matching.first, let focused = element(app, kAXFocusedWindowAttribute), CFEqual(window, focused) else {
                throw Failure(code: "WINDOW_CHANGED", message: "The upload panel no longer belongs to the exact focused source Safari window.")
            }
            return (pid, app, window)
        }
        private func context(_ target: Target, expected: Observation?, authorized: () -> Bool) throws -> Context? {
            let (pid, app, window) = try window(target, authorized: authorized)
            let panels = try nodes(window).filter { string($0, kAXRoleAttribute) == kAXSheetRole && string($0, kAXIdentifierAttribute) == "open-panel" }
            guard panels.count <= 1 else { throw Failure(code: "FILE_CHOOSER_UNVERIFIABLE", message: "Safari exposed more than one upload panel.") }
            guard let panel = panels.first else { return nil }
            if let expected, expected != Observation(window: identity(window), panel: identity(panel)) {
                throw Failure(code: "STALE_FILE_CHOOSER", message: "The native upload panel or source window changed.")
            }
            return Context(pid: pid, app: app, window: window, panel: panel)
        }
        func observe(_ target: Target, authorized: () -> Bool) throws -> Observation? {
            guard let current = try context(target, expected: nil, authorized: authorized) else { return nil }
            return Observation(window: identity(current.window), panel: identity(current.panel))
        }
        private func current(_ target: Target, _ observed: Observation, _ authorized: () -> Bool) throws -> Context {
            guard let value = try context(target, expected: observed, authorized: authorized) else {
                throw Failure(code: "FILE_CHOOSER_CLOSED", message: "The native upload panel closed before selection completed.")
            }
            return value
        }
        private func button(_ identifier: String, in panel: AXUIElement) throws -> AXUIElement {
            let matches = try nodes(panel).filter { string($0, kAXRoleAttribute) == kAXButtonRole && string($0, kAXIdentifierAttribute) == identifier }
            guard matches.count == 1, let match = matches.first, attribute(match, kAXEnabledAttribute) as? Bool == true else {
                throw Failure(code: "FILE_CHOOSER_CONTROL_UNAVAILABLE", message: "The upload panel's exact enabled native control was not available.")
            }
            return match
        }
        private func key(_ code: CGKeyCode, flags: CGEventFlags = [], assertCurrent: () throws -> Void) throws {
            try assertCurrent()
            guard let source = CGEventSource(stateID: .hidSystemState), let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
                throw Failure(code: "NATIVE_INPUT_FAILED", message: "macOS could not create the upload panel's native key events.")
            }
            down.flags = flags; up.flags = []
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        }
        private func fileURLs(_ root: AXUIElement) throws -> Set<String> {
            var paths = Set<String>()
            for node in try nodes(root) {
                let raw = attribute(node, kAXURLAttribute)
                let url = (raw as? URL) ?? (raw as? String).flatMap(URL.init(string:))
                if let url, url.isFileURL { paths.insert(url.standardizedFileURL.resolvingSymlinksInPath().path) }
                if let value = string(node, "AXFilename"), value.hasPrefix("/") {
                    paths.insert(URL(fileURLWithPath: value).standardizedFileURL.resolvingSymlinksInPath().path)
                }
            }
            return paths
        }
        private func selectedPaths(_ panel: AXUIElement) throws -> Set<String> {
            var paths = Set<String>()
            for node in try nodes(panel) {
                for attributeName in [kAXSelectedChildrenAttribute, kAXSelectedRowsAttribute] {
                    if let selected = attribute(node, attributeName) as? [AXUIElement] {
                        for item in selected { paths.formUnion(try fileURLs(item)) }
                    }
                }
            }
            return paths
        }
        private func goTo(_ path: String, target: Target, observed: Observation, authorized: () -> Bool) throws {
            try key(5, flags: [.maskCommand, .maskShift]) { _ = try self.current(target, observed, authorized) }
            let deadline = Date().addingTimeInterval(2)
            var field: AXUIElement?
            repeat {
                let current = try self.current(target, observed, authorized)
                let sheets = try nodes(current.window).filter { string($0, kAXRoleAttribute) == kAXSheetRole && string($0, kAXIdentifierAttribute) == "GoToWindow" }
                if sheets.count == 1 {
                    let fields = try nodes(sheets[0]).filter { string($0, kAXIdentifierAttribute) == "PathTextField" && string($0, kAXRoleAttribute) == kAXTextFieldRole }
                    if fields.count == 1 { field = fields[0]; break }
                }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
            guard let field else { throw Failure(code: "FILE_CHOOSER_PATH_UNAVAILABLE", message: "The native Go to Folder path field did not appear. No upload was submitted.") }
            _ = try self.current(target, observed, authorized)
            guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, path as CFString) == .success,
                  string(field, kAXValueAttribute) == path else {
                throw Failure(code: "FILE_CHOOSER_PATH_REJECTED", message: "The native path field rejected the explicit local path. No upload was submitted.")
            }
            try key(36) { _ = try self.current(target, observed, authorized) }
            let closedDeadline = Date().addingTimeInterval(2)
            repeat {
                let current = try self.current(target, observed, authorized)
                if !(try nodes(current.window)).contains(where: { string($0, kAXIdentifierAttribute) == "GoToWindow" }) { return }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < closedDeadline
            throw Failure(code: "FILE_CHOOSER_PATH_UNCONFIRMED", message: "The native path navigation did not finish. No upload was submitted; inspect the open panel before continuing.")
        }
        func choose(_ files: [LocalFile], target: Target, observed: Observation, authorized: () -> Bool) throws {
            let wanted = Set(files.map(\.path))
            try goTo(files.count == 1 ? files[0].path : URL(fileURLWithPath: files[0].path).deletingLastPathComponent().path,
                     target: target, observed: observed, authorized: authorized)
            if files.count > 1 {
                let current = try self.current(target, observed, authorized)
                var candidates: [(AXUIElement, String, [AXUIElement])] = []
                for node in try nodes(current.panel) {
                    for name in [kAXSelectedChildrenAttribute, kAXSelectedRowsAttribute] {
                        var settable = DarwinBoolean(false)
                        guard AXUIElementIsAttributeSettable(node, name as CFString, &settable) == .success, settable.boolValue else { continue }
                        let children = (attribute(node, kAXRowsAttribute) as? [AXUIElement]) ?? (attribute(node, kAXChildrenAttribute) as? [AXUIElement]) ?? []
                        let rows = try files.map { file -> AXUIElement? in
                            let matches = try children.filter { try fileURLs($0) == [file.path] }
                            return matches.count == 1 ? matches.first : nil
                        }
                        if rows.allSatisfy({ $0 != nil }) { candidates.append((node, name, rows.compactMap { $0 })) }
                    }
                }
                guard let candidate = candidates.first else { throw Failure(code: "FILE_CHOOSER_SELECTION_UNVERIFIABLE", message: "The native file list did not expose exact selectable URLs for all requested files. No upload was submitted.") }
                _ = try self.current(target, observed, authorized)
                guard AXUIElementSetAttributeValue(candidate.0, candidate.1 as CFString, candidate.2 as CFArray) == .success else {
                    throw Failure(code: "FILE_CHOOSER_SELECTION_REJECTED", message: "The native file list rejected multiple-file selection. No upload was submitted.")
                }
            }
            let deadline = Date().addingTimeInterval(2)
            var selectionVerified = false
            repeat {
                let current = try self.current(target, observed, authorized)
                if try selectedPaths(current.panel) == wanted { selectionVerified = true; break }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
            guard selectionVerified else { throw Failure(code: "FILE_CHOOSER_SELECTION_UNVERIFIABLE", message: "The native panel did not prove the exact requested file selection. No upload was submitted.") }
            guard try files.allSatisfy({ try LocalFile($0.path) == $0 }) else { throw Failure(code: "FILE_CHANGED", message: "An upload path changed identity before submission. No upload was submitted.") }
            let current = try self.current(target, observed, authorized)
            let upload = try button("OKButton", in: current.panel)
            guard try selectedPaths(current.panel) == wanted else { throw Failure(code: "FILE_CHOOSER_SELECTION_CHANGED", message: "The native file selection changed before submission. No upload was submitted.") }
            _ = try self.current(target, observed, authorized)
            guard AXUIElementPerformAction(upload, kAXPressAction as CFString) == .success else {
                throw Failure(code: "FILE_CHOOSER_UPLOAD_UNCERTAIN", message: "The native Upload action did not return a confirmed result. Do not repeat it.", mutationApplied: true, doNotReplay: true)
            }
            try confirmClosed(target, observed: observed, authorized: authorized)
        }
        func cancel(_ target: Target, observed: Observation, authorized: () -> Bool) throws {
            let current = try self.current(target, observed, authorized)
            let cancel = try button("CancelButton", in: current.panel)
            _ = try self.current(target, observed, authorized)
            guard AXUIElementPerformAction(cancel, kAXPressAction as CFString) == .success else {
                throw Failure(code: "FILE_CHOOSER_CANCEL_UNCERTAIN", message: "The native Cancel action did not return a confirmed result. Do not repeat it.", mutationApplied: true, doNotReplay: true)
            }
            try confirmClosed(target, observed: observed, authorized: authorized)
        }
        private func confirmClosed(_ target: Target, observed: Observation, authorized: () -> Bool) throws {
            let deadline = Date().addingTimeInterval(2)
            do {
                repeat {
                    if try context(target, expected: observed, authorized: authorized) == nil { return }
                    Thread.sleep(forTimeInterval: 0.025)
                } while Date() < deadline
            } catch {
                throw Failure(code: "FILE_CHOOSER_OUTCOME_UNCONFIRMED", message: "The file chooser response was delivered but its source or foreground changed before closure was confirmed. Check the page; do not repeat the response.", mutationApplied: true, doNotReplay: true)
            }
            throw Failure(code: "FILE_CHOOSER_OUTCOME_UNCONFIRMED", message: "The native panel response was delivered but closure was not confirmed. Check the page; do not repeat the response.", mutationApplied: true, doNotReplay: true)
        }
    }
}
