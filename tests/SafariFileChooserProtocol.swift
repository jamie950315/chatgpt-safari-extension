import Foundation
import ApplicationServices

@main struct SafariFileChooserProtocol {
    final class Driver: SafariFileChooser.Driver {
        var observed: SafariFileChooser.Observation? = .init(window: "native-window-a", panel: "native-panel-a")
        var choices: [[SafariFileChooser.LocalFile]] = []
        var cancels = 0
        var failChoice = false
        func observe(_ target: SafariFileChooser.Target, authorized: () -> Bool) throws -> SafariFileChooser.Observation? {
            precondition(authorized()); return observed
        }
        func choose(_ files: [SafariFileChooser.LocalFile], target: SafariFileChooser.Target, observed: SafariFileChooser.Observation, authorized: () -> Bool) throws {
            precondition(authorized()); choices.append(files)
            if failChoice { throw SafariFileChooser.Failure(code: "UNCERTAIN", message: "No replay", mutationApplied: true, doNotReplay: true) }
            self.observed = nil
        }
        func cancel(_ target: SafariFileChooser.Target, observed: SafariFileChooser.Observation, authorized: () -> Bool) throws {
            precondition(authorized()); cancels += 1; self.observed = nil
        }
    }
    static func main() throws {
        let application = AXUIElementCreateApplication(getpid()), sameApplication = AXUIElementCreateApplication(getpid()), sheet = AXUIElementCreateSystemWide()
        let merged = SafariFileChooser.nativeChildren([application, sheet], sheets: [sameApplication, sheet], visited: [])
        precondition(merged.count == 2 && CFEqual(merged[0], application) && CFEqual(merged[1], sheet))
        let unseen = SafariFileChooser.nativeChildren([application], sheets: [sheet, sameApplication], visited: [application])
        precondition(unseen.count == 1 && CFEqual(unseen[0], sheet), "AXSheets-only nodes must be traversed while duplicate edges and ancestor cycles are ignored")
        precondition(SafariFileChooser.modalFocusMatches(sourceIsFocused: true, focusedRole: kAXWindowRole, focusedIdentifier: nil, attachedToSource: false))
        for identifier in ["open-panel", "GoToWindow"] {
            precondition(SafariFileChooser.modalFocusMatches(sourceIsFocused: false, focusedRole: kAXSheetRole, focusedIdentifier: identifier, attachedToSource: true))
            precondition(!SafariFileChooser.modalFocusMatches(sourceIsFocused: false, focusedRole: kAXSheetRole, focusedIdentifier: identifier, attachedToSource: false), "An identically named sheet from another window must not inherit source authority")
        }
        precondition(!SafariFileChooser.modalFocusMatches(sourceIsFocused: false, focusedRole: kAXWindowRole, focusedIdentifier: "open-panel", attachedToSource: true))
        precondition(!SafariFileChooser.modalFocusMatches(sourceIsFocused: false, focusedRole: kAXSheetRole, focusedIdentifier: "unrelated-dialog", attachedToSource: true))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("safari-filechooser-test-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let first = root.appendingPathComponent("first.txt"), second = root.appendingPathComponent("second.txt")
        try Data("first".utf8).write(to: first); try Data("second".utf8).write(to: second)
        let scope = ["profileId": "profile-a", "tabId": "12", "documentId": "doc-a", "node": "n1", "ownerId": "sidebar-a", "sessionId": "session-a", "turnId": "turn-a"]
        let base: [String: Any] = ["action": "fileChooser", "operation": "inspect", "expectedUrl": "https://example.test/upload",
            "windowBounds": ["left": 0, "top": 25, "width": 1200, "height": 900], "scope": scope, "isMultiple": true]
        let sameBoundsWindowAddresses = ["https://unrelated.test/", "example.test/upload"]
        precondition(sameBoundsWindowAddresses.filter { SafariFileChooser.matchesPageAddress($0, expected: "https://example.test/upload") }.count == 1)
        precondition(!SafariFileChooser.matchesPageAddress("example.test/upload-other", expected: "https://example.test/upload"))
        precondition(!SafariFileChooser.matchesPageAddress("unrelated.test/upload", expected: "https://example.test/upload"))
        precondition(["https://example.test/upload", "example.test/upload"].filter { SafariFileChooser.matchesPageAddress($0, expected: "https://example.test/upload") }.count == 2,
                     "Two indistinguishable source addresses must remain ambiguous, not select the first window")
        func rejects(_ code: String, _ run: () throws -> Void) {
            do { try run(); preconditionFailure("Expected \(code)") }
            catch let failure as SafariFileChooser.Failure { precondition(failure.code == code, failure.code) }
            catch { preconditionFailure("Unexpected error: \(error)") }
        }
        func merging(_ updates: [String: Any]) -> [String: Any] { base.merging(updates) { _, new in new } }
        let native = Driver(), chooser = SafariFileChooser(driver: native)
        let initial = try chooser.perform(base, authorized: { true })["fileChooser"] as! [String: Any]
        let id = initial["id"] as! String
        precondition(initial["isMultiple"] as? Bool == true)
        let repeated = try chooser.perform(base, authorized: { true })["fileChooser"] as! [String: Any]
        precondition(repeated["id"] as? String == id)
        rejects("INVALID_ARGUMENTS") { _ = try SafariFileChooser.Target(merging(["isMultiple": NSNumber(value: 1)])) }
        rejects("INVALID_ARGUMENTS") { _ = try SafariFileChooser.Target(merging(["expectedUrl": "file:///tmp/test"])) }
        rejects("INVALID_ARGUMENTS") { _ = try SafariFileChooser.Scope(scope.merging(["tabId": "012"]) { _, n in n }) }
        rejects("INVALID_ARGUMENTS") { _ = try SafariFileChooser.Scope(["ownerId": "sidebar-a"]) }
        for paths in [[], ["relative.txt"], [root.path], [first.path, first.path]] {
            rejects("INVALID_FILES") { _ = try SafariFileChooser.files(paths, multiple: true) }
        }
        rejects("INVALID_FILES") { _ = try SafariFileChooser.files([first.path, second.path], multiple: false) }
        rejects("STALE_FILE_CHOOSER") { _ = try chooser.perform(merging(["operation": "setFiles", "chooserId": "old", "files": [first.path]]), authorized: { true }) }
        var wrong = scope; wrong["documentId"] = "next-document"
        rejects("STALE_FILE_CHOOSER") { _ = try chooser.perform(merging(["operation": "setFiles", "scope": wrong, "chooserId": id, "files": [first.path]]), authorized: { true }) }
        precondition(native.choices.isEmpty)
        let result = try chooser.perform(merging(["operation": "setFiles", "chooserId": id, "files": [first.path, second.path]]), authorized: { true })
        precondition(result["done"] as? Bool == true && native.choices.count == 1 && native.choices[0].count == 2)
        rejects("FILE_CHOOSER_CLOSED") { _ = try chooser.perform(merging(["operation": "setFiles", "chooserId": id, "files": [first.path]]), authorized: { true }) }
        native.observed = .init(window: "native-window-a", panel: "native-panel-b")
        let next = try chooser.perform(base, authorized: { true })["fileChooser"] as! [String: Any]
        let nextID = next["id"] as! String
        native.failChoice = true
        rejects("UNCERTAIN") { _ = try chooser.perform(merging(["operation": "setFiles", "chooserId": nextID, "files": [first.path]]), authorized: { true }) }
        rejects("STALE_FILE_CHOOSER") { _ = try chooser.perform(merging(["operation": "setFiles", "chooserId": nextID, "files": [first.path]]), authorized: { true }) }
        precondition(native.choices.count == 2, "An uncertain native submission must never be replayed")
        rejects("STALE_OPERATION") { _ = try chooser.perform(base, authorized: { false }) }
        let cancel = try chooser.perform(base, authorized: { true })["fileChooser"] as! [String: Any]
        _ = try chooser.perform(merging(["operation": "cancel", "chooserId": cancel["id"]!]), authorized: { true })
        precondition(native.cancels == 1)
        print("File chooser protocol: exact source/native lease, attached-sheet source focus, observed multiple, explicit local files, cancellation, and uncertain-submission no-replay passed. No native UI or file contents were read.")
    }
}
