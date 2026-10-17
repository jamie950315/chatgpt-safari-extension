import Foundation
import CoreGraphics

@main struct ViewportProtocol {
    final class Driver: SafariViewport.Driver {
        var current = SafariViewport.Bounds(CGRect(x: 10, y: 30, width: 1000, height: 800))
        let area = SafariViewport.Bounds(CGRect(x: 0, y: 25, width: 1920, height: 1055))
        var focused = true, begins = 0, changes = 0, forgotten = 0
        var page = "http://fixture.test/viewport"
        func begin(_ target: SafariViewport.Target, authorized: () -> Bool) throws -> SafariViewport.Observation {
            begins += 1; return try inspect("window", target: target, expected: target.bounds, authorized: authorized)
        }
        func inspect(_ identity: String, target: SafariViewport.Target, expected: SafariViewport.Bounds, authorized: () -> Bool) throws -> SafariViewport.Observation {
            guard authorized() else { throw SafariViewport.Failure(code: "STALE_OPERATION", message: "Ended") }
            guard focused else { throw SafariViewport.Failure(code: "FOCUS_CHANGED", message: "Manual focus changed") }
            guard current.matches(expected) else { throw SafariViewport.Failure(code: "VIEWPORT_BOUNDS_CHANGED", message: "Manual bounds changed") }
            guard page == target.url else { throw SafariViewport.Failure(code: "PAGE_CHANGED", message: "Native selected page changed") }
            return .init(identity: "window", bounds: current, available: area)
        }
        func resize(_ identity: String, target: SafariViewport.Target, expected: SafariViewport.Bounds, desired: SafariViewport.Bounds, authorized: () -> Bool) throws -> SafariViewport.Observation {
            _ = try inspect(identity, target: target, expected: expected, authorized: authorized)
            current = desired; changes += 1
            return .init(identity: identity, bounds: current, available: area)
        }
        func forget(_ identity: String) { forgotten += 1 }
    }
    static func main() throws {
        let driver = Driver(), viewport = SafariViewport(driver: driver)
        let scope = ["profileId": "profile", "ownerId": "owner", "accountScope": "account", "sessionId": "session", "turnId": "turn", "tabId": "12", "documentId": "document"]
        var command: [String: Any] = ["operation": "begin", "scope": scope, "expectedUrl": "http://fixture.test/viewport", "windowBounds": driver.current.data]
        func rejects(_ code: String, _ run: () throws -> Void) {
            do { try run(); preconditionFailure("Expected \(code)") }
            catch let e as SafariViewport.Failure { precondition(e.code == code, e.code) }
            catch { preconditionFailure("Unexpected failure: \(error)") }
        }
        let begun = try viewport.perform(command, authorized: { true }); command["leaseId"] = begun["leaseId"]
        _ = try viewport.perform(command, authorized: { true }); precondition(driver.begins == 1)
        command["operation"] = "resize"; command["width"] = 820; command["height"] = 700
        _ = try viewport.perform(command, authorized: { true }); precondition(driver.changes == 1)
        command["windowBounds"] = driver.current.data
        var returned = command; returned["operation"] = "commitReturnPage"; returned["returnUrl"] = "http://fixture.test/sidebar"
        driver.page = "http://fixture.test/sidebar"
        _ = try viewport.perform(returned, authorized: { true })
        var check = command; check["operation"] = "check"
        rejects("PAGE_CHANGED") { _ = try viewport.perform(check, authorized: { true }) }
        driver.page = "http://fixture.test/viewport"
        var invalid = command; invalid["width"] = true
        rejects("INVALID_ARGUMENTS") { _ = try viewport.perform(invalid, authorized: { true }) }
        invalid = command; invalid["width"] = 5000
        rejects("VIEWPORT_SCREEN_LIMIT") { _ = try viewport.perform(invalid, authorized: { true }) }
        invalid = command; invalid["leaseId"] = "stale"
        rejects("STALE_VIEWPORT") { _ = try viewport.perform(invalid, authorized: { true }) }
        var changed = scope; changed["turnId"] = "other-turn"; invalid = command; invalid["scope"] = changed
        rejects("STALE_VIEWPORT") { _ = try viewport.perform(invalid, authorized: { true }) }
        command["operation"] = "restore"; driver.page = "http://fixture.test/sidebar"; driver.focused = false
        rejects("FOCUS_CHANGED") { _ = try viewport.perform(command, authorized: { true }) }; precondition(driver.changes == 1)
        driver.focused = true
        let restored = try viewport.perform(command, authorized: { true }); precondition(restored["restored"] as? Bool == true)
        precondition(driver.current.rect.width == 1000 && driver.current.rect.height == 800 && driver.forgotten == 1)
        rejects("STALE_VIEWPORT") { _ = try viewport.perform(command, authorized: { true }) }
        rejects("STALE_OPERATION") { _ = try viewport.perform(command, authorized: { false }) }
        print("Viewport protocol: exact source lease, original bounds, screen limits, native focus/manual-change refusal, reset and no stale replay passed. No native UI was operated.")
    }
}
