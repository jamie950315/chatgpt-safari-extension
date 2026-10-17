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
    }

    struct SelectedTab: Equatable {
        let index: Int
        let title: String
        let url: String

        var data: [String: Any] { ["index": index, "title": title, "url": url] }
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
                  ["inspect", "createGroup", "moveToGroup", "moveToUngrouped", "renameGroup", "selectGroup"].contains(action) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected inspect, createGroup, moveToGroup, moveToUngrouped, renameGroup, or selectGroup.")
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

    private struct Context {
        let request: Request
        let pid: pid_t
        let app: AXUIElement
        let window: AXUIElement
        let windowIdentifier: String
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
                if let failure = error as? Failure { code = failure.code; message = failure.message }
                else if let failure = error as? SafariLiveInput.Failure { code = failure.code; message = failure.message }
                else { code = "NATIVE_ORGANIZATION_FAILED"; message = "Native Safari tab organization failed." }
                var details: [String: Any] = ["code": code, "message": message,
                    "actionsPerformed": actions, "mayHavePostedInput": actions > 0,
                    "mutationApplied": mutationApplied, "doNotReplay": actions > 0]
                if let tabBarRestoration { details["tabBarRestoration"] = tabBarRestoration }
                if let sidebarRestoration { details["nativeSidebarRestoration"] = sidebarRestoration }
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

    private func perform(_ context: Context, isAuthorized: () -> Bool,
                         actions: inout Int, mutationApplied: inout Bool,
                         tabBarRestoration: inout String?, sidebarRestoration: inout String?) throws -> [String: Any] {
        let request = context.request
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
        let groups = try groupTitles(context, isAuthorized: isAuthorized, actions: &actions)
        var destination: String? = initialGroup
        switch request.action {
        case "inspect": break
        case "selectGroup":
            let title = request.groupTitle!
            try requireUnique(title, among: groups)
            try requireUnshared(title, context: context, isAuthorized: isAuthorized, actions: &actions)
            try selectGroup(title, context: context, isAuthorized: isAuthorized, actions: &actions)
            destination = title
        case "renameGroup":
            guard initialGroup == request.groupTitle else {
                throw Failure(code: "GROUP_CHANGED", message: "The selected native Safari Tab Group changed before rename.")
            }
            try requireUnique(request.groupTitle!, among: groups)
            try requireUnused(request.newTitle!, except: request.groupTitle, among: groups)
            try renameCurrentGroup(context, currentTitle: request.groupTitle!, newTitle: request.newTitle!,
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
            mutationApplied = true
            try press(item, context: context, isAuthorized: isAuthorized, actions: &actions)
            if request.action == "createGroup" {
                let field = try waitForNameEditor(context, isAuthorized: isAuthorized)
                try setName(field, title: request.newTitle!, context: context, isAuthorized: isAuthorized, actions: &actions)
                try waitForGroup(request.newTitle!, context: context, isAuthorized: isAuthorized)
            } else {
                try waitForMenuDismissal(context, isAuthorized: isAuthorized)
            }
        }
        try stable(context, isAuthorized: isAuthorized, requirePage: false)
        let titles = request.action == "inspect" ? groups : try groupTitles(context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
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
        return result
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
        let tabs = nativeTabs(context).map { tab -> (identifier: String, title: String?) in
            let fields = nativeNodes(tab).filter { string($0, kAXIdentifierAttribute) == "UnifiedTabBarButton._titleTextField" }
            return (string(tab, kAXIdentifierAttribute) ?? "", fields.count == 1 ? string(fields[0], kAXValueAttribute) : nil)
        }
        return try Self.selectedTabIdentity(tabs, pageURLs: pageURLs(context.window))
    }

    private func tabBarMenuItem(_ context: Context, isAuthorized: () -> Bool,
                                actions: inout Int, requirePage: Bool) throws -> AXUIElement {
        // These are Safari's native identifiers observed in its real View menu.
        let menus = nativeNodes(context.app).filter { string($0, kAXIdentifierAttribute) == "SafariViewMenu" }
        guard menus.count == 1 else {
            throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "Safari did not expose its native View menu for showing the hidden tab bar.")
        }
        try press(menus[0], context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: requirePage)
        let item = try waitForIdentifier("AlwaysShowTabBar", context: context, isAuthorized: isAuthorized)
        guard bool(item, kAXEnabledAttribute) == true else {
            _ = AXUIElementPerformAction(menus[0], kAXCancelAction as CFString)
            throw Failure(code: "TAB_BAR_UNAVAILABLE", message: "Safari disabled View > Always Show Tab Bar for the selected native window.")
        }
        return item
    }

    private func showHiddenTabBar(_ context: Context, isAuthorized: () -> Bool,
                                  actions: inout Int, revealed: inout Bool, requirePage: Bool = true) throws {
        try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
        guard nativeTabs(context).isEmpty else { return }
        defer { cancelViewMenu(context) }
        let item = try tabBarMenuItem(context, isAuthorized: isAuthorized, actions: &actions, requirePage: requirePage)
        guard (string(item, kAXMenuItemMarkCharAttribute) ?? "").isEmpty else {
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
        let tabs = nativeTabs(context)
        if tabs.isEmpty { return }
        guard tabs.count == 1 else {
            throw Failure(code: "TAB_BAR_RESTORE_UNCONFIRMED", message: "Safari changed to a multi-tab collection before the original hidden tab bar could be restored.")
        }
        defer { cancelViewMenu(context) }
        let item = try tabBarMenuItem(context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        try press(item, context: context, isAuthorized: isAuthorized, actions: &actions, requirePage: false)
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            if nativeTabs(context).isEmpty { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "TAB_BAR_RESTORE_UNCONFIRMED", message: "Safari did not confirm restoring the original hidden tab bar. The group action was not replayed.")
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
        try nativeClick(toggles[0], button: .left, context: context, isAuthorized: isAuthorized,
                        actions: &actions, requirePage: requirePage)
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: requirePage)
            let pickerVisible = nativeNodes(context.window).contains {
                Self.groupTitle(string($0, kAXIdentifierAttribute) ?? "") != nil && nativeTargetVisible($0, context: context)
            }
            if nativeSidebarVisible(context) == visible, visible || pickerVisible {
                guard try currentGroupTitle(context) == originalGroup, pageURLs(context.window) == originalPages else {
                    throw Failure(code: "GROUP_READ_CHANGED_SELECTION", message: "Safari changed its selected group or page while changing the native sidebar layout.")
                }
                return
            }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "GROUP_UI_UNAVAILABLE", message: "Safari did not confirm the requested native sidebar layout. No group action was replayed.")
    }

    private func groupRow(_ title: String, context: Context, isAuthorized: () -> Bool, actions: inout Int) throws -> AXUIElement {
        try setNativeSidebarVisible(true, context: context, isAuthorized: isAuthorized, actions: &actions)
        let rows = nativeNodes(context.window).filter { row in
            guard string(row, kAXRoleAttribute) == kAXRowRole else { return false }
            if string(row, kAXValueAttribute) == title { return true }
            return nativeNodes(row).contains {
                string($0, kAXIdentifierAttribute) == "LibraryItemCellTextField" && string($0, kAXValueAttribute) == title
            }
        }
        guard rows.count == 1, let row = rows.first else {
            throw Failure(code: "GROUP_UI_UNAVAILABLE", message: "Safari's sidebar did not expose exactly one matching native group row.")
        }
        return row
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

    private func renameCurrentGroup(_ context: Context, currentTitle: String, newTitle: String,
                                    isAuthorized: () -> Bool, actions: inout Int, mutationApplied: inout Bool) throws {
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
        guard string(field, kAXValueAttribute) == currentTitle else {
            throw Failure(code: "GROUP_CHANGED", message: "Safari opened a different group name editor. No new name was entered.")
        }
        mutationApplied = true
        try setName(field, title: newTitle, context: context, isAuthorized: isAuthorized, actions: &actions)
        try waitForGroup(newTitle, context: context, isAuthorized: isAuthorized)
    }

    private func setName(_ field: AXUIElement, title: String, context: Context,
                         isAuthorized: () -> Bool, actions: inout Int) throws {
        try stable(context, isAuthorized: isAuthorized)
        actions += 1
        guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, title as CFString) == .success else {
            throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "Safari did not accept the native group name. Inspect its current group state before continuing.")
        }
        try stable(context, isAuthorized: isAuthorized)
        guard let focused = element(context.app, kAXFocusedUIElementAttribute), CFEqual(focused, field),
              string(field, kAXValueAttribute) == title else {
            throw Failure(code: "GROUP_RENAME_UNCONFIRMED", message: "Safari's native group name editor lost focus. The pending name was not committed by this helper.")
        }
        try key(36, context: context, isAuthorized: isAuthorized, actions: &actions)
    }

    private func selectGroup(_ title: String, context: Context, isAuthorized: () -> Bool, actions: inout Int) throws {
        try setNativeSidebarVisible(false, context: context, isAuthorized: isAuthorized, actions: &actions)
        try nativeClick(try picker(context), button: .left, context: context, isAuthorized: isAuthorized, actions: &actions)
        defer { cancelMenu(context) }
        let menu = try waitForIdentifier("TabGroupPickerMenu", context: context, isAuthorized: isAuthorized)
        let matches = nativeNodes(menu).filter { string($0, kAXIdentifierAttribute) == title + "TabGroupPickerMenuItem" }
        guard matches.count == 1 else { throw Failure(code: "AMBIGUOUS_GROUP", message: "The native group destination changed before selection.") }
        try press(matches[0], context: context, isAuthorized: isAuthorized, actions: &actions)
        try waitForGroup(title, context: context, isAuthorized: isAuthorized)
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
        guard let front = onMain({ NSWorkspace.shared.frontmostApplication }), front.processIdentifier == context.pid,
              isAppleSafari(front), let axFront = element(system, kAXFocusedApplicationAttribute),
              AXUIElementGetPid(axFront, &pid) == .success, pid == context.pid,
              let window = element(context.app, kAXFocusedWindowAttribute), CFEqual(window, context.window),
              string(window, kAXIdentifierAttribute).flatMap(Self.windowIdentifier) == context.windowIdentifier,
              let observed = frame(window), close(observed, context.request.target.windowBounds) else {
            throw Failure(code: "FOCUS_CHANGED", message: "Safari's foreground process, focused window, or window bounds changed. Stop and inspect fresh state.")
        }
        if requirePage, pageURLs(window) != [context.request.target.expectedURL] {
            throw Failure(code: "PAGE_CHANGED", message: "The selected Safari page changed before the native organization action.")
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
        let types: [CGEventType] = button == .left ? [.leftMouseDown, .leftMouseUp] : [.rightMouseDown, .rightMouseUp]
        for type in types {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
                throw Failure(code: "NATIVE_INPUT_FAILED", message: "Could not construct the native Safari context-menu event.")
            }
            actions += 1
            event.postToPid(context.pid)
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
        actions += 2
        down.postToPid(context.pid); up.postToPid(context.pid)
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

    private func waitForGroup(_ title: String, context: Context, isAuthorized: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            if try currentGroupTitle(context) == title { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "GROUP_RESULT_UNCONFIRMED", message: "Safari did not expose the requested selected group title. Inspect its current state; do not replay the mutation.")
    }

    private func waitForMenuDismissal(_ context: Context, isAuthorized: () -> Bool) throws {
        let deadline = Date().addingTimeInterval(2)
        repeat {
            try stable(context, isAuthorized: isAuthorized, requirePage: false)
            if !nativeNodes(context.window).contains(where: { ["SafariContextMenu", "TabGroupPickerMenu"].contains(string($0, kAXIdentifierAttribute) ?? "") }) { return }
            Thread.sleep(forTimeInterval: 0.04)
        } while Date() < deadline
        throw Failure(code: "GROUP_RESULT_UNCONFIRMED", message: "Safari kept the native group menu open after delivery. Inspect fresh state; do not replay the mutation.")
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
    private func onMain<T>(_ body: () -> T) -> T { Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body) }
    private func isAppleSafari(_ app: NSRunningApplication) -> Bool {
        guard app.bundleIdentifier == "com.apple.Safari", !app.isTerminated else { return false }
        var code: SecCode?, requirement: SecRequirement?
        return SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: app.processIdentifier] as CFDictionary, [], &code) == errSecSuccess &&
            SecRequirementCreateWithString("anchor apple and identifier \"com.apple.Safari\"" as CFString, [], &requirement) == errSecSuccess &&
            code != nil && requirement != nil && SecCodeCheckValidity(code!, [], requirement!) == errSecSuccess
    }
}
