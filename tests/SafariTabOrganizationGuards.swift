import Foundation
import ApplicationServices

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
        _ = try request(["action": "inspectWindowSource"])
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
        let ungroupedSource = try SafariTabOrganization.windowSource(["TabGroupPickerButton?TabGroup="])
        precondition(ungroupedSource.groupTitle == nil && ungroupedSource.kind == "ungrouped" && ungroupedSource.sharingState == "unshared")
        let duplicateSource = try SafariTabOrganization.windowSource(["TabGroupPickerButton?TabGroup=", "TabGroupPickerButton?TabGroup="])
        precondition(duplicateSource == ungroupedSource)
        let groupedSource = try SafariTabOrganization.windowSource(["TabGroupPickerButton?TabGroup=Research%20Tabs"])
        precondition(groupedSource.groupTitle == "Research Tabs" && groupedSource.kind == "named-tab-group" && groupedSource.sharingState == "unknown")
        for identifiers in [[], ["PageSupplied?TabGroup="], ["TabGroupPickerButton?TabGroup=%GG"],
                            ["TabGroupPickerButton?TabGroup=", "TabGroupPickerButton?TabGroup=Research"]] {
            rejects("WINDOW_SOURCE_UNVERIFIED") { _ = try SafariTabOrganization.windowSource(identifiers) }
        }
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
        try SafariTabOrganization.validateExpectedSelection(groupTitle: "Destination", selectedTab: selected, pageURLs: [selected.url],
                                                              expectedGroupTitle: "Destination", expectedTab: selected)
        try SafariTabOrganization.validateExpectedSelection(groupTitle: nil, selectedTab: selected, pageURLs: [selected.url],
                                                              expectedGroupTitle: nil, expectedTab: selected)
        rejects("SELECTION_CHANGED") {
            try SafariTabOrganization.validateExpectedSelection(groupTitle: "Manual switch", selectedTab: selected, pageURLs: [selected.url],
                                                                  expectedGroupTitle: "Destination", expectedTab: selected)
        }
        rejects("SELECTION_CHANGED") {
            try SafariTabOrganization.validateExpectedSelection(groupTitle: "Destination", selectedTab: selected, pageURLs: ["https://example.com/manual"],
                                                                  expectedGroupTitle: "Destination", expectedTab: selected)
        }
        rejects("SELECTION_CHANGED") {
            let otherTab = SafariTabOrganization.SelectedTab(index: 0, title: selected.title, url: selected.url)
            try SafariTabOrganization.validateExpectedSelection(groupTitle: "Destination", selectedTab: otherTab, pageURLs: [selected.url],
                                                                  expectedGroupTitle: "Destination", expectedTab: selected)
        }
        try SafariTabOrganization.validateRenamedInventory(["Source", "Renamed"], previousTitle: "Destination", newTitle: "Renamed")
        try SafariTabOrganization.validateRenamedInventory(["Source", "Destination"], previousTitle: "Destination", newTitle: "Destination")
        rejects("GROUP_RENAME_UNCONFIRMED") {
            try SafariTabOrganization.validateRenamedInventory(["Source", "Destination"], previousTitle: "Destination", newTitle: "Renamed")
        }
        rejects("GROUP_RENAME_UNCONFIRMED") {
            try SafariTabOrganization.validateRenamedInventory(["Source", "Destination", "Renamed"], previousTitle: "Destination", newTitle: "Renamed")
        }
        let renamedInventory = try SafariTabOrganization.inventoryAfterConfirmedRename(["Source", "Destination", "Other"], previousTitle: "Destination", newTitle: "Renamed")
        precondition(renamedInventory == ["Source", "Renamed", "Other"])
        let unchangedInventory = try SafariTabOrganization.inventoryAfterConfirmedRename(["Source", "Destination"], previousTitle: "Destination", newTitle: "Destination")
        precondition(unchangedInventory == ["Source", "Destination"])
        rejects("GROUP_RENAME_UNCONFIRMED") {
            _ = try SafariTabOrganization.inventoryAfterConfirmedRename(["Source", "Other"], previousTitle: "Destination", newTitle: "Renamed")
        }
        rejects("GROUP_RENAME_UNCONFIRMED") {
            _ = try SafariTabOrganization.inventoryAfterConfirmedRename(["Source", "Destination", "Renamed"], previousTitle: "Destination", newTitle: "Renamed")
        }
        rejects("GROUP_RENAME_UNCONFIRMED") {
            _ = try SafariTabOrganization.inventoryAfterConfirmedRename(["Source", "Destination", "Destination"], previousTitle: "Destination", newTitle: "Renamed")
        }
        let unchecked = try SafariTabOrganization.tabBarPreference(mark: nil, status: .noValue)
        let checked = try SafariTabOrganization.tabBarPreference(mark: "✓", status: .success)
        precondition(!unchecked && checked)
        rejects("TAB_BAR_PREFERENCE_UNAVAILABLE") {
            _ = try SafariTabOrganization.tabBarPreference(mark: nil, status: .attributeUnsupported)
        }
        precondition(SafariTabOrganization.menuCompletionConfirmed(visibleNativeMenu: false, nativeMenuFocused: false))
        precondition(!SafariTabOrganization.menuCompletionConfirmed(visibleNativeMenu: true, nativeMenuFocused: false))
        precondition(!SafariTabOrganization.menuCompletionConfirmed(visibleNativeMenu: false, nativeMenuFocused: true))
        precondition(SafariTabOrganization.sidebarLayoutConfirmed(requestedVisible: true, sidebarHit: true, pickerHit: false))
        precondition(SafariTabOrganization.sidebarLayoutConfirmed(requestedVisible: false, sidebarHit: false, pickerHit: true))
        precondition(!SafariTabOrganization.sidebarLayoutConfirmed(requestedVisible: false, sidebarHit: false, pickerHit: false))
        print("Safari native Tab Group argument guards, read-only window-source proofs, title/window identities, and observed selected-tab identities passed. No Safari activation or input was performed.")
    }
}
