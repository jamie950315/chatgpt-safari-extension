import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security

/// Native Safari Tab Groups, not Chrome groups or a window-based substitute.
/// The broker must select/focus a fresh claimed tab before calling this helper.
/// Native group identities are title-bound within a native window/profile; Safari
/// does not expose persistent Tab Group identifiers through its public AX API.
final class SafariTabOrganization {
    struct Failure: Error {
        let code: String
        let message: String
        let details: [String: Any]?

        init(code: String, message: String, details: [String: Any]? = nil) {
            self.code = code; self.message = message; self.details = details
        }
    }

    struct SelectedTab: Equatable {
        let index: Int
        let title: String
        let url: String

        var data: [String: Any] { ["index": index, "title": title, "url": url] }
    }

    struct WindowSource: Equatable {
        let pickerIdentifier: String
        let groupTitle: String?
        var kind: String { groupTitle == nil ? "ungrouped" : "named-tab-group" }
        // A named collection needs its own positive sharing proof. A header
        // alone never authorizes moving tabs out of a shared/unknown group.
        var sharingState: String { groupTitle == nil ? "unshared" : "unknown" }
    }

    struct Request {
        let action: String
        let target: SafariLiveInput.Target
        let tabIndex: Int?
        let tabTitle: String?
        let groupTitle: String?
        let newTitle: String?
        let expectedWindowIdentifier: String?

        init(_ command: [String: Any]) throws {
            guard let action = command["action"] as? String,
                  ["inspect", "inspectWindowSource", "createGroup", "moveToGroup", "moveToUngrouped", "renameGroup", "selectGroup"].contains(action) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected inspect, inspectWindowSource, createGroup, moveToGroup, moveToUngrouped, renameGroup, or selectGroup.")
            }
            if command["color"] != nil || command["collapsed"] != nil {
                throw Failure(code: "UNSUPPORTED_GROUP_PROPERTY", message: "Safari Tab Groups do not expose Chrome group colors or collapse state.")
            }
            self.action = action
            target = try SafariLiveInput.Target(command)
            groupTitle = command["groupTitle"] as? String
            newTitle = command["newTitle"] as? String
            expectedWindowIdentifier = command["windowIdentifier"] as? String
            let tab = command["tab"] as? [String: Any]
            if let number = tab?["index"] as? NSNumber,
               CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
               number.doubleValue.rounded() == number.doubleValue,
               (0...10_000).contains(number.intValue) {
                tabIndex = number.intValue
            } else { tabIndex = nil }
            tabTitle = tab?["title"] as? String
            if ["createGroup", "moveToGroup", "moveToUngrouped"].contains(action),
               tabIndex == nil || tabTitle?.isEmpty != false {
                throw Failure(code: "INVALID_ARGUMENTS", message: "A tab mutation requires a fresh zero-based tab index and exact tab title.")
            }
            if ["moveToGroup", "renameGroup", "selectGroup"].contains(action), !Self.validTitle(groupTitle) {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected an exact nonempty native groupTitle of at most 200 UTF-16 units, without control characters.")
            }
            if ["createGroup", "renameGroup"].contains(action), !Self.validTitle(newTitle) {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected a nonempty newTitle of at most 200 UTF-16 units, without control characters.")
            }
        }

