import Foundation

@main
struct SafariTabOrganizationGuards {
    static func main() throws {
        let base: [String: Any] = ["action": "inspect", "expectedUrl": "https://example.com/page",
                                   "windowBounds": ["left": 0, "top": 25, "width": 1200, "height": 900]]
        func request(_ changes: [String: Any] = [:]) throws -> SafariTabOrganization.Request {
            try SafariTabOrganization.Request(base.merging(changes, uniquingKeysWith: { _, rhs in rhs }))
        }
        func rejects(_ code: String, _ body: () throws -> Void) {
            do { try body(); preconditionFailure("Expected rejection: \(code)") }
            catch let failure as SafariTabOrganization.Failure { precondition(failure.code == code, failure.code) }
            catch let failure as SafariLiveInput.Failure { precondition(failure.code == code, failure.code) }
            catch { preconditionFailure("Unexpected error: \(error)") }
        }
        _ = try request()
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "deleteGroup"]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["expectedUrl": "file:///private/data"]) }
        rejects("UNSUPPORTED_GROUP_PROPERTY") { _ = try request(["color": "blue"]) }
        rejects("UNSUPPORTED_GROUP_PROPERTY") { _ = try request(["collapsed": false]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "createGroup", "newTitle": "Research"]) }
        for invalid: Any in [true, -1, 1.5, Double.infinity] {
            rejects("INVALID_ARGUMENTS") {
                _ = try request(["action": "createGroup", "newTitle": "Research", "tab": ["index": invalid, "title": "Page"]])
            }
        }
        _ = try request(["action": "createGroup", "newTitle": "Research", "tab": ["index": 0, "title": "Page"]])
        _ = try request(["action": "moveToGroup", "groupTitle": "Research", "tab": ["index": 1, "title": "Page"]])
        _ = try request(["action": "moveToUngrouped", "tab": ["index": 1, "title": "Page"]])
        _ = try request(["action": "renameGroup", "groupTitle": "Research", "newTitle": "Research 2"])
        for title in ["", "  ", "line\nbreak", String(repeating: "a", count: 201)] {
            rejects("INVALID_ARGUMENTS") { _ = try request(["action": "renameGroup", "groupTitle": "Research", "newTitle": title]) }
        }
        precondition(SafariTabOrganization.Request.validTitle("Research / Tabs & Work"))
        precondition(SafariTabOrganization.groupTitle("TabGroupPickerButton?TabGroup=Research%20%2F%20Tabs") == "Research / Tabs")
        precondition(SafariTabOrganization.groupTitle("TabGroupPickerButton?TabGroup=") == "")
        precondition(SafariTabOrganization.groupTitle("PageSupplied?TabGroup=Research") == nil)
        let uuid = "C1216CBB-8F0C-42A2-8C18-84643E328436"
        precondition(SafariTabOrganization.windowIdentifier("SafariWindow?IsSecure=true&UUID=" + uuid) == uuid)
        precondition(SafariTabOrganization.windowIdentifier("SafariWindow?IsSecure=false&UUID=" + uuid) == uuid)
        precondition(SafariTabOrganization.windowIdentifier("SafariWindow?UUID=not-a-uuid") == nil)
        let inactive = (identifier: "TabBarTab?isActive=false", title: Optional("Earlier page"))
        let active = (identifier: "TabBarTab?isPinned=false&isActive=true", title: Optional("Selected page"))
        let selected = try SafariTabOrganization.selectedTabIdentity([inactive, active], pageURLs: ["https://example.com/actual#position"])
        precondition(selected.index == 1 && selected.title == "Selected page" && selected.url == "https://example.com/actual#position")
        precondition(selected.data["index"] as? Int == 1)
        precondition(selected.data["title"] as? String == "Selected page")
        precondition(selected.data["url"] as? String == "https://example.com/actual#position")
        rejects("SELECTED_TAB_IDENTITY_UNCONFIRMED") { _ = try SafariTabOrganization.selectedTabIdentity([], pageURLs: ["https://example.com/actual"]) }
        rejects("SELECTED_TAB_IDENTITY_UNCONFIRMED") { _ = try SafariTabOrganization.selectedTabIdentity([active, active], pageURLs: ["https://example.com/actual"]) }
        rejects("SELECTED_TAB_IDENTITY_UNCONFIRMED") { _ = try SafariTabOrganization.selectedTabIdentity([inactive], pageURLs: ["https://example.com/actual"]) }
        rejects("SELECTED_TAB_IDENTITY_UNCONFIRMED") { _ = try SafariTabOrganization.selectedTabIdentity([(identifier: active.identifier, title: nil)], pageURLs: ["https://example.com/actual"]) }
        rejects("SELECTED_TAB_IDENTITY_UNCONFIRMED") { _ = try SafariTabOrganization.selectedTabIdentity([active], pageURLs: []) }
        rejects("SELECTED_TAB_IDENTITY_UNCONFIRMED") { _ = try SafariTabOrganization.selectedTabIdentity([active], pageURLs: ["https://example.com/a", "https://example.com/b"]) }
        let nativeGroups: [(identifier: String, title: String?)] = [
            ("LocalTabGroupPickerMenuItem", "1 tab"),
            ("ResearchTabGroupPickerMenuItem", "Research"),
            ("NewEmptyTabGroupPickerMenuItem", "New Empty Tab Group")
        ]
        let inventory = try SafariTabOrganization.groupInventory(nativeGroups, currentGroup: "Research")
        let emptyInventory = try SafariTabOrganization.groupInventory([], currentGroup: nil)
        precondition(inventory == ["Research"])
        precondition(emptyInventory.isEmpty)
        rejects("GROUP_INVENTORY_INCOMPLETE") { _ = try SafariTabOrganization.groupInventory(Array(nativeGroups.prefix(1)), currentGroup: "Research") }
        rejects("AMBIGUOUS_GROUP") { _ = try SafariTabOrganization.groupInventory(nativeGroups + [nativeGroups[1]], currentGroup: "Research") }
        print("Safari native Tab Group argument guards, title/window identities, and observed selected-tab identities passed. No Safari activation or input was performed.")
    }
}
