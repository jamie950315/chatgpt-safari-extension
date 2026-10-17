import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security

/// A real, foreground Safari window resize, never CDP device emulation.
/// A retained native lease permits only rollback to the original bounds while
/// the same page/window still has our last applied bounds and native focus.
final class SafariViewport {
    struct Failure: Error {
        let code: String
        let message: String
        var mutationApplied = false
        var restoration = "not-needed"
        var observedBounds: Bounds?
    }
    struct Bounds: Equatable {
        let rect: CGRect
        init(_ raw: Any?) throws {
            guard let value = raw as? [String: Any], let x = Self.number(value["left"]),
                  let y = Self.number(value["top"]), let w = Self.number(value["width"]),
                  let h = Self.number(value["height"]), abs(x) < 100_000, abs(y) < 100_000,
                  w > 0, h > 0, w < 100_000, h < 100_000 else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Viewport requires finite observed native window bounds.")
            }
            rect = CGRect(x: x, y: y, width: w, height: h)
        }
        init(_ rect: CGRect) { self.rect = rect }
        var data: [String: Double] { ["left": rect.minX, "top": rect.minY, "width": rect.width, "height": rect.height] }
        static func number(_ raw: Any?) -> Double? {
            guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
            return n.doubleValue
        }
        func matches(_ other: Bounds) -> Bool {
            abs(rect.minX - other.rect.minX) <= 1 && abs(rect.minY - other.rect.minY) <= 1 &&
            abs(rect.width - other.rect.width) <= 1 && abs(rect.height - other.rect.height) <= 1
        }
    }
    struct Target: Equatable {
        let scope: [String: String]
        let url: String
        let bounds: Bounds
        init(_ command: [String: Any]) throws {
            let keys: Set<String> = ["profileId", "ownerId", "accountScope", "sessionId", "turnId", "tabId", "documentId"]
            guard let scope = command["scope"] as? [String: String], Set(scope.keys) == keys,
                  scope.values.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 && !$0.contains("\0") }),
                  let id = Int(scope["tabId"]!), id > 0, String(id) == scope["tabId"],
                  let url = command["expectedUrl"] as? String, let parsed = URLComponents(string: url),
                  ["https", "http"].contains(parsed.scheme?.lowercased() ?? ""), parsed.host?.isEmpty == false,
                  parsed.user == nil, parsed.password == nil, parsed.url != nil else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Viewport requires its exact owner, account, profile, turn, claimed tab, document and HTTP(S) URL.")
            }
            self.scope = scope; self.url = url; bounds = try Bounds(command["windowBounds"])
        }
        func returning(to url: String, bounds: Bounds) throws -> Target {
            try Target(["scope": scope, "expectedUrl": url, "windowBounds": bounds.data])
        }
    }
    struct Observation { let identity: String; let bounds: Bounds; let available: Bounds }
    protocol Driver {
        func begin(_ target: Target, authorized: () -> Bool) throws -> Observation
        func inspect(_ identity: String, target: Target, expected: Bounds, authorized: () -> Bool) throws -> Observation
        func resize(_ identity: String, target: Target, expected: Bounds, desired: Bounds, authorized: () -> Bool) throws -> Observation
        func forget(_ identity: String)
    }
    private struct Lease { let id: String; let target: Target; let identity: String; let original: Bounds; var applied: Bounds; var returnTarget: Target? }
    private let driver: Driver
    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.viewport")
    private var lease: Lease?
    private(set) var lastRestoration = "not-needed"
    private var lastRestorationCode: String?
    init(driver: Driver? = nil) { self.driver = driver ?? NativeDriver() }

    func handle(_ command: [String: Any], isAuthorized: @escaping () -> Bool, reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            let authorized = { Thread.isMainThread ? isAuthorized() : DispatchQueue.main.sync(execute: isAuthorized) }
            do { reply(["ok": true, "result": try perform(command, authorized: authorized)]) }
            catch let e as Failure {
                var detail: [String: Any] = ["code": e.code, "message": e.message,
                    "mutationApplied": e.mutationApplied, "doNotReplay": e.mutationApplied, "restoration": e.restoration]
                if let bounds = e.observedBounds { detail["windowBounds"] = bounds.data }
                reply(["ok": false, "error": detail])
            }
            catch { reply(["ok": false, "error": ["code": "VIEWPORT_FAILED", "message": "The native Safari viewport operation failed."]]) }
        }
    }
    func cancel(owner: String?) {
        queue.async { [self] in
            guard let current = lease, owner == nil || current.target.scope["ownerId"] == owner else { return }
            do { _ = try restore(current, authorized: { true }) }
            catch { lastRestoration = "unconfirmed"; lastRestorationCode = (error as? Failure)?.code ?? "VIEWPORT_FAILED" }
        }
    }
    func status(reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            var result: [String: Any] = ["leaseActive": lease != nil, "restoration": lastRestoration]
            if let code = lastRestorationCode { result["code"] = code }
            if let current = lease { result["originalBounds"] = current.original.data; result["lastAppliedBounds"] = current.applied.data }
            reply(result)
        }
    }
    func perform(_ command: [String: Any], authorized: () -> Bool) throws -> [String: Any] {
        guard authorized() else { throw Failure(code: "STALE_OPERATION", message: "The viewport operation or owner ended.") }
        guard let operation = command["operation"] as? String, ["begin", "check", "resize", "restore", "commitReturnPage"].contains(operation) else {
            throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a native viewport lease, check, resize or restoration.")
        }
        let target = try Target(command)
        if operation == "begin" {
            if var current = lease {
                guard current.target.scope == target.scope, current.target.url == target.url,
                      current.applied.matches(target.bounds) else {
                    throw Failure(code: "VIEWPORT_LEASE_ACTIVE", message: "Reset the existing source-bound viewport before changing its tab, document, turn, or owner.")
                }
                let observed = try driver.inspect(current.identity, target: current.target, expected: current.applied, authorized: authorized)
                current.returnTarget = nil; lease = current
                return result(current, observed)
            }
            let observed = try driver.begin(target, authorized: authorized)
            let current = Lease(id: UUID().uuidString, target: target, identity: observed.identity,
                                original: observed.bounds, applied: observed.bounds, returnTarget: nil)
            lease = current; lastRestoration = "not-needed"; lastRestorationCode = nil
            return result(current, observed)
        }
        guard var current = lease, current.id == command["leaseId"] as? String,
              current.target.scope == target.scope, current.target.url == target.url,
              current.applied.matches(target.bounds) else {
            throw Failure(code: "STALE_VIEWPORT", message: "This viewport lease no longer matches its exact owner, document, native window and last applied bounds.")
        }
        if operation == "restore" { return try restore(current, authorized: authorized) }
        if operation == "commitReturnPage" {
            guard let url = command["returnUrl"] as? String else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "A viewport return page requires the completed original owner-selection proof.")
            }
            let returned = try current.target.returning(to: url, bounds: current.applied)
            do { _ = try driver.inspect(current.identity, target: returned, expected: current.applied, authorized: authorized) }
            catch { lastRestoration = "unconfirmed"; lastRestorationCode = (error as? Failure)?.code ?? "VIEWPORT_FAILED"; throw error }
            current.returnTarget = returned; lease = current
            return ["committed": true, "windowBounds": current.applied.data]
        }
        if operation == "check" {
            return result(current, try driver.inspect(current.identity, target: current.target, expected: current.applied, authorized: authorized))
        }
        guard let width = Bounds.number(command["width"]), let height = Bounds.number(command["height"]),
              width.rounded() == width, height.rounded() == height, width > 0, height > 0, width < 100_000, height < 100_000 else {
            throw Failure(code: "INVALID_ARGUMENTS", message: "Native window resize requires positive integer dimensions.")
        }
        let desired = Bounds(CGRect(x: current.applied.rect.minX, y: current.applied.rect.minY, width: width, height: height))
        let before = try driver.inspect(current.identity, target: current.target, expected: current.applied, authorized: authorized)
        guard before.available.rect.insetBy(dx: -1, dy: -1).contains(desired.rect) else {
            throw Failure(code: "VIEWPORT_SCREEN_LIMIT", message: "The requested real Safari window cannot fit in its current screen's available area.")
        }
        // No retry: one native size mutation per measured JS adjustment.
        do {
            let observed = try driver.resize(current.identity, target: current.target, expected: current.applied, desired: desired, authorized: authorized)
            current.applied = observed.bounds; lease = current
            return result(current, observed)
        } catch let error as Failure {
            if let observed = error.observedBounds { current.applied = observed; lease = current }
            throw error
        }
    }
    private func result(_ current: Lease, _ observed: Observation) -> [String: Any] {
        ["leaseId": current.id, "windowBounds": observed.bounds.data, "originalBounds": current.original.data,
         "availableBounds": observed.available.data, "nativeIdentityVerified": true]
    }
    private func restore(_ current: Lease, authorized: () -> Bool) throws -> [String: Any] {
        let restorationTarget = current.returnTarget ?? current.target
        do { _ = try driver.inspect(current.identity, target: restorationTarget, expected: current.applied, authorized: authorized) }
        catch { lastRestoration = "unconfirmed"; lastRestorationCode = (error as? Failure)?.code ?? "VIEWPORT_FAILED"; throw error }
        if !current.original.matches(current.applied) {
            let observed: Observation
            do { observed = try driver.resize(current.identity, target: restorationTarget, expected: current.applied, desired: current.original, authorized: authorized) }
            catch let error as Failure {
                if let bounds = error.observedBounds { var updated = current; updated.applied = bounds; lease = updated }
                lastRestoration = "unconfirmed"; lastRestorationCode = error.code
                throw error
            }
            var updated = current; updated.applied = observed.bounds; lease = updated
            guard observed.bounds.matches(current.original) else {
                lastRestoration = "unconfirmed"
                throw Failure(code: "VIEWPORT_RESTORE_UNCONFIRMED", message: "The original Safari window bounds were not restored exactly. Do not repeat the resize.", mutationApplied: true, restoration: "unconfirmed")
            }
        }
        lease = nil; driver.forget(current.identity); lastRestoration = "restored"; lastRestorationCode = nil
        return ["restored": true, "windowBounds": current.original.data]
    }

    private final class NativeDriver: Driver {
        private struct Window { let pid: pid_t; let app: AXUIElement; let node: AXUIElement }
        private var windows: [String: Window] = [:]
        init() { Self.onMain { _ = NSWorkspace.shared.runningApplications } }
        private static func onMain<T>(_ body: () -> T) -> T { Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body) }
        private func value(_ node: AXUIElement, _ key: String) -> CFTypeRef? {
            var result: CFTypeRef?; guard AXUIElementCopyAttributeValue(node, key as CFString, &result) == .success else { return nil }; return result
        }
        private func element(_ node: AXUIElement, _ key: String) -> AXUIElement? {
            guard let v = value(node, key), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }; return (v as! AXUIElement)
        }
        private func bounds(_ node: AXUIElement) -> Bounds? {
            guard let p = value(node, kAXPositionAttribute), let s = value(node, kAXSizeAttribute),
                  CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
            var point = CGPoint.zero, size = CGSize.zero
            guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
            guard point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else { return nil }
            return Bounds(CGRect(origin: point, size: size))
        }
        private func nodes(_ root: AXUIElement) throws -> [AXUIElement] {
            var pending = [(root, 0)], i = 0
            while i < pending.count {
                let (node, depth) = pending[i]; i += 1
                if value(node, kAXRoleAttribute) as? String == "AXWebArea" { continue }
                let children = value(node, kAXChildrenAttribute) as? [AXUIElement] ?? []
                guard pending.count + children.count <= 4096, depth < 24 || children.isEmpty else {
                    throw Failure(code: "VIEWPORT_WINDOW_UNVERIFIABLE", message: "Safari's native window exceeded the viewport identity bounds.")
                }
                pending += children.map { ($0, depth + 1) }
            }
            return pending.map(\.0)
        }
        private func signedSafari(_ pid: pid_t) -> Bool {
            var code: SecCode?; var requirement: SecRequirement?
            return SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess &&
                SecRequirementCreateWithString("anchor apple and identifier \"com.apple.Safari\"" as CFString, [], &requirement) == errSecSuccess &&
                code != nil && requirement != nil && SecCodeCheckValidity(code!, [], requirement!) == errSecSuccess
        }
        private func unlocked() -> Bool {
            guard let state = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
            return state["CGSSessionScreenIsLocked"] as? Bool != true && state[kCGSessionOnConsoleKey as String] as? Bool == true
        }
        private func focusPID() -> pid_t? {
            guard let app = element(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute) else { return nil }
            var pid: pid_t = 0; return AXUIElementGetPid(app, &pid) == .success ? pid : nil
        }
        private func available(_ rect: CGRect) throws -> Bounds {
            let areas: [CGRect] = Self.onMain {
                guard let top = NSScreen.screens.first?.frame.maxY else { return [] }
                return NSScreen.screens.map { s in let r = s.visibleFrame; return CGRect(x: r.minX, y: top - r.maxY, width: r.width, height: r.height) }
            }
            let matches = areas.filter { $0.contains(CGPoint(x: rect.midX, y: rect.midY)) }
            guard matches.count == 1 else { throw Failure(code: "VIEWPORT_SCREEN_UNVERIFIABLE", message: "The Safari viewport must belong to one observed screen.") }
            return Bounds(matches[0])
        }
        private func verify(_ window: Window, target: Target, expected: Bounds, authorized: () -> Bool, requireFocus: Bool = true) throws -> Observation {
            guard authorized() else { throw Failure(code: "STALE_OPERATION", message: "The viewport operation ended before native mutation.") }
            guard unlocked(), AXIsProcessTrusted(), signedSafari(window.pid) else {
                throw Failure(code: "VIEWPORT_PERMISSION_REQUIRED", message: "An unlocked session and Accessibility access to Apple Safari are required.")
            }
            let flags = CGEventSource.flagsState(.combinedSessionState)
            guard flags.intersection([.maskShift, .maskControl, .maskAlternate, .maskCommand, .maskSecondaryFn]).isEmpty,
                  ![CGMouseButton.left, .right, .center].contains(where: { CGEventSource.buttonState(.combinedSessionState, button: $0) }) else {
                throw Failure(code: "USER_INPUT_ACTIVE", message: "Release held keys and mouse buttons before native viewport resizing.")
            }
            if requireFocus {
                let front = Self.onMain { NSWorkspace.shared.frontmostApplication?.processIdentifier }
                guard front == window.pid, focusPID() == window.pid,
                      let focused = element(window.app, kAXFocusedWindowAttribute), CFEqual(focused, window.node) else {
                    throw Failure(code: "FOCUS_CHANGED", message: "Safari's native focused application or viewport window changed. No focus was reclaimed.")
                }
            }
            guard value(window.node, "AXFullScreen") as? Bool != true, value(window.node, kAXMinimizedAttribute) as? Bool != true else {
                throw Failure(code: "VIEWPORT_WINDOW_STATE", message: "Viewport resizing requires a normal, non-fullscreen Safari window.")
            }
            guard let actual = bounds(window.node), actual.matches(expected) else {
                throw Failure(code: "VIEWPORT_BOUNDS_CHANGED", message: "The Safari window no longer has this viewport lease's last observed bounds. Manual resizing is not overwritten.")
            }
            let tree = try nodes(window.node)
            guard !tree.contains(where: { ["AXSafariModalDialog", "open-panel"].contains(value($0, kAXIdentifierAttribute) as? String ?? "") }) else {
                throw Failure(code: "VIEWPORT_MODAL_OPEN", message: "Close the current Safari modal before resizing its viewport.")
            }
            let addresses = tree.filter { value($0, kAXIdentifierAttribute) as? String == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" }
                .compactMap { value($0, kAXValueAttribute) as? String }
            let expected = target.url.replacingOccurrences(of: "^https?://", with: "", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            guard addresses.count == 1, addresses[0] == target.url || addresses[0].trimmingCharacters(in: CharacterSet(charactersIn: "/")) == expected else {
                throw Failure(code: "PAGE_CHANGED", message: "The selected native Safari page no longer matches the viewport's source URL.")
            }
            return Observation(identity: "", bounds: actual, available: try available(actual.rect))
        }
        func begin(_ target: Target, authorized: () -> Bool) throws -> Observation {
            guard authorized(), unlocked(), AXIsProcessTrusted() else {
                throw Failure(code: "VIEWPORT_PERMISSION_REQUIRED", message: "An unlocked session and Accessibility access are required for viewport resizing.")
            }
            let apps = Self.onMain { NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari") }
            var matches = [Window]()
            for app in apps where !app.isTerminated && signedSafari(app.processIdentifier) {
                let ax = AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(ax, 0.5)
                guard let list = value(ax, kAXWindowsAttribute) as? [AXUIElement] else { continue }
                for node in list where bounds(node)?.matches(target.bounds) == true {
                    let candidate = Window(pid: app.processIdentifier, app: ax, node: node)
                    if (try? verify(candidate, target: target, expected: target.bounds, authorized: authorized, requireFocus: false)) != nil { matches.append(candidate) }
                }
            }
            guard matches.count == 1, let window = matches.first else {
                throw Failure(code: "VIEWPORT_WINDOW_UNVERIFIABLE", message: "Viewport resizing requires one exact signed Safari window, bounds and selected page.")
            }
            // One explicit activation only. Every subsequent check/resize and
            // every teardown restoration rejects a changed foreground owner.
            guard authorized(), AXUIElementSetAttributeValue(window.app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success,
                  AXUIElementPerformAction(window.node, kAXRaiseAction as CFString) == .success else {
                throw Failure(code: "VIEWPORT_FOCUS_FAILED", message: "Safari rejected native viewport focus. No resize was attempted.")
            }
            let deadline = Date().addingTimeInterval(2)
            repeat {
                if focusPID() == window.pid { break }
                guard authorized() else { throw Failure(code: "STALE_OPERATION", message: "The viewport owner ended during native focus.") }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
            let observed = try verify(window, target: target, expected: target.bounds, authorized: authorized)
            let id = UUID().uuidString; windows[id] = window
            return Observation(identity: id, bounds: observed.bounds, available: observed.available)
        }
        func inspect(_ identity: String, target: Target, expected: Bounds, authorized: () -> Bool) throws -> Observation {
            guard let window = windows[identity] else { throw Failure(code: "STALE_VIEWPORT", message: "The exact native viewport window lease ended.") }
            let value = try verify(window, target: target, expected: expected, authorized: authorized)
            return Observation(identity: identity, bounds: value.bounds, available: value.available)
        }
        func resize(_ identity: String, target: Target, expected: Bounds, desired: Bounds, authorized: () -> Bool) throws -> Observation {
            _ = try inspect(identity, target: target, expected: expected, authorized: authorized)
            let window = windows[identity]!
            guard authorized() else { throw Failure(code: "STALE_OPERATION", message: "The viewport owner ended before resize.") }
            var size = desired.rect.size
            guard let raw = AXValueCreate(.cgSize, &size) else { throw Failure(code: "VIEWPORT_RESIZE_FAILED", message: "Could not encode native viewport bounds.") }
            let status = AXUIElementSetAttributeValue(window.node, kAXSizeAttribute as CFString, raw)
            // AX delivery and Safari layout may complete asynchronously.
            // Observe this single mutation; never issue its size a second time.
            if status == .success {
                let deadline = Date().addingTimeInterval(0.5)
                while let observed = bounds(window.node), !observed.matches(desired), Date() < deadline {
                    guard authorized(), focusPID() == window.pid,
                          !CGEventSource.buttonState(.combinedSessionState, button: .left),
                          !CGEventSource.buttonState(.combinedSessionState, button: .right),
                          abs(observed.rect.minX - expected.rect.minX) <= 1,
                          abs(observed.rect.minY - expected.rect.minY) <= 1 else {
                        throw Failure(code: "VIEWPORT_OUTCOME_UNCERTAIN", message: "Native focus, owner or window position changed while observing the delivered resize. No resize was repeated.", mutationApplied: true, restoration: "unconfirmed")
                    }
                    Thread.sleep(forTimeInterval: 0.025)
                }
            }
            guard let actual = bounds(window.node) else {
                throw Failure(code: "VIEWPORT_OUTCOME_UNCERTAIN", message: "The native resize was delivered without observable bounds. Do not repeat it.", mutationApplied: true, restoration: "unconfirmed")
            }
            guard abs(actual.rect.minX - expected.rect.minX) <= 1, abs(actual.rect.minY - expected.rect.minY) <= 1 else {
                // A size-only operation never authorizes moving a window.
                // Do not adopt an unexplained move as our own rollback state.
                throw Failure(code: "VIEWPORT_BOUNDS_CHANGED", message: "The Safari window moved during native resizing. Its outcome is uncertain; no position or later resize was posted.", mutationApplied: true, restoration: "unconfirmed")
            }
            // AX may clamp to a minimum size; return the actual native result
            // for the bounded CSS measurement loop, never claim desired size.
            guard status == .success else {
                throw Failure(code: "VIEWPORT_RESIZE_FAILED", message: "Safari rejected native window resizing.", mutationApplied: !actual.matches(expected), restoration: actual.matches(expected) ? "not-needed" : "unconfirmed", observedBounds: actual.matches(desired) || actual.matches(expected) ? actual : nil)
            }
            do {
                let verified = try verify(window, target: target, expected: actual, authorized: authorized)
                return Observation(identity: identity, bounds: actual, available: verified.available)
            } catch var error as Failure {
                error.mutationApplied = true
                // Only the exact size we just requested can remain an owned
                // rollback receipt after a failed focus/page/input check.
                error.observedBounds = bounds(window.node).flatMap { $0.matches(desired) ? $0 : nil }
                error.restoration = "unconfirmed"; throw error
            }
        }
        func forget(_ identity: String) { windows.removeValue(forKey: identity) }
    }
}