        static func validTitle(_ value: String?) -> Bool {
            guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  value.utf16.count <= 200 else { return false }
            return value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
        }
    }

    private struct ExpectedSelection {
        let groupTitle: String?
        let tab: SelectedTab
    }

    private struct NativeMenuState {
        let contextVisible: Bool
        let pickerVisible: Bool
        let viewVisible: Bool
        let otherVisible: Bool
        let menuFocused: Bool

        var visible: Bool { contextVisible || pickerVisible || viewVisible || otherVisible }
        var data: [String: Any] {
            ["visibleContextMenu": contextVisible, "visibleGroupPickerMenu": pickerVisible,
             "visibleViewMenu": viewVisible, "visibleOtherNativeMenu": otherVisible,
             "nativeMenuFocused": menuFocused,
             "menuInteractionState": visible ? "visible_native_menu" : (menuFocused ? "native_menu_focus" : "none")]
        }
    }

    private final class Context {
        let request: Request
        let pid: pid_t
        let app: AXUIElement
        let window: AXUIElement
        let windowIdentifier: String
        var expectedSelection: ExpectedSelection?

        init(request: Request, pid: pid_t, app: AXUIElement, window: AXUIElement, windowIdentifier: String) {
            self.request = request; self.pid = pid; self.app = app
            self.window = window; self.windowIdentifier = windowIdentifier
        }
    }

    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.tab-organization")

    func handle(_ command: [String: Any], isAuthorized: @escaping () -> Bool,
                reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            var actions = 0
            var mutationApplied = false
            var tabBarRestoration: String?
            var sidebarRestoration: String?
            let authorized = { [self] in onMain { isAuthorized() } }
            do {
                let request = try Request(command)
                let context = try makeContext(request, isAuthorized: authorized)
                var result = try perform(context, isAuthorized: authorized, actions: &actions,
                                         mutationApplied: &mutationApplied, tabBarRestoration: &tabBarRestoration,
                                         sidebarRestoration: &sidebarRestoration)
                if let tabBarRestoration { result["tabBarRestoration"] = tabBarRestoration }
                if let sidebarRestoration { result["nativeSidebarRestoration"] = sidebarRestoration }
                reply(["ok": true, "result": result])
            } catch {
                let code: String, message: String
                var failureData: [String: Any]?
                if let failure = error as? Failure {
                    code = failure.code; message = failure.message; failureData = failure.details
                }
                else if let failure = error as? SafariLiveInput.Failure { code = failure.code; message = failure.message }
                else { code = "NATIVE_ORGANIZATION_FAILED"; message = "Native Safari tab organization failed." }
                var details: [String: Any] = ["code": code, "message": message,
                    "actionsPerformed": actions, "mayHavePostedInput": actions > 0,
                    "mutationApplied": mutationApplied, "doNotReplay": actions > 0]
                if let tabBarRestoration { details["tabBarRestoration"] = tabBarRestoration }
                if let sidebarRestoration { details["nativeSidebarRestoration"] = sidebarRestoration }
                if let failureData { details["data"] = failureData }
                reply(["ok": false, "error": details])
            }
        }
    }

    static func windowIdentifier(_ identifier: String) -> String? {
        guard identifier.hasPrefix("SafariWindow?"),
              let components = URLComponents(string: "safari-window://window?" + identifier.dropFirst("SafariWindow?".count)),
              let raw = components.queryItems?.first(where: { $0.name == "UUID" })?.value,
              let uuid = UUID(uuidString: raw) else { return nil }
        return uuid.uuidString
    }

    static func groupTitle(_ identifier: String) -> String? {
        let prefix = "TabGroupPickerButton?TabGroup="
        guard identifier.hasPrefix(prefix) else { return nil }
        return String(identifier.dropFirst(prefix.count)).removingPercentEncoding
    }

    static func windowSource(_ pickerIdentifiers: [String]) throws -> WindowSource {
        guard !pickerIdentifiers.isEmpty, Set(pickerIdentifiers).count == 1,
              let identifier = pickerIdentifiers.first, let title = groupTitle(identifier) else {
            throw Failure(code: "WINDOW_SOURCE_UNVERIFIED", message: "Safari did not expose one exact native source collection identity. No window creation was delivered.")
        }
        return WindowSource(pickerIdentifier: identifier, groupTitle: title.isEmpty ? nil : title)
    }

    static func selectedTabIdentity(_ tabs: [(identifier: String, title: String?)], pageURLs: [String]) throws -> SelectedTab {
        let active = tabs.enumerated().filter { entry in
            guard entry.element.identifier.hasPrefix("TabBarTab?"),
                  let components = URLComponents(string: "safari-tab://tab?" + entry.element.identifier.dropFirst("TabBarTab?".count)) else { return false }
            let states = components.queryItems?.filter { $0.name == "isActive" } ?? []
            return states.count == 1 && states[0].value == "true"
        }
        guard active.count == 1, let selected = active.first,
              let title = selected.element.title, !title.isEmpty,
              pageURLs.count == 1, let url = pageURLs.first, !url.isEmpty else {
            throw Failure(code: "SELECTED_TAB_IDENTITY_UNCONFIRMED", message: "Safari did not expose exactly one active native tab, its title, and the displayed page URL. Inspect fresh state; do not replay the group mutation.")
        }
        return SelectedTab(index: selected.offset, title: title, url: url)
    }

    static func groupInventory(_ items: [(identifier: String, title: String?)], currentGroup: String?) throws -> [String] {
        let suffix = "TabGroupPickerMenuItem"
        let titles = items.compactMap { item -> String? in
            guard item.identifier.hasSuffix(suffix), item.identifier != "LocalTabGroupPickerMenuItem" else { return nil }
            let title = String(item.identifier.dropLast(suffix.count))
            guard !title.isEmpty, item.title == title else { return nil }
            return title
        }
        guard Set(titles).count == titles.count else {
            throw Failure(code: "AMBIGUOUS_GROUP", message: "Safari exposed duplicate native group titles, which cannot identify distinct groups safely.")
        }
        if let currentGroup, !titles.contains(currentGroup) {
            throw Failure(code: "GROUP_INVENTORY_INCOMPLETE", message: "Safari's native group inventory omitted its currently selected Tab Group. No group mutation was sent.")
        }
        return titles
    }

    static func validateExpectedSelection(groupTitle: String?, selectedTab: SelectedTab?, pageURLs: [String],
                                           expectedGroupTitle: String?, expectedTab: SelectedTab) throws {
        guard groupTitle == expectedGroupTitle, pageURLs == [expectedTab.url],
              selectedTab == nil || selectedTab == expectedTab else {
            throw Failure(code: "SELECTION_CHANGED", message: "The native Safari collection or selected tab changed outside the expected group transition. Source restoration was not forced.")
        }
    }

    static func validateRenamedInventory(_ titles: [String], previousTitle: String, newTitle: String) throws {
        guard titles.filter({ $0 == newTitle }).count == 1,
              previousTitle == newTitle || !titles.contains(previousTitle) else {
            throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "Safari's native group inventory did not confirm the unique renamed group. Do not replay the name change.")
        }
    }

    static func inventoryAfterConfirmedRename(_ titles: [String], previousTitle: String, newTitle: String) throws -> [String] {
        guard titles.filter({ $0 == previousTitle }).count == 1,
              previousTitle == newTitle || !titles.contains(newTitle),
              Set(titles).count == titles.count else {
            throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "The preflight native group inventory cannot identify one unique renamed group. Do not replay the name change.")
        }
        let renamed = titles.map { $0 == previousTitle ? newTitle : $0 }
        try validateRenamedInventory(renamed, previousTitle: previousTitle, newTitle: newTitle)
        return renamed
    }

    static func tabBarPreference(mark: String?, status: AXError) throws -> Bool {
        if status == .noValue { return false }
        guard status == .success, let mark else {
            throw Failure(code: "TAB_BAR_PREFERENCE_UNAVAILABLE", message: "Safari did not expose its native Always Show Tab Bar preference state.")
        }
        return !mark.isEmpty
    }

    static func menuCompletionConfirmed(visibleNativeMenu: Bool, nativeMenuFocused: Bool) -> Bool {
        !visibleNativeMenu && !nativeMenuFocused
    }

    static func sidebarLayoutConfirmed(requestedVisible: Bool, sidebarHit: Bool, pickerHit: Bool) -> Bool {
        sidebarHit == requestedVisible && (requestedVisible || pickerHit)
    }

    private func perform(_ context: Context, isAuthorized: () -> Bool,
                         actions: inout Int, mutationApplied: inout Bool,
                         tabBarRestoration: inout String?, sidebarRestoration: inout String?) throws -> [String: Any] {
        let request = context.request
        if request.action == "inspectWindowSource" {
            // windows.create moves a requested native tab, not a Tab Group.
            // Observe the selected collection without clicking its picker or
            // opening an unrelated group inventory/sharing menu.
            func source() throws -> WindowSource {
                let identifiers = nativeNodes(context.window).compactMap { node -> String? in
                    guard let identifier = string(node, kAXIdentifierAttribute), identifier.hasPrefix("TabGroupPickerButton?"),
                          frame(node).map({ !$0.isEmpty }) == true else { return nil }
                    return identifier
                }
                return try Self.windowSource(identifiers)
            }
            try stable(context, isAuthorized: isAuthorized)
            let observed = try source()
            try stable(context, isAuthorized: isAuthorized)
            guard try source() == observed else {
                throw Failure(code: "WINDOW_SOURCE_CHANGED", message: "The native source collection changed during window-transfer preflight. No window creation was delivered.")
            }
            return ["action": request.action, "backend": "macOS Accessibility", "scope": "existing_safari_tabs",
                    "windowIdentifier": context.windowIdentifier,
                    "currentGroupTitle": observed.groupTitle as Any? ?? NSNull(),
                    "currentGroupSharingState": observed.sharingState,
                    "sourceCollection": ["kind": observed.kind, "sharingState": observed.sharingState,
                                         "nativeWindowIdentifier": context.windowIdentifier],
                    "actionsPerformed": 0, "mutationApplied": false]
        }
        var revealedTabBar = false
        let originalSidebarVisible = nativeSidebarVisible(context)
        var sidebarRestoreAttempted = false
        defer {
            if revealedTabBar {
                // Restore only the setting this operation changed. A cancelled
                // owner or changed window stops cleanup instead of refocusing.
                do {
                    try restoreHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions)
                    tabBarRestoration = "restored"
                } catch { tabBarRestoration = "unconfirmed" }
            }
            if !sidebarRestoreAttempted, nativeSidebarVisible(context) != originalSidebarVisible {
                do {
                    try setNativeSidebarVisible(originalSidebarVisible, context: context, isAuthorized: isAuthorized,
                                                actions: &actions, requirePage: false)
                    sidebarRestoration = "restored"
                } catch { sidebarRestoration = "unconfirmed" }
            }
        }
        let initialGroup = try currentGroupTitle(context)
        if !nativeTabs(context).isEmpty {
            context.expectedSelection = ExpectedSelection(groupTitle: initialGroup, tab: try rawSelectedTab(context))
        }
        let groups = try groupTitles(context, isAuthorized: isAuthorized, actions: &actions)
        var destination: String? = initialGroup
        let restoresSource = ["createGroup", "moveToGroup", "moveToUngrouped"].contains(request.action)
        switch request.action {
        case "inspect": break
        case "selectGroup":
            let title = request.groupTitle!
            try requireUnique(title, among: groups)
            try requireUnshared(title, context: context, isAuthorized: isAuthorized, actions: &actions)
            try selectGroup(title, context: context, isAuthorized: isAuthorized, actions: &actions)
            destination = title
        case "renameGroup":
            try requireUnique(request.groupTitle!, among: groups)
            try requireUnused(request.newTitle!, except: request.groupTitle, among: groups)
            if nativeTabs(context).isEmpty {
                try showHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions, revealed: &revealedTabBar)
            }
            context.expectedSelection = ExpectedSelection(groupTitle: initialGroup, tab: try rawSelectedTab(context))
            try renameGroup(context, currentTitle: request.groupTitle!, newTitle: request.newTitle!,
                            isAuthorized: isAuthorized, actions: &actions, mutationApplied: &mutationApplied)
            destination = request.newTitle
        default:
            if let initialGroup {
                try requireUnique(initialGroup, among: groups)
                try requireUnshared(initialGroup, context: context, isAuthorized: isAuthorized, actions: &actions)
            }
            if request.action == "moveToGroup" {
                try requireUnique(request.groupTitle!, among: groups)
                try requireUnshared(request.groupTitle!, context: context, isAuthorized: isAuthorized, actions: &actions)
                destination = request.groupTitle
            } else if request.action == "createGroup" {
                try requireUnused(request.newTitle!, except: nil, among: groups)
                destination = request.newTitle
            } else { destination = nil }
            if nativeTabs(context).isEmpty {
                try showHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions, revealed: &revealedTabBar)
            }
            let tab = try selectedTab(context)
            let sourceSelected = try rawSelectedTab(context)
            context.expectedSelection = ExpectedSelection(groupTitle: initialGroup, tab: sourceSelected)
            try rightClick(tab, context: context, isAuthorized: isAuthorized, actions: &actions)
            defer { cancelMenu(context) }
            let menu = try waitForIdentifier("SafariContextMenu", context: context, isAuthorized: isAuthorized)
            let itemID: String
            if request.action == "createGroup" { itemID = "MoveTabToNewTabGroupMenuItem" }
            else if request.action == "moveToUngrouped" { itemID = "MoveTabToLocalTabGroupMenuItem" }
            else { itemID = "MoveTabTo\(request.groupTitle!)TabGroupMenuItem" }
            let matches = nativeNodes(menu).filter { string($0, kAXIdentifierAttribute) == itemID }
            guard matches.count == 1, let item = matches.first else {
                throw Failure(code: "GROUP_UNAVAILABLE", message: "Safari did not expose exactly one matching native group destination.")
            }
            // This is the mutation boundary. A failed AX action may still have
            // delivered; callers must inspect fresh state, never replay it.
            try stable(context, isAuthorized: isAuthorized)
            mutationApplied = true
            // Only the delivered group command may change the collection. Its
            // action-specific postcondition re-arms the exact selection guard.
            context.expectedSelection = nil
            try press(item, context: context, isAuthorized: isAuthorized, actions: &actions)
            if request.action == "createGroup" {
                let field = try waitForNameEditor(context, isAuthorized: isAuthorized)
                guard let temporaryTitle = try currentGroupTitle(context), temporaryTitle != initialGroup,
                      string(field, kAXValueAttribute) == temporaryTitle else {
                    throw Failure(code: "GROUP_TRANSITION_UNCONFIRMED", message: "Safari did not expose the new group's own focused name editor. No name was entered; do not replay creation.")
                }
                try setName(field, currentTitle: temporaryTitle, title: request.newTitle!, context: context,
                            isAuthorized: isAuthorized, actions: &actions)
                try waitForGroup(request.newTitle!, context: context, isAuthorized: isAuthorized)
                if nativeTabs(context).isEmpty {
                    try showHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions, revealed: &revealedTabBar)
                }
                let createdSelected = try rawSelectedTab(context)
                guard createdSelected.url == sourceSelected.url, createdSelected.title == sourceSelected.title else {
                    throw Failure(code: "GROUP_TRANSITION_UNCONFIRMED", message: "Safari's newly created group no longer displays the moved target tab. Source restoration was not forced.")
                }
                context.expectedSelection = ExpectedSelection(groupTitle: request.newTitle, tab: createdSelected)
                // Restore the preference in this same one-tab destination,
                // before returning to a source whose multi-tab bar is forced
                // visible and whose View preference action can be disabled.
                if revealedTabBar {
                    revealedTabBar = false
                    do {
                        try restoreHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions)
                        tabBarRestoration = "restored"
                    } catch { tabBarRestoration = "unconfirmed" }
                }
                try selectCollection(initialGroup, context: context, isAuthorized: isAuthorized,
                                     actions: &actions, revealedTabBar: &revealedTabBar)
            } else {
                try waitForMenuDismissal(context, isAuthorized: isAuthorized, stage: "group_move_completion")
                guard try currentGroupTitle(context) == initialGroup else {
                    throw Failure(code: "GROUP_TRANSITION_UNCONFIRMED", message: "Safari changed away from the original source collection after moving the tab. Source restoration was not forced.")
                }
                if nativeTabs(context).isEmpty {
                    try showHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions,
                                         revealed: &revealedTabBar, requirePage: false)
                }
                context.expectedSelection = ExpectedSelection(groupTitle: initialGroup, tab: try rawSelectedTab(context))
            }
        }
        try stable(context, isAuthorized: isAuthorized, requirePage: false)
        let titles: [String]
        if request.action == "renameGroup" {
            // The exact native row has committed its new title, the old row is
            // absent, and the original source selection remains guarded. Apply
            // that observed rename to the complete preflight inventory instead
            // of immediately hiding the sidebar to reopen the picker.
            titles = try Self.inventoryAfterConfirmedRename(groups, previousTitle: request.groupTitle!, newTitle: request.newTitle!)
        } else {
            titles = request.action == "inspect" ? groups : try groupTitles(context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        }
        if nativeSidebarVisible(context) != originalSidebarVisible {
            sidebarRestoreAttempted = true
            do {
                try setNativeSidebarVisible(originalSidebarVisible, context: context, isAuthorized: isAuthorized,
                                            actions: &actions, requirePage: false)
                sidebarRestoration = "restored"
            } catch {
                sidebarRestoration = "unconfirmed"
                throw error
            }
        }
        if nativeTabs(context).isEmpty {
            try showHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions, revealed: &revealedTabBar, requirePage: false)
        }
        var current = try currentGroupTitle(context)
        var selected = try observedSelectedTab(context, isAuthorized: isAuthorized)
        if revealedTabBar {
            // Finish display-only cleanup before returning an identity to the
            // broker. Never replay a cleanup action whose delivery is uncertain.
            revealedTabBar = false
            do {
                try restoreHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions)
                tabBarRestoration = "restored"
            } catch { tabBarRestoration = "unconfirmed" }
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            let finalGroup = try currentGroupTitle(context)
            if nativeTabs(context).isEmpty {
                // Hiding a one-tab bar does not select a different tab. Preserve
                // its actual AX observation only while the group and exact page
                // URL remain unchanged after restoring the original display.
                guard selected.index == 0, finalGroup == current, pageURLs(context.window) == [selected.url] else {
                    throw Failure(code: "SELECTED_TAB_IDENTITY_UNCONFIRMED", message: "Safari's selected group or page changed while restoring the hidden tab bar. Do not replay the group mutation.")
                }
            } else {
                selected = try observedSelectedTab(context, isAuthorized: isAuthorized)
            }
            current = finalGroup
        }
        var result: [String: Any] = [
            "action": request.action, "backend": "macOS Accessibility + CGEvent", "scope": "existing_safari_tabs",
            "windowIdentifier": context.windowIdentifier, "currentGroupTitle": current as Any? ?? NSNull(),
            "identity": current.map { identity($0, context: context) } as Any? ?? NSNull(),
            "groupTitles": titles, "groups": titles.map { ["title": $0, "identity": identity($0, context: context), "sharingState": "unknown"] as [String: Any] },
            "actionsPerformed": actions, "mutationApplied": mutationApplied,
            "pageChanged": selected.url != request.target.expectedURL, "selectedTab": selected.data
        ]
        if request.action != "inspect" { result["destinationGroupTitle"] = destination as Any? ?? NSNull() }
        if request.action == "renameGroup" {
            result["renamedGroup"] = identity(request.newTitle!, context: context)
            result["groupInventorySource"] = "confirmed_rename_of_preflight_inventory"
        }
        if restoresSource {
            guard current == initialGroup else {
                throw Failure(code: "SOURCE_COLLECTION_NOT_RESTORED", message: "Safari did not restore the original source collection after the group mutation. Do not replay it.")
            }
            result["sourceCollection"] = collectionProof(initialGroup, context: context).merging([
                "selectedUrlBefore": request.target.expectedURL, "restored": true
            ], uniquingKeysWith: { _, rhs in rhs })
            result["destinationCollection"] = collectionProof(destination, context: context)
        }
        return result
    }

    private func collectionProof(_ title: String?, context: Context) -> [String: Any] {
        ["title": title as Any? ?? NSNull(),
         "identity": title.map { identity($0, context: context) } as Any? ?? NSNull(),
         "nativeWindowIdentifier": context.windowIdentifier]
    }

    private func identity(_ title: String, context: Context) -> [String: String] {
        ["kind": "safari-native-title", "title": title, "windowIdentifier": context.windowIdentifier]
    }

    private func requireUnique(_ title: String, among titles: [String]) throws {
        guard titles.filter({ $0 == title }).count == 1 else {
            throw Failure(code: "AMBIGUOUS_GROUP", message: "The native Safari group title must identify exactly one group in this window's current profile.")
        }
    }

    private func requireUnused(_ title: String, except current: String?, among titles: [String]) throws {
        guard title == current || !titles.contains(title) else {
            throw Failure(code: "GROUP_TITLE_EXISTS", message: "A native Safari Tab Group already uses this title.")
        }
    }

    private func selectedTab(_ context: Context) throws -> AXUIElement {
        let tabs = nativeTabs(context)
        guard let index = context.request.tabIndex, tabs.indices.contains(index) else {
            throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "The fresh tab index must identify a visible native Safari tab. Safari may hide the tab bar for a single tab.")
        }
        let tab = tabs[index]
        let identifier = string(tab, kAXIdentifierAttribute) ?? ""
        let titles = nativeNodes(tab).filter { string($0, kAXIdentifierAttribute) == "UnifiedTabBarButton._titleTextField" }
        guard identifier.contains("isActive=true"), !identifier.contains("isPinned=true"),
              !identifier.contains("isCluster=true"), titles.count == 1,
              string(titles[0], kAXValueAttribute) == context.request.tabTitle else {
            throw Failure(code: "TAB_CHANGED", message: "The selected native Safari tab, title, or tab order changed. Pinned or clustered tabs are not supported.")
        }
        return tab
    }

    private func nativeTabs(_ context: Context) -> [AXUIElement] {
        nativeNodes(context.window).filter { (string($0, kAXIdentifierAttribute) ?? "").hasPrefix("TabBarTab?") }
    }

    private func observedSelectedTab(_ context: Context, isAuthorized: () -> Bool) throws -> SelectedTab {
        try stable(context, isAuthorized: isAuthorized, requirePage: false)
        return try rawSelectedTab(context)
    }

    private func rawSelectedTab(_ context: Context) throws -> SelectedTab {
        let tabs = nativeTabs(context).map { tab -> (identifier: String, title: String?) in
            let fields = nativeNodes(tab).filter { string($0, kAXIdentifierAttribute) == "UnifiedTabBarButton._titleTextField" }
            return (string(tab, kAXIdentifierAttribute) ?? "", fields.count == 1 ? string(fields[0], kAXValueAttribute) : nil)
        }
        return try Self.selectedTabIdentity(tabs, pageURLs: pageURLs(context.window))
    }

    private func tabBarMenuItem(_ context: Context, isAuthorized: () -> Bool,
                                actions: inout Int, requirePage: Bool, requireEnabled: Bool = true) throws -> AXUIElement {
        // These are Safari's native identifiers observed in its real View menu.
        let menus = nativeNodes(context.app).filter { string($0, kAXIdentifierAttribute) == "SafariViewMenu" }
        guard menus.count == 1 else {
            throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "Safari did not expose its native View menu for showing the hidden tab bar.")
        }
        try press(menus[0], context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: requirePage)
        let item = try waitForIdentifier("AlwaysShowTabBar", context: context, isAuthorized: isAuthorized)
        guard !requireEnabled || bool(item, kAXEnabledAttribute) == true else {
            _ = AXUIElementPerformAction(menus[0], kAXCancelAction as CFString)
            throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "Safari disabled View > Always Show Tab Bar for the selected native window.")
        }
        return item
    }

    private func tabBarPreference(_ item: AXUIElement) throws -> Bool {
        var rawMark: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(item, kAXMenuItemMarkCharAttribute as CFString, &rawMark)
        return try Self.tabBarPreference(mark: rawMark as? String, status: status)
    }

    private func showHiddenTabBar(_ context: Context, isAuthorized: () -> Bool,
                                  actions: inout Int, revealed: inout Bool, requirePage: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard nativeTabs(context).isEmpty else { return }
        defer { cancelViewMenu(context) }
        let item = try tabBarMenuItem(context, isAuthorized: isAuthorized, actions: &actions, requirePage: requirePage)
        guard try !tabBarPreference(item) else {
            throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "Safari already enables its native tab bar but did not expose a selectable tab.")
        }
        // Do not retry this preference mutation, even if observation times out.
        revealed = true
        try press(item, context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: requirePage)
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
            if !nativeTabs(context).isEmpty { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "Safari did not expose the native tab after showing its tab bar. No group mutation was sent.")
    }

    private func restoreHiddenTabBar(_ context: Context, isAuthorized: () -> Bool,
                                     actions: inout Int) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: false)
        defer { cancelViewMenu(context) }
        let item = try tabBarMenuItem(context, isAuthorized: isAuthorized, actions: &actions,
                                      requirePage: false, requireEnabled: false)
        // Multiple tabs force a visible bar regardless of this preference.
        // Only its native menu state establishes whether our change remains.
        guard try tabBarPreference(item) else { return }
        guard bool(item, kAXEnabledAttribute) == true else {
            throw Failure(code: "TAB_BAR_RESTORE_UNCONFIRMED", message: "Safari currently disables restoring the changed tab bar preference. No collection was switched for cleanup.")
        }
        try press(item, context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        cancelViewMenu(context)
        let verification = try tabBarMenuItem(context, isAuthorized: isAuthorized, actions: &actions,
                                              requirePage: false, requireEnabled: false)
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            if try !tabBarPreference(verification) { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "TAB_BAR_RESTORE_UNCONFIRMED", message: "Safari's native View menu did not confirm restoring the original tab bar preference. The group action was not replayed.")
    }

    private func cancelViewMenu(_ context: Context) {
        for node in nativeNodes(context.app) where string(node, kAXIdentifierAttribute) == "SafariViewMenu" {
            _ = AXUIElementPerformAction(node, kAXCancelAction as CFString)
        }
    }

    private func groupTitles(_ context: Context, isAuthorized: () -> Bool, actions: inout Int,
                             requirePage: Bool = true) throws -> [String] {
        let originalGroup = try currentGroupTitle(context)
        let originalPages = pageURLs(context.window)
        // Safari retains a nonzero-frame, non-interactive picker in AX while its
        // native sidebar is open. The one inventory path uses the real visible
        // picker with the sidebar temporarily hidden, then restores that layout.
        let restoreSidebar = nativeSidebarVisible(context)
        var sidebarRestoreAttempted = false
        if restoreSidebar {
            try setNativeSidebarVisible(false, context: context, isAuthorized: isAuthorized,
                                        actions: &actions, requirePage: requirePage)
        }
        defer {
            if restoreSidebar, !sidebarRestoreAttempted {
                try? setNativeSidebarVisible(true, context: context, isAuthorized: isAuthorized,
                                             actions: &actions, requirePage: requirePage)
            }
        }
        let picker = try picker(context)
        try nativeClick(picker, button: .left, context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: requirePage)
        var dismissalAttempted = false
        defer {
            if !dismissalAttempted { try? dismissMenus(context, isAuthorized: isAuthorized, actions: &actions) }
        }
        let menu = try waitForIdentifier("TabGroupPickerMenu", context: context, isAuthorized: isAuthorized)
        // The menu container alone does not establish a complete inventory.
        // Observe that same delivered menu until its current group is present;
        // never reopen it or treat an incomplete empty list as an inventory.
        let deadline = Date().addingTimeInterval(2)
        var titles: [String] = []
        while true {
            try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
            let items = nativeNodes(menu).compactMap { item -> (identifier: String, title: String?)? in
                guard let identifier = string(item, kAXIdentifierAttribute) else { return nil }
                return (identifier, string(item, kAXTitleAttribute))
            }
            do {
                titles = try Self.groupInventory(items, currentGroup: originalGroup)
                break
            } catch let failure as Failure where failure.code == "GROUP_INVENTORY_INCOMPLETE" && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.04)
            }
        }
        dismissalAttempted = true
        try dismissMenus(context, isAuthorized: isAuthorized, actions: &actions)
        if restoreSidebar {
            sidebarRestoreAttempted = true
            try setNativeSidebarVisible(true, context: context, isAuthorized: isAuthorized,
                                        actions: &actions, requirePage: requirePage)
        }
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard try currentGroupTitle(context) == originalGroup, pageURLs(context.window) == originalPages else {
            throw Failure(code: "GROUP_READ_CHANGED_SELECTION", message: "Safari changed its selected native group or page while reading the group picker. Inspect fresh state before continuing.")
        }
        return titles
    }

    private func currentGroupTitle(_ context: Context) throws -> String? {
        let title = Self.groupTitle(string(try picker(context), kAXIdentifierAttribute) ?? "")
        guard let title else { throw Failure(code: "GROUP_IDENTITY_UNAVAILABLE", message: "Safari did not expose the selected native Tab Group identity.") }
        return title.isEmpty ? nil : title
    }

    private func picker(_ context: Context) throws -> AXUIElement {
        let matches = nativeNodes(context.window).filter {
            Self.groupTitle(string($0, kAXIdentifierAttribute) ?? "") != nil && frame($0).map { !$0.isEmpty } == true
        }
        guard let first = matches.first,
              Set(matches.compactMap { string($0, kAXIdentifierAttribute) }).count == 1 else {
            throw Failure(code: "GROUP_IDENTITY_UNAVAILABLE", message: "Safari did not expose one selected Tab Group picker.")
        }
        return first
    }

    private func nativeSidebarVisible(_ context: Context) -> Bool {
        nativeNodes(context.window).contains {
            string($0, kAXIdentifierAttribute) == "NewTabGroupButton" && nativeTargetVisible($0, context: context)
        }
    }

    private func setNativeSidebarVisible(_ visible: Bool, context: Context, isAuthorized: () -> Bool,
                                         actions: inout Int, requirePage: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard nativeSidebarVisible(context) != visible else { return }
        let originalGroup = try currentGroupTitle(context)
        let originalPages = pageURLs(context.window)
        let toggles = nativeNodes(context.window).filter {
            string($0, kAXIdentifierAttribute) == "SidebarButton" && nativeTargetVisible($0, context: context)
        }
        guard toggles.count == 1 else {
            throw Failure(code: "GROUP_UI_UNAVAILABLE", message: "Safari did not expose exactly one visible native sidebar toggle.")
        }
        // Moving a tab can remove the menu's original window AX subtree before
        // native menu tracking finishes. Do not let the next toolbar click be
        // consumed merely as an outside click that dismisses that menu.
        try waitForMenuDismissal(context, isAuthorized: isAuthorized, stage: "sidebar_preflight")
        try nativeClick(toggles[0], button: .left, context: context, isAuthorized: isAuthorized,
                        actions: &actions, requirePage: requirePage)
        let deadline = Date().addingTimeInterval(2)
        var sidebarHit = false, pickerHit = false
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
            pickerHit = nativeNodes(context.window).contains {
                Self.groupTitle(string($0, kAXIdentifierAttribute) ?? "") != nil && nativeTargetVisible($0, context: context)
            }
            sidebarHit = nativeSidebarVisible(context)
            if Self.sidebarLayoutConfirmed(requestedVisible: visible, sidebarHit: sidebarHit, pickerHit: pickerHit) {
                guard try currentGroupTitle(context) == originalGroup, pageURLs(context.window) == originalPages else {
                    throw Failure(code: "GROUP_READ_CHANGED_SELECTION", message: "Safari changed its selected group or page while changing the native sidebar layout.")
                }
                return
            }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        var diagnostics = nativeMenuState(context).data
        diagnostics["stage"] = "sidebar_layout_confirmation"
        diagnostics["requestedVisible"] = visible
        diagnostics["sidebarHit"] = sidebarHit
        diagnostics["pickerHit"] = pickerHit
        diagnostics["newTabGroupButtonPresent"] = nativeNodes(context.window).contains { string($0, kAXIdentifierAttribute) == "NewTabGroupButton" }
        diagnostics["sidebarToggleHitCount"] = min(8, nativeNodes(context.window).filter {
            string($0, kAXIdentifierAttribute) == "SidebarButton" && nativeTargetVisible($0, context: context)
        }.count)
        throw Failure(code: "GROUP_UI_UNAVAILABLE", message: "Safari did not confirm the requested native sidebar layout. No group action was replayed.", details: diagnostics)
    }

    private func groupRow(_ title: String, context: Context, isAuthorized: () -> Bool, actions: inout Int) throws -> AXUIElement {
        try setNativeSidebarVisible(true, context: context, isAuthorized: isAuthorized, actions: &actions)
        let rows = matchingGroupRows(title, context: context)
        guard rows.count == 1, let row = rows.first else {
            throw Failure(code: "GROUP_UI_UNAVAILABLE", message: "Safari's sidebar did not expose exactly one matching native group row.")
        }
        return row
    }

    private func matchingGroupRows(_ title: String, context: Context) -> [AXUIElement] {
        nativeNodes(context.window).filter { row in
            guard string(row, kAXRoleAttribute) == kAXRowRole else { return false }
            if string(row, kAXValueAttribute) == title { return true }
            return nativeNodes(row).contains {
                string($0, kAXIdentifierAttribute) == "LibraryItemCellTextField" && string($0, kAXValueAttribute) == title
            }
        }
    }

    private func requireUnshared(_ title: String, context: Context, isAuthorized: () -> Bool, actions: inout Int) throws {
        let originalGroup = try currentGroupTitle(context)
        let originalPages = pageURLs(context.window)
        let row = try groupRow(title, context: context, isAuthorized: isAuthorized, actions: &actions)
        try rightClick(row, context: context, isAuthorized: isAuthorized, actions: &actions)
        defer { cancelMenu(context) }
        let menu = try waitForIdentifier("SafariContextMenu", context: context, isAuthorized: isAuthorized)
        guard nativeNodes(menu).contains(where: { string($0, kAXIdentifierAttribute) == "ShareTabGroup" && bool($0, kAXEnabledAttribute) == true }) else {
            throw Failure(code: "GROUP_SHARING_UNVERIFIED", message: "Safari did not verify that this Tab Group is unshared. Shared or unknown groups cannot be changed.")
        }
        try dismissMenus(context, isAuthorized: isAuthorized, actions: &actions)
        try stable(context, isAuthorized: isAuthorized)
        guard try currentGroupTitle(context) == originalGroup, pageURLs(context.window) == originalPages else {
            throw Failure(code: "GROUP_READ_CHANGED_SELECTION", message: "Safari changed its selected native group or page while checking group sharing. No group mutation was sent.")
        }
    }

    private func renameGroup(_ context: Context, currentTitle: String, newTitle: String,
                             isAuthorized: () -> Bool, actions: inout Int, mutationApplied: inout Bool) throws {
        let changesSelectedCollection = try currentGroupTitle(context) == currentTitle
        let row = try groupRow(currentTitle, context: context, isAuthorized: isAuthorized, actions: &actions)
        try rightClick(row, context: context, isAuthorized: isAuthorized, actions: &actions)
        defer { cancelMenu(context) }
        let menu = try waitForIdentifier("SafariContextMenu", context: context, isAuthorized: isAuthorized)
        let nodes = nativeNodes(menu)
        guard nodes.contains(where: { string($0, kAXIdentifierAttribute) == "ShareTabGroup" && bool($0, kAXEnabledAttribute) == true }),
              let rename = nodes.first(where: { string($0, kAXIdentifierAttribute) == "RenameTabGroupMenuItem" }) else {
            throw Failure(code: "GROUP_SHARING_UNVERIFIED", message: "Safari did not expose an unshared group with a native rename action.")
        }
        try press(rename, context: context, isAuthorized: isAuthorized, actions: &actions)
        let field = try waitForNameEditor(context, isAuthorized: isAuthorized)
        guard string(field, kAXValueAttribute) == currentTitle, isDescendant(field, of: row) else {
            throw Failure(code: "GROUP_CHANGED", message: "Safari opened a different group name editor. No new name was entered.")
        }
        mutationApplied = true
        try setName(field, currentTitle: currentTitle, title: newTitle, context: context,
                    isAuthorized: isAuthorized, actions: &actions, groupRow: row,
                    changesSelectedCollection: changesSelectedCollection)
        if changesSelectedCollection {
            try waitForGroup(newTitle, context: context, isAuthorized: isAuthorized)
            context.expectedSelection = ExpectedSelection(groupTitle: newTitle, tab: try rawSelectedTab(context))
        }
        try waitForRenamedRow(row, previousTitle: currentTitle, title: newTitle, context: context, isAuthorized: isAuthorized)
    }

    private func setName(_ field: AXUIElement, currentTitle: String, title: String, context: Context,
                         isAuthorized: () -> Bool, actions: inout Int, groupRow: AXUIElement? = nil,
                         changesSelectedCollection: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized)
        let selectedGroupBefore = try currentGroupTitle(context)
        guard (!changesSelectedCollection || selectedGroupBefore == currentTitle),
              let focused = element(context.app, kAXFocusedUIElementAttribute), CFEqual(focused, field),
              string(field, kAXValueAttribute) == currentTitle,
              groupRow.map({ isDescendant(field, of: $0) }) != false else {
            throw Failure(code: "GROUP_CHANGED", message: "The native group or its focused name editor changed before naming. No name was entered.")
        }
        if changesSelectedCollection { context.expectedSelection = nil }
        actions += 1
        guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, title as CFString) == .success else {
            throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "Safari did not accept the native group name. Inspect its current group state before continuing.")
        }
        try stable(context, isAuthorized: isAuthorized)
        let current = try currentGroupTitle(context)
        let validSelection = changesSelectedCollection ? (current == currentTitle || current == title) : current == selectedGroupBefore
        guard let focused = element(context.app, kAXFocusedUIElementAttribute), CFEqual(focused, field),
              string(field, kAXValueAttribute) == title, validSelection,
              groupRow.map({ isDescendant(field, of: $0) }) != false else {
            throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "Safari's native group name editor lost focus. The pending name was not committed by this helper.")
        }
        try key(36, context: context, isAuthorized: isAuthorized, actions: &actions)
    }

    private func waitForRenamedRow(_ targetRow: AXUIElement, previousTitle: String, title: String,
                                   context: Context, isAuthorized: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized)
            let rows = matchingGroupRows(title, context: context)
            let focused = element(context.app, kAXFocusedUIElementAttribute)
            let editingName = focused.map { string($0, kAXIdentifierAttribute) == "LibraryItemCellTextField" } ?? false
            let oldNameAbsent = previousTitle == title || matchingGroupRows(previousTitle, context: context).isEmpty
            if rows.count == 1, CFEqual(rows[0], targetRow), nativeTargetVisible(rows[0], context: context),
               oldNameAbsent, !editingName { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "Safari did not commit the name on the exact native group row. Its current collection was not switched.")
    }

    private func selectGroup(_ title: String, context: Context, isAuthorized: () -> Bool, actions: inout Int) throws {
        try setNativeSidebarVisible(false, context: context, isAuthorized: isAuthorized, actions: &actions)
        try nativeClick(try picker(context), button: .left, context: context, isAuthorized: isAuthorized, actions: &actions)
        defer { cancelMenu(context) }
        let menu = try waitForIdentifier("TabGroupPickerMenu", context: context, isAuthorized: isAuthorized)
        let matches = nativeNodes(menu).filter { string($0, kAXIdentifierAttribute) == title + "TabGroupPickerMenuItem" }
        guard matches.count == 1 else { throw Failure(code: "AMBIGUOUS_GROUP", message: "The native group destination changed before selection.") }
        try stable(context, isAuthorized: isAuthorized)
        context.expectedSelection = nil
        try press(matches[0], context: context, isAuthorized: isAuthorized, actions: &actions)
        try waitForGroup(title, context: context, isAuthorized: isAuthorized)
        if !nativeTabs(context).isEmpty {
            context.expectedSelection = ExpectedSelection(groupTitle: title, tab: try rawSelectedTab(context))
        }
    }

    private func selectCollection(_ title: String?, context: Context, isAuthorized: () -> Bool,
                                  actions: inout Int, revealedTabBar: inout Bool) throws {
        // The expected post-mutation collection and exact active page remain
        // guarded until the single intentional source-selection action below.
        try stable(context, isAuthorized: isAuthorized, requirePage: false)
        try setNativeSidebarVisible(false, context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        try nativeClick(try picker(context), button: .left, context: context, isAuthorized: isAuthorized,
                        actions: &actions, requirePage: false)
        defer { cancelMenu(context) }
        let menu = try waitForIdentifier("TabGroupPickerMenu", context: context, isAuthorized: isAuthorized)
        let itemID = title.map { $0 + "TabGroupPickerMenuItem" } ?? "LocalTabGroupPickerMenuItem"
        let matches = nativeNodes(menu).filter { string($0, kAXIdentifierAttribute) == itemID }
        guard matches.count == 1 else {
            throw Failure(code: "SOURCE_COLLECTION_NOT_RESTORED", message: "Safari did not expose exactly one original source collection. No source selection was sent.")
        }
        try stable(context, isAuthorized: isAuthorized, requirePage: false)
        context.expectedSelection = nil
        try press(matches[0], context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        try waitForGroup(title, context: context, isAuthorized: isAuthorized)
        try waitForMenuDismissal(context, isAuthorized: isAuthorized)
        if nativeTabs(context).isEmpty {
            try showHiddenTabBar(context, isAuthorized: isAuthorized, actions: &actions,
                                 revealed: &revealedTabBar, requirePage: false)
        }
        context.expectedSelection = ExpectedSelection(groupTitle: title, tab: try rawSelectedTab(context))
    }

    private func makeContext(_ request: Request, isAuthorized: () -> Bool) throws -> Context {
        guard isAuthorized() else { throw Failure(code: "OWNER_CHANGED", message: "The owning Safari agent session was cancelled.") }
        guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else {
            throw Failure(code: "ACCESSIBILITY_PERMISSION_REQUIRED", message: "Allow ChatGPT for Safari Accessibility access before organizing native tabs.")
        }
        let front = onMain { NSWorkspace.shared.frontmostApplication }
        guard let front, isAppleSafari(front) else { throw Failure(code: "SAFARI_NOT_FRONTMOST", message: "The selected Apple Safari window must remain frontmost.") }
        let app = AXUIElementCreateApplication(front.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 0.5)
        guard let window = element(app, kAXFocusedWindowAttribute),
              let identifier = string(window, kAXIdentifierAttribute).flatMap(Self.windowIdentifier) else {
            throw Failure(code: "WINDOW_IDENTITY_UNAVAILABLE", message: "Safari did not expose the focused native window identity.")
        }
        if let expected = request.expectedWindowIdentifier, identifier != expected {
            throw Failure(code: "WINDOW_CHANGED", message: "The native Safari window identity changed.")
        }
        let context = Context(request: request, pid: front.processIdentifier, app: app, window: window, windowIdentifier: identifier)
        try stable(context, isAuthorized: isAuthorized)
        guard nativeNodes(app).allSatisfy({ string($0, kAXIdentifierAttribute) != "SafariContextMenu" && string($0, kAXIdentifierAttribute) != "TabGroupPickerMenu" }) else {
            throw Failure(code: "NATIVE_MENU_ALREADY_OPEN", message: "Close the existing Safari native menu before organizing tabs.")
        }
        return context
    }

    private func stable(_ context: Context, isAuthorized: () -> Bool, requirePage: Bool = true) throws {
        guard isAuthorized() else { throw Failure(code: "OWNER_CHANGED", message: "The owning Safari agent session was cancelled. Delivered actions must not be replayed.") }
        let session = SafariLiveInput.sessionStatus(CGSessionCopyCurrentDictionary() as? [String: Any])
        guard session["screenLocked"] != true else { throw Failure(code: "SESSION_LOCKED", message: "Unlock this Mac before organizing Safari tabs.") }
        let system = AXUIElementCreateSystemWide()
        var pid: pid_t = 0
        let front = onMain({ NSWorkspace.shared.frontmostApplication })
        let signedSafari = front.map { isAppleSafari($0) } ?? false
        let axFront = element(system, kAXFocusedApplicationAttribute)
        let axPIDStatus: AXError = axFront.map { AXUIElementGetPid($0, &pid) } ?? .noValue
        let focusedWindow = element(context.app, kAXFocusedWindowAttribute)
        let currentIdentifier = focusedWindow.flatMap { string($0, kAXIdentifierAttribute).flatMap(Self.windowIdentifier) }
        let currentBounds = focusedWindow.flatMap { frame($0) }
        let sameWindow = focusedWindow.map { CFEqual($0, context.window) } ?? false
        let matchingBounds = currentBounds.map { close($0, context.request.target.windowBounds) } ?? false
        guard let front, front.processIdentifier == context.pid, signedSafari, axFront != nil,
              axPIDStatus == .success, pid == context.pid,
              let window = focusedWindow, sameWindow,
              currentIdentifier == context.windowIdentifier, currentBounds != nil, matchingBounds else {
            // One bounded observation of identity/focus only. Never include page
            // URLs, titles, application names, credentials, or session tokens.
            let diagnostics: [String: Any] = [
                "expectedNativeWindowIdentifier": context.windowIdentifier,
                "currentNativeWindowIdentifier": currentIdentifier as Any? ?? NSNull(),
                "expectedWindowBounds": Self.diagnosticBounds(context.request.target.windowBounds) as Any? ?? NSNull(),
                "currentWindowBounds": currentBounds.flatMap(Self.diagnosticBounds) as Any? ?? NSNull(),
                "focusedWindowAvailable": focusedWindow != nil,
                "focusedWindowCFEqual": sameWindow,
                "nativeWindowIdentifierMatches": currentIdentifier == context.windowIdentifier,
                "windowBoundsMatch": matchingBounds,
                "nsWorkspaceSelectedSafari": front?.processIdentifier == context.pid,
                "nsWorkspaceAppleSafariVerified": signedSafari,
                "axFocusedApplicationAvailable": axFront != nil,
                "axFocusedApplicationPIDReadStatus": axPIDStatus.rawValue,
                "axFocusedApplicationIsSelectedSafari": axPIDStatus == .success && pid == context.pid
            ]
            throw Failure(code: "FOCUS_CHANGED", message: "Safari's foreground process, focused window, or window bounds changed. Stop and inspect fresh state.", details: diagnostics)
        }
        if requirePage, pageURLs(window) != [context.request.target.expectedURL] {
            throw Failure(code: "PAGE_CHANGED", message: "The selected Safari page changed before the native organization action.")
        }
        if let expected = context.expectedSelection {
            let selected: SelectedTab?
            if nativeTabs(context).isEmpty { selected = nil }
            else { selected = try rawSelectedTab(context) }
            let group = try currentGroupTitle(context)
            try Self.validateExpectedSelection(groupTitle: group, selectedTab: selected,
                                               pageURLs: pageURLs(window), expectedGroupTitle: expected.groupTitle,
                                               expectedTab: expected.tab)
        }
        for source in [CGEventSourceStateID.combinedSessionState, .hidSystemState] {
            let flags = CGEventSource.flagsState(source)
            guard flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty,
                  !CGEventSource.buttonState(source, button: .left), !CGEventSource.buttonState(source, button: .right) else {
                throw Failure(code: "USER_INPUT_ACTIVE", message: "Release keyboard modifiers and mouse buttons before organizing Safari tabs.")
            }
        }
    }

    private func rightClick(_ node: AXUIElement, context: Context, isAuthorized: () -> Bool, actions: inout Int) throws {
        try nativeClick(node, button: .right, context: context, isAuthorized: isAuthorized, actions: &actions)
    }

    private func nativeClick(_ node: AXUIElement, button: CGMouseButton, context: Context,
                             isAuthorized: () -> Bool, actions: inout Int, requirePage: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard let rect = frame(node), !rect.isEmpty,
              context.request.target.windowBounds.contains(CGPoint(x: rect.midX, y: rect.midY)),
              let source = CGEventSource(stateID: .hidSystemState) else {
            throw Failure(code: "NATIVE_TARGET_UNAVAILABLE", message: "The native Safari tab or group row is not visible inside the selected window.")
        }
        let point = CGPoint(x: rect.midX, y: rect.midY)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(context.app, Float(point.x), Float(point.y), &hit) == .success,
              let hit, isDescendant(hit, of: node) else {
            throw Failure(code: "NATIVE_TARGET_OBSCURED", message: "The native Safari tab or group row is covered by a different control.")
        }
        let downType: CGEventType = button == .left ? .leftMouseDown : .rightMouseDown
        let upType: CGEventType = button == .left ? .leftMouseUp : .rightMouseUp
        guard let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: button),
              let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
              let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else {
            throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not construct the native Safari pointer and click events.")
        }
        // Match the existing trusted-input backend: update the real pointer,
        // then deliver one click through HID to the verified foreground Safari.
        for event in [move, down, up] {
            event.flags = []
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            actions += 1
            event.post(tap: .cghidEventTap)
        }
    }

    private func nativeTargetVisible(_ node: AXUIElement, context: Context) -> Bool {
        guard let rect = frame(node), !rect.isEmpty,
              context.request.target.windowBounds.contains(CGPoint(x: rect.midX, y: rect.midY)) else { return false }
        var hit: AXUIElement?
        return AXUIElementCopyElementAtPosition(context.app, Float(rect.midX), Float(rect.midY), &hit) == .success &&
            hit.map { isDescendant($0, of: node) } == true
    }

    private func key(_ code: CGKeyCode, context: Context, isAuthorized: () -> Bool,
                     actions: inout Int, requirePage: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not construct the native Safari group-name commit event.")
        }
        for event in [down, up] {
            event.flags = []
            actions += 1
            event.post(tap: .cghidEventTap)
        }
    }

    private func press(_ node: AXUIElement, context: Context, isAuthorized: () -> Bool,
                       actions: inout Int, requirePage: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard bool(node, kAXEnabledAttribute) != false else { throw Failure(code: "NATIVE_ACTION_DISABLED", message: "Safari disabled the requested native action.") }
        actions += 1
        guard AXUIElementPerformAction(node, kAXPressAction as CFString) == .success else {
            throw Failure(code: "NATIVE_ACTION_UNCONFIRMED", message: "Safari did not confirm the native action. Inspect fresh state; do not replay the delivered action.")
        }
    }

    private func waitForIdentifier(_ identifier: String, context: Context, isAuthorized: () -> Bool) throws -> AXUIElement {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            let root = identifier == "AlwaysShowTabBar" ? context.app : context.window
            let matches = nativeNodes(root).filter { string($0, kAXIdentifierAttribute) == identifier }
            if matches.count == 1 { return matches[0] }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "NATIVE_UI_UNAVAILABLE", message: "Safari did not expose the expected native group control after the delivered action. Do not replay it.")
    }

    private func waitForNameEditor(_ context: Context, isAuthorized: () -> Bool) throws -> AXUIElement {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized)
            if let focused = element(context.app, kAXFocusedUIElementAttribute),
               string(focused, kAXIdentifierAttribute) == "LibraryItemCellTextField",
               isDescendant(focused, of: context.window) { return focused }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "GROUP_EDITOR_UNAVAILABLE", message: "Safari did not focus the native group name editor. Inspect its current group state; do not replay the mutation.")
    }

    private func waitForGroup(_ title: String?, context: Context, isAuthorized: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            if try currentGroupTitle(context) == title { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "GROUP_RESULT_UNCONFIRMED", message: "Safari did not expose the requested selected group title. Inspect its current state; do not replay the mutation.")
    }

    private func waitForMenuDismissal(_ context: Context, isAuthorized: () -> Bool, stage: String = "menu_completion") throws {
        let deadline = Date().addingTimeInterval(2)
        var state = nativeMenuState(context)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            state = nativeMenuState(context)
            if Self.menuCompletionConfirmed(visibleNativeMenu: state.visible, nativeMenuFocused: state.menuFocused) { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        var diagnostics = state.data
        diagnostics["stage"] = stage
        throw Failure(code: "GROUP_RESULT_UNCONFIRMED", message: "Safari did not finish its native menu interaction after delivery. Inspect fresh state; do not replay the mutation.", details: diagnostics)
    }

    private func nativeMenuState(_ context: Context) -> NativeMenuState {
        // Check real application-level menu surfaces, not the moved tab's old
        // AX subtree. Hit testing excludes retained, non-interactive AX stubs.
        let nodes = nativeNodes(context.app)
        let menus = nodes.filter { string($0, kAXRoleAttribute) == kAXMenuRole && nativeMenuVisible($0, context: context) }
        let contextVisible = menus.contains { string($0, kAXIdentifierAttribute) == "SafariContextMenu" }
        let pickerVisible = menus.contains { string($0, kAXIdentifierAttribute) == "TabGroupPickerMenu" }
        let viewOwners = nodes.filter { string($0, kAXIdentifierAttribute) == "SafariViewMenu" }
        let viewVisible = menus.contains { menu in viewOwners.contains { isDescendant(menu, of: $0) } }
        let otherVisible = menus.contains { menu in
            !["SafariContextMenu", "TabGroupPickerMenu"].contains(string(menu, kAXIdentifierAttribute) ?? "") &&
                !viewOwners.contains { isDescendant(menu, of: $0) }
        }
        let focusedRole = element(context.app, kAXFocusedUIElementAttribute).flatMap { string($0, kAXRoleAttribute) }
        let menuFocused = [kAXMenuRole, kAXMenuItemRole, kAXMenuBarItemRole].contains(focusedRole ?? "")
        return NativeMenuState(contextVisible: contextVisible, pickerVisible: pickerVisible,
                               viewVisible: viewVisible, otherVisible: otherVisible, menuFocused: menuFocused)
    }

    private func nativeMenuVisible(_ node: AXUIElement, context: Context) -> Bool {
        guard let rect = frame(node), !rect.isEmpty else { return false }
        let intersection = rect.intersection(context.request.target.windowBounds)
        guard !intersection.isNull, !intersection.isEmpty else { return false }
        var hit: AXUIElement?
        return AXUIElementCopyElementAtPosition(context.app, Float(intersection.midX), Float(intersection.midY), &hit) == .success &&
            hit.map { isDescendant($0, of: node) } == true
    }

    private func dismissMenus(_ context: Context, isAuthorized: () -> Bool, actions: inout Int) throws {
        guard nativeNodes(context.window).contains(where: { ["SafariContextMenu", "TabGroupPickerMenu"].contains(string($0, kAXIdentifierAttribute) ?? "") }) else { return }
        // AXCancel on Safari's picker returned without closing the real menu.
        // Deliver Escape once to the already-verified native Safari window.
        try key(53, context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        try waitForMenuDismissal(context, isAuthorized: isAuthorized)
    }

    private func cancelMenu(_ context: Context) {
        // Cancel only a menu opened by this helper, never change the selected tab.
        for node in nativeNodes(context.window) where ["SafariContextMenu", "TabGroupPickerMenu"].contains(string(node, kAXIdentifierAttribute) ?? "") {
            _ = AXUIElementPerformAction(node, kAXCancelAction as CFString)
        }
    }

    private func nativeNodes(_ root: AXUIElement) -> [AXUIElement] {
        var result: [AXUIElement] = [], pending: [(AXUIElement, Int)] = [(root, 0)]
        while let (node, depth) = pending.popLast(), result.count < 4096 {
            // A page must never supply names or identifiers for native controls.
            if string(node, kAXRoleAttribute) == "AXWebArea" { continue }
            result.append(node)
            if depth < 40, let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
                pending.append(contentsOf: children.reversed().map { ($0, depth + 1) })
            }
        }
        return result
    }

    private func pageURLs(_ window: AXUIElement) -> [String] {
        var urls: [String] = [], pending: [(AXUIElement, Int)] = [(window, 0)], visited = 0
        while let (node, depth) = pending.popLast(), visited < 4096 {
            visited += 1
            if string(node, kAXRoleAttribute) == "AXWebArea" {
                if let url = attribute(node, kAXURLAttribute) as? URL { urls.append(url.absoluteString) }
                else if let url = string(node, kAXURLAttribute) { urls.append(url) }
                continue
            }
            if depth < 40, let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
                pending.append(contentsOf: children.map { ($0, depth + 1) })
            }
        }
        return urls
    }

    private func isDescendant(_ child: AXUIElement, of ancestor: AXUIElement) -> Bool {
        var current: AXUIElement? = child
        for _ in 0..<40 {
            guard let node = current else { return false }
            if CFEqual(node, ancestor) { return true }
            current = element(node, kAXParentAttribute)
        }
        return false
    }

    private func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil
    }
    private func string(_ node: AXUIElement, _ name: String) -> String? { attribute(node, name) as? String }
    private func bool(_ node: AXUIElement, _ name: String) -> Bool? { attribute(node, name) as? Bool }
    private func element(_ node: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(node, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }
    private func frame(_ node: AXUIElement) -> CGRect? {
        guard let rawPosition = attribute(node, kAXPositionAttribute), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
              let rawSize = attribute(node, kAXSizeAttribute), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(rawPosition, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(rawSize, to: AXValue.self), .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    private func close(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.minX - rhs.minX) <= 8 && abs(lhs.minY - rhs.minY) <= 8 && abs(lhs.width - rhs.width) <= 8 && abs(lhs.height - rhs.height) <= 8
    }
    private static func diagnosticBounds(_ rect: CGRect) -> [String: Double]? {
        let values = [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
        guard values.allSatisfy({ $0.isFinite && abs($0) <= 100_000 }) else { return nil }
        return ["left": values[0], "top": values[1], "width": values[2], "height": values[3]]
    }
    private func onMain<T>(_ body: () -> T) -> T { Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body) }
    private func isAppleSafari(_ app: NSRunningApplication) -> Bool {
        guard app.bundleIdentifier == "com.apple.Safari", !app.isTerminated else { return false }
        var code: SecCode?, requirement: SecRequirement?
        return SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: app.processIdentifier] as CFDictionary, [], &code) == errSecSuccess &&
            SecRequirementCreateWithString("anchor apple and identifier \"com.apple.Safari\"" as CFString, [], &requirement) == errSecSuccess &&
            code != nil && requirement != nil && SecCodeCheckValidity(code!, [], requirement!) == errSecSuccess
    }
}
