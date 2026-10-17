import Foundation
import ApplicationServices
import CoreGraphics

/// Operates only inside the caller's guarded, temporary native bookmarks
/// editor. The caller owns Safari activation and exact source-window restoration.
final class SafariBookmarks {
    struct Failure: Error {
        let code: String
        let message: String
        var mutationApplied = false
    }
    struct Identity: Hashable {
        let parents: [String]
        let title: String
        let url: String?
    }
    struct Record {
        let identity: Identity
        let depth: Int
        let index: Int
        var editable = true
    }
    struct MovePlan {
        let source: Identity
        let destination: Identity?
        let index: Int
        let expected: [Record]
        let replacements: [Identity: Identity]
    }
    struct UpdatePlan {
        let expected: [Record]
        let replacements: [Identity: Identity]
    }
    enum EditorReadiness { case waiting, ready, changed }

    /// Proves native editor chrome without walking the bookmark inventory on
    /// every guard. Inventory rows are read separately through AXRows; a web
    /// document remains an explicit disqualifying surface, never its contents.
    static func editorSurfaceNodes<Element>(_ root: Element, children: (Element) -> [Element],
                                            role: (Element) -> String?, identifier: (Element) -> String?,
                                            equal: (Element, Element) -> Bool,
                                            limit: Int = 2048, maximumDepth: Int = 24) -> [Element]? {
        guard limit > 0, maximumDepth >= 0 else { return nil }
        var pending = [(root, 0)], result: [Element] = [], index = 0
        while index < pending.count {
            let (node, depth) = pending[index]; index += 1
            result.append(node)
            let kind = role(node)
            if kind == "AXWebArea" || kind == kAXOutlineRole && identifier(node) == "Bookmarks" { continue }
            let descendants = children(node)
            if depth >= maximumDepth && !descendants.isEmpty { return nil }
            for child in descendants where !pending.contains(where: { equal($0.0, child) }) {
                guard pending.count < limit else { return nil }
                pending.append((child, depth + 1))
            }
        }
        return result
    }

    static func editorReadiness(address: String?, utilityURL: String, nativeOutlineCount: Int,
                                nativeTitleMatchesOutline: Bool, hasWebArea: Bool) -> EditorReadiness {
        let source = address == utilityURL || address == String(utilityURL.dropFirst("http://".count))
        // Safari's native editor retains the previous page in its address
        // field. Its actual native surface, not an assumed address navigation,
        // proves that the one-shot Edit Bookmarks command has completed.
        if (source || address == "bookmarks://"), nativeOutlineCount == 1, nativeTitleMatchesOutline, !hasWebArea { return .ready }
        if address == "bookmarks://" { return .waiting }
        if address == nil || address == "" || address == utilityURL
            || address == String(utilityURL.dropFirst("http://".count)) { return .waiting }
        return .changed
    }
    private struct Lease { let profile: String; var identity: Identity }
    private var leases: [String: Lease] = [:]
    private var roots: [String: String] = [:]
    private let lock = NSLock()
    private(set) var lastRestorationConfirmed = true

    static func resolve(_ identity: Identity, in records: [Record]) throws -> Int {
        let matches = records.indices.filter { records[$0].identity == identity }
        guard matches.count == 1 else {
            throw Failure(code: "STALE_BOOKMARK", message: "The bookmark changed, disappeared, or has an ambiguous native identity. Search again before changing it.")
        }
        return matches[0]
    }

    static func categoryTitle(description: String?, value: String?, hasDisclosureTriangle: Bool) -> String? {
        guard hasDisclosureTriangle, let description, !description.isEmpty, description == value else { return nil }
        return description
    }

    /// Plans against the complete observed native order. Folder names alone
    /// never authorize a move or deletion, and a special Safari root is not an
    /// editable bookmark merely because it has a disclosure triangle.
    static func subtree(_ identity: Identity, in records: [Record]) throws -> Range<Int> {
        let start = try resolve(identity, in: records)
        let depth = records[start].depth
        var end = start + 1
        while end < records.count && records[end].depth > depth { end += 1 }
        return start..<end
    }

    static func deletion(_ identity: Identity, recursive: Bool, in records: [Record]) throws -> [Record] {
        let range = try subtree(identity, in: records)
        guard records[range.lowerBound].editable else {
            throw Failure(code: "PROTECTED_BOOKMARK", message: "Safari's built-in bookmark collections cannot be deleted.")
        }
        guard recursive || range.count == 1 else {
            throw Failure(code: "BOOKMARK_FOLDER_NOT_EMPTY", message: "Use removeTree only when the user explicitly requests deleting this folder and its contents.")
        }
        return reindexed(records.enumerated().filter { !range.contains($0.offset) }.map(\.element))
    }

    static func move(_ identity: Identity, to destination: Identity?, index: Int?, in records: [Record]) throws -> MovePlan {
        let range = try subtree(identity, in: records)
        guard records[range.lowerBound].editable else {
            throw Failure(code: "PROTECTED_BOOKMARK", message: "Safari's built-in bookmark collections cannot be moved.")
        }
        if let destination {
            let target = try resolve(destination, in: records)
            guard destination.url == nil else { throw Failure(code: "INVALID_ARGUMENTS", message: "Move a bookmark only into a folder.") }
            guard !range.contains(target) else { throw Failure(code: "INVALID_ARGUMENTS", message: "A bookmark folder cannot be moved into itself or its descendants.") }
        }
        let parents = destination.map { $0.parents + [$0.title] } ?? []
        let remaining = records.enumerated().filter { !range.contains($0.offset) }.map(\.element)
        let siblings = remaining.indices.filter { remaining[$0].identity.parents == parents }
        let insertionIndex = index ?? siblings.count
        guard insertionIndex >= 0, insertionIndex <= siblings.count else {
            throw Failure(code: "INVALID_ARGUMENTS", message: "The bookmark insertion index is outside the destination folder's current children.")
        }
        let insertion: Int
        if insertionIndex < siblings.count { insertion = siblings[insertionIndex] }
        else if let last = siblings.last { insertion = try subtree(remaining[last].identity, in: remaining).upperBound }
        else if let destination { insertion = try resolve(destination, in: remaining) + 1 }
        else { insertion = remaining.count }
        var replacements: [Identity: Identity] = [:]
        let sourcePrefix = identity.parents + [identity.title]
        let moved = records[range].map { record -> Record in
            let updatedParents = record.identity == identity ? parents : parents + [identity.title] + record.identity.parents.dropFirst(sourcePrefix.count)
            let updated = Identity(parents: updatedParents, title: record.identity.title, url: record.identity.url)
            replacements[record.identity] = updated
            return Record(identity: updated, depth: updatedParents.count, index: record.index, editable: record.editable)
        }
        guard Set(moved.map(\.identity)).count == moved.count,
              !remaining.contains(where: { replacements.values.contains($0.identity) }) else {
            throw Failure(code: "AMBIGUOUS_BOOKMARK", message: "Moving this bookmark would create an ambiguous native identity.")
        }
        var expected = remaining
        expected.insert(contentsOf: moved, at: insertion)
        return MovePlan(source: identity, destination: destination, index: insertionIndex,
                        expected: reindexed(expected), replacements: replacements)
    }

    static func matches(_ actual: [Record], _ expected: [Record]) -> Bool {
        actual.count == expected.count && zip(actual, expected).allSatisfy {
            $0.identity == $1.identity && $0.depth == $1.depth && $0.index == $1.index && $0.editable == $1.editable
        }
    }

    private static func reindexed(_ rows: [Record]) -> [Record] {
        var counts: [[String]: Int] = [:]
        return rows.map { row in
            let index = counts[row.identity.parents, default: 0]
            counts[row.identity.parents] = index + 1
            return Record(identity: row.identity, depth: row.depth, index: index, editable: row.editable)
        }
    }

    static func inserting(_ identity: Identity, in records: [Record], index: Int? = nil) throws -> [Record] {
        guard !records.contains(where: { $0.identity == identity }) else {
            throw Failure(code: "AMBIGUOUS_BOOKMARK", message: "A matching native bookmark already exists.")
        }
        let siblings = records.indices.filter { records[$0].identity.parents == identity.parents }
        let requested = index ?? siblings.count
        guard requested >= 0, requested <= siblings.count else { throw Failure(code: "INVALID_ARGUMENTS", message: "The requested bookmark index is outside its current folder.") }
        let insertion: Int
        if requested < siblings.count { insertion = siblings[requested] }
        else if let last = siblings.last { insertion = try subtree(records[last].identity, in: records).upperBound }
        else if identity.parents.isEmpty { insertion = records.count }
        else {
            let parent = Identity(parents: Array(identity.parents.dropLast()), title: identity.parents.last!, url: nil)
            insertion = try resolve(parent, in: records) + 1
        }
        var expected = records
        expected.insert(.init(identity: identity, depth: identity.parents.count, index: requested), at: insertion)
        return reindexed(expected)
    }

    static func updating(_ identity: Identity, title: String?, url: String?, in records: [Record]) throws -> UpdatePlan {
        let range = try subtree(identity, in: records)
        guard records[range.lowerBound].editable else { throw Failure(code: "PROTECTED_BOOKMARK", message: "Safari's built-in bookmark collections cannot be edited.") }
        guard url == nil || identity.url != nil else { throw Failure(code: "INVALID_ARGUMENTS", message: "A folder cannot be changed into a URL bookmark.") }
        let newTitle = title ?? identity.title, prefix = identity.parents + [identity.title]
        var replacements: [Identity: Identity] = [:]
        var expected = records
        for position in range {
            let row = records[position], current = row.identity
            let updated = position == range.lowerBound
                ? Identity(parents: current.parents, title: newTitle, url: url ?? current.url)
                : Identity(parents: identity.parents + [newTitle] + current.parents.dropFirst(prefix.count), title: current.title, url: current.url)
            replacements[current] = updated
            expected[position] = .init(identity: updated, depth: row.depth, index: row.index, editable: row.editable)
        }
        let unchanged = records.enumerated().filter { !range.contains($0.offset) }.map { $0.element.identity }
        guard !unchanged.contains(where: { replacements.values.contains($0) }) else { throw Failure(code: "AMBIGUOUS_BOOKMARK", message: "The requested update would create an ambiguous native bookmark identity.") }
        return UpdatePlan(expected: expected, replacements: replacements)
    }

    static func confirmsCreation(_ identity: Identity, before: [Record], after: [Record]) -> Bool {
        guard let position = try? resolve(identity, in: after),
              let expected = try? inserting(identity, in: before, index: after[position].index) else { return false }
        return matches(after, expected)
    }

    func perform(method: String, args: [Any], window: AXUIElement, profileIdentity: String,
                 utilityURL: String? = nil, withUtilityPage: ((() throws -> Void) throws -> Void)? = nil,
                 assertCurrentWithPostedButton: ((CGMouseButton) -> Bool)? = nil,
                 assertCurrent: @escaping () -> Bool) throws -> Any {
        guard lock.try() else { throw Failure(code: "BOOKMARKS_BUSY", message: "Another native bookmarks operation is running.") }
        defer { lock.unlock() }
        var driver = try Editor(window: window, authorized: assertCurrent, buttonAuthorized: assertCurrentWithPostedButton)
        var restorationNeeded = true
        lastRestorationConfirmed = false
        defer { lastRestorationConfirmed = !restorationNeeded || driver.restore() }
        try driver.expand()
        var rows = try driver.records()
        let root = roots[profileIdentity] ?? "safari-bookmarks-" + UUID().uuidString
        roots[profileIdentity] = root
        func id(_ identity: Identity) -> String {
            if let existing = leases.first(where: { $0.value.profile == profileIdentity && $0.value.identity == identity }) { return existing.key }
            let value = "safari-bookmark-" + UUID().uuidString
            leases[value] = Lease(profile: profileIdentity, identity: identity)
            return value
        }
        var rowIDs: [String] = [], parentIDs: [String] = []
        func identifyRows() {
            rowIDs = []; parentIDs = []
            var ancestors: [String] = []
            let counts = Dictionary(grouping: rows, by: \.identity).mapValues(\.count)
            for row in rows {
                let identifier: String
                if counts[row.identity] == 1 { identifier = id(row.identity) }
                else {
                    identifier = "safari-bookmark-" + UUID().uuidString
                    leases[identifier] = Lease(profile: profileIdentity, identity: row.identity)
                }
                ancestors = Array(ancestors.prefix(row.depth))
                rowIDs.append(identifier); parentIDs.append(ancestors.last ?? root)
                if row.identity.url == nil { ancestors.append(identifier) }
            }
        }
        identifyRows()
        func node(_ position: Int, children: [[String: Any]]? = nil) -> [String: Any] {
            let record = rows[position]
            let identity = record.identity
            var value: [String: Any] = ["id": rowIDs[position], "title": identity.title, "index": record.index, "parentId": parentIDs[position]]
            if let url = identity.url { value["url"] = url }
            if let children { value["children"] = children }
            return value
        }
        func branch(_ position: Int) -> [String: Any] {
            let children = rows.indices.filter { parentIDs[$0] == rowIDs[position] }.map { branch($0) }
            return node(position, children: rows[position].identity.url == nil ? children : nil)
        }
        func tree() -> [[String: Any]] { rows.indices.filter { parentIDs[$0] == root }.map { branch($0) } }
        func lease(_ raw: Any?) throws -> Identity {
            guard let key = raw as? String, let value = leases[key], value.profile == profileIdentity else {
                throw Failure(code: "STALE_BOOKMARK", message: "Search for this bookmark in the current Safari profile before using its handle.")
            }
            _ = try Self.resolve(value.identity, in: rows)
            return value.identity
        }
        switch method {
        case "getTree": return [["id": root, "title": "Safari Bookmarks", "children": tree()]]
        case "search":
            guard args.count == 1 else { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark search requires one query.") }
            let query = (args[0] as? String).map { ["query": $0] } ?? args[0] as? [String: String]
            guard let query, Set(query.keys).isSubset(of: ["query", "title", "url"]) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark search accepts query, title, or URL strings.")
            }
            return rows.indices.filter { position in
                let value = rows[position].identity
                return (query["title"] == nil || value.title == query["title"])
                    && (query["url"] == nil || value.url == query["url"])
                    && (query["query"] == nil || query["query"]!.isEmpty
                        || value.title.range(of: query["query"]!, options: .caseInsensitive) != nil
                        || value.url?.range(of: query["query"]!, options: .caseInsensitive) != nil)
            }.map { node($0) }
        case "get":
            guard args.count == 1 else { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark get requires a handle or handle array.") }
            let ids = (args[0] as? String).map { [$0] } ?? args[0] as? [String]
            guard let ids else { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark handles must be strings.") }
            return try ids.map { raw -> [String: Any] in
                if raw == root { return ["id": root, "title": "Safari Bookmarks"] }
                return node(try Self.resolve(lease(raw), in: rows))
            }
        case "getChildren", "getSubTree":
            guard args.count == 1 else { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark traversal requires one folder handle.") }
            if args[0] as? String == root { return method == "getChildren" ? rows.indices.filter { parentIDs[$0] == root }.map { node($0) } : [["id": root, "title": "Safari Bookmarks", "children": tree()]] }
            let identity = try lease(args[0])
            if method == "getSubTree" {
                return [branch(try Self.resolve(identity, in: rows))]
            }
            guard identity.url == nil else { throw Failure(code: "INVALID_ARGUMENTS", message: "A bookmark is not a folder.") }
            let parent = rowIDs[try Self.resolve(identity, in: rows)]
            return rows.indices.filter { parentIDs[$0] == parent }.map { node($0) }
        case "update":
            guard args.count == 2, let changes = args[1] as? [String: Any], !changes.isEmpty,
                  Set(changes.keys).isSubset(of: ["title", "url"]) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark update accepts a title and/or HTTP(S) URL.")
            }
            let previous = try lease(args[0]), position = try Self.resolve(previous, in: rows)
            if let title = changes["title"], !(title is String) { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark title must be a string.") }
            if let raw = changes["url"] { try Self.validateURL(raw); guard previous.url != nil else { throw Failure(code: "INVALID_ARGUMENTS", message: "A folder cannot be changed into a bookmark.") } }
            let plan = try Self.updating(previous, title: changes["title"] as? String, url: changes["url"] as? String, in: rows)
            if !Self.matches(rows, plan.expected) {
                let originalExpansions = driver.expansionIdentities(in: rows)
                try driver.update(position: position, title: changes["title"] as? String, url: changes["url"] as? String)
                rows = try driver.confirm(plan.expected)
                try driver.rebindExpansions(originalExpansions.map { plan.replacements[$0] ?? $0 }, in: rows)
                for (handle, value) in leases where value.profile == profileIdentity {
                    if let updated = plan.replacements[value.identity] { leases[handle] = Lease(profile: profileIdentity, identity: updated) }
                }
                identifyRows()
            }
            return node(try Self.resolve(plan.replacements[previous]!, in: rows))
        case "create":
            guard args.count == 1, let properties = args[0] as? [String: Any],
                  Set(properties.keys).isSubset(of: ["title", "url", "parentId"]), let rawURL = properties["url"] else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Create URL bookmark requires an HTTP(S) URL and an optional title and parent handle. Explicit insertion indices require a separate confirmed native move.")
            }
            try Self.validateURL(rawURL)
            guard properties["title"] == nil || properties["title"] is String else { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark title must be a string.") }
            guard let utilityURL, let withUtilityPage else { throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari's official Add Bookmark transaction is unavailable.") }
            var parent: Identity?
            if let raw = properties["parentId"], raw as? String != root {
                parent = try lease(raw)
                guard parent?.url == nil else { throw Failure(code: "INVALID_ARGUMENTS", message: "The parent must be a bookmark folder.") }
            }
            let destination: String
            if let parent {
                guard rows.filter({ $0.identity.url == nil && $0.identity.title == parent.title }).count == 1 else {
                    throw Failure(code: "AMBIGUOUS_BOOKMARK_PARENT", message: "Safari's Add Bookmark menu cannot distinguish folders with the same name. Use a uniquely named destination folder.")
                }
                destination = parent.title
            } else {
                guard let label = Editor.string(driver.outline, kAXDescriptionAttribute), !label.isEmpty,
                      !rows.contains(where: { $0.identity.url == nil && $0.identity.title == label }) else {
                    throw Failure(code: "BOOKMARK_ROOT_UNAVAILABLE", message: "Safari did not expose a unique native root label for Add Bookmark. Use an explicit uniquely named folder.")
                }
                destination = label
            }
            let parents = parent.map { $0.parents + [$0.title] } ?? []
            let final = Identity(parents: parents, title: properties["title"] as? String ?? "", url: rawURL as? String)
            _ = try Self.inserting(final, in: rows)
            let marker = "ChatGPT Safari Pending " + UUID().uuidString
            let staged = Identity(parents: parents, title: marker, url: utilityURL)
            let expectedStaged = try Self.inserting(staged, in: rows)
            let expectedFinal = try Self.inserting(final, in: rows)
            guard driver.restore() else { throw Failure(code: "BOOKMARK_RESTORATION_UNCONFIRMED", message: "The bookmark tree could not be restored before Add Bookmark.") }
            restorationNeeded = false
            var added = false
            do {
                try withUtilityPage {
                    try AddSheet.create(window: window, title: marker, destination: destination,
                                        authorized: assertCurrent, mutationDelivered: { added = true })
                }
                driver = try Editor(window: window, authorized: assertCurrent, buttonAuthorized: assertCurrentWithPostedButton)
                restorationNeeded = true
                try driver.expand()
                rows = try driver.records()
                guard Self.matches(rows, expectedStaged) else {
                    throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "Safari did not confirm the new bookmark in exactly the requested folder while preserving unrelated bookmarks.", mutationApplied: true)
                }
                try driver.update(position: try Self.resolve(staged, in: rows), title: final.title, url: final.url)
                rows = try driver.records()
                guard Self.matches(rows, expectedFinal) else {
                    throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "Safari did not confirm the new bookmark's final URL, title, parent, and unchanged unrelated bookmarks.", mutationApplied: true)
                }
                identifyRows()
                return node(try Self.resolve(final, in: rows))
            } catch let failure as Failure {
                if added {
                    throw Failure(code: failure.code, message: failure.message + " The Add Bookmark command was delivered once. Inspect the temporary entry named " + marker + "; do not repeat creation.", mutationApplied: true)
                }
                throw failure
            } catch {
                if added {
                    throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "Safari's Add Bookmark command was delivered, but the final editor transaction did not complete. Inspect the temporary entry named " + marker + "; do not repeat creation.", mutationApplied: true)
                }
                throw error
            }
        case "createFolder":
            guard args.count == 1, let properties = args[0] as? [String: Any],
                  Set(properties.keys).isSubset(of: ["title", "parentId"]), let title = properties["title"] as? String,
                  !title.isEmpty else { throw Failure(code: "INVALID_ARGUMENTS", message: "Create folder requires a title and optional parent handle.") }
            var parent: Identity?
            if let raw = properties["parentId"], raw as? String != root {
                parent = try lease(raw)
                guard parent?.url == nil else { throw Failure(code: "INVALID_ARGUMENTS", message: "The parent must be a folder.") }
            }
            let expected = Identity(parents: parent.map { $0.parents + [$0.title] } ?? [], title: title, url: nil)
            guard !rows.contains(where: { $0.identity == expected }) else { throw Failure(code: "AMBIGUOUS_BOOKMARK", message: "A matching folder already exists. Use the existing folder.") }
            let before = rows
            try driver.createFolder(title: title, parentPosition: try parent.map { try Self.resolve($0, in: rows) })
            rows = try driver.confirmCreation(expected, before: before)
            guard let created = try? Self.resolve(expected, in: rows) else { throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "The native folder creation could not be confirmed. Do not repeat it.", mutationApplied: true) }
            identifyRows()
            return node(created)
        case "remove", "removeTree":
            guard args.count == 1 else { throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark deletion requires one current bookmark handle.") }
            let identity = try lease(args[0])
            let removedRange = try Self.subtree(identity, in: rows)
            let removedExpansions = driver.expansionNodes(in: removedRange)
            let expected = try Self.deletion(identity, recursive: method == "removeTree", in: rows)
            try driver.remove(position: try Self.resolve(identity, in: rows))
            rows = try driver.confirm(expected)
            guard Self.matches(rows, expected) else {
                throw Failure(code: "BOOKMARK_DELETE_UNCONFIRMED", message: "Safari did not confirm exactly the requested bookmark deletion and preservation of unrelated bookmarks. Do not repeat it.", mutationApplied: true)
            }
            driver.acceptRemovedExpansions(removedExpansions)
            let remaining = Set(rows.map(\.identity))
            leases = leases.filter { $0.value.profile != profileIdentity || remaining.contains($0.value.identity) }
            return NSNull()
        case "move":
            guard args.count == 2, let properties = args[1] as? [String: Any],
                  Set(properties.keys) == ["parentId"], let parentId = properties["parentId"] as? String, parentId != root else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Native bookmark move requires one explicit destination folder handle. Root drops and explicit insertion indices are unsupported.")
            }
            let identity = try lease(args[0]), destination = try lease(parentId)
            let plan = try Self.move(identity, to: destination, index: nil, in: rows)
            if !Self.matches(rows, plan.expected) {
                let originalExpansions = driver.expansionIdentities(in: rows)
                try driver.drag(position: try Self.resolve(identity, in: rows), into: try Self.resolve(destination, in: rows))
                try driver.expand()
                rows = try driver.confirm(plan.expected)
                try driver.rebindExpansions(originalExpansions.map { plan.replacements[$0] ?? $0 }, in: rows)
                for (handle, value) in leases where value.profile == profileIdentity {
                    if let updated = plan.replacements[value.identity] { leases[handle] = Lease(profile: profileIdentity, identity: updated) }
                }
                identifyRows()
            }
            return node(try Self.resolve(plan.replacements[identity]!, in: rows))
        default: throw Failure(code: "UNSUPPORTED_BOOKMARK_METHOD", message: "This native bookmarks operation is not implemented.")
        }
    }

    static func validateURL(_ raw: Any) throws {
        guard let text = raw as? String, let url = URL(string: text), ["http", "https"].contains(url.scheme ?? ""),
              url.host != nil, url.user == nil, url.password == nil else {
            throw Failure(code: "INVALID_ARGUMENTS", message: "Bookmark URLs must use HTTP or HTTPS without credentials.")
        }
    }

    /// Uses only Safari's official Add Bookmark sheet for the inert utility
    /// page. The editor later replaces that temporary URL; no destination
    /// website is loaded and no bookmark storage is written directly.
    private enum AddSheet {
        static func create(window: AXUIElement, title: String, destination: String,
                           authorized: @escaping () -> Bool, mutationDelivered: () -> Void) throws {
            var pid: pid_t = 0; AXUIElementGetPid(window, &pid)
            let app = AXUIElementCreateApplication(pid)
            func check() throws {
                guard authorized() else { throw Failure(code: "FOCUS_CHANGED", message: "Safari changed during Add Bookmark. No command was replayed.") }
            }
            func wait(_ ready: () -> Bool) throws {
                let deadline = Date().addingTimeInterval(2)
                repeat { try check(); if ready() { return }; Thread.sleep(forTimeInterval: 0.025) } while Date() < deadline
                throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "Safari's official Add Bookmark sheet did not reach the verified state.")
            }
            try check()
            guard !Editor.nodes(window).contains(where: { Editor.string($0, kAXRoleAttribute) == kAXSheetRole }),
                  let bar = Editor.attribute(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
                throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "The temporary Safari window is not ready for Add Bookmark.")
            }
            let menuBar = unsafeBitCast(bar, to: AXUIElement.self)
            let menus = Editor.nodes(menuBar).filter { Editor.string($0, kAXIdentifierAttribute) == "SafariBookmarksMenu" }
            guard menus.count == 1, AXUIElementPerformAction(menus[0], kAXPressAction as CFString) == .success else {
                throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari's native Bookmarks menu is unavailable.")
            }
            try check()
            let items = Editor.nodes(menuBar).filter { Editor.string($0, kAXIdentifierAttribute) == "AddBookmark" }
            guard items.count == 1, (Editor.attribute(items[0], kAXEnabledAttribute) as? Bool) == true,
                  AXUIElementPerformAction(items[0], kAXPressAction as CFString) == .success else {
                throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari's native Add Bookmark command is unavailable for this temporary page.")
            }
            var sheet: AXUIElement?
            try wait {
                let matches = Editor.nodes(window).filter { Editor.string($0, kAXIdentifierAttribute) == "AddBookmarkSheet" }
                if matches.count == 1 { sheet = matches[0]; return true }
                return false
            }
            let panel = sheet!
            guard let rawDefault = Editor.attribute(panel, kAXDefaultButtonAttribute), CFGetTypeID(rawDefault) == AXUIElementGetTypeID(),
                  let rawCancel = Editor.attribute(panel, kAXCancelButtonAttribute), CFGetTypeID(rawCancel) == AXUIElementGetTypeID() else {
                throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari did not expose the official Add Bookmark default and cancel button identities. No button was pressed.")
            }
            let add = unsafeBitCast(rawDefault, to: AXUIElement.self), cancel = unsafeBitCast(rawCancel, to: AXUIElement.self)
            guard Editor.descendant(add, of: panel), Editor.descendant(cancel, of: panel), !CFEqual(add, cancel),
                  Editor.string(add, kAXRoleAttribute) == kAXButtonRole, Editor.string(cancel, kAXRoleAttribute) == kAXButtonRole else {
                throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari's official Add Bookmark button identities could not be verified. No button was pressed.")
            }
            var delivered = false
            defer {
                if !delivered, authorized(), Editor.nodes(window).contains(where: { CFEqual($0, panel) }) {
                    _ = AXUIElementPerformAction(cancel, kAXPressAction as CFString)
                }
            }
            let fields = Editor.nodes(panel).filter { Editor.string($0, kAXIdentifierAttribute) == "BookmarkTitleField" }
            let popups = Editor.nodes(panel).filter { Editor.string($0, kAXIdentifierAttribute) == "LocationPopUpButton" }
            guard fields.count == 1, popups.count == 1 else { throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari did not expose the official bookmark title and destination fields.") }
            let field = fields[0], popup = popups[0]
            let label: () -> String? = { Editor.string(popup, kAXValueAttribute) ?? Editor.string(popup, kAXTitleAttribute) }
            if label() != destination {
                try check()
                guard AXUIElementPerformAction(popup, kAXPressAction as CFString) == .success else { throw Failure(code: "BOOKMARK_PARENT_UNAVAILABLE", message: "Safari's Add Bookmark destination menu could not be opened.") }
                var locationMenu: AXUIElement?
                try wait {
                    let matches = Editor.nodes(app).filter { Editor.string($0, kAXIdentifierAttribute) == "LocationMenu" }
                    if matches.count == 1 { locationMenu = matches[0]; return true }
                    return false
                }
                let matches = Editor.nodes(locationMenu!).filter { Editor.string($0, kAXIdentifierAttribute) == "BookmarkFolderMenuItem" && Editor.string($0, kAXTitleAttribute) == destination }
                guard matches.count == 1, (Editor.attribute(matches[0], kAXEnabledAttribute) as? Bool) == true else {
                    throw Failure(code: "AMBIGUOUS_BOOKMARK_PARENT", message: "The native Add Bookmark menu does not identify exactly one requested destination folder.")
                }
                try check()
                guard AXUIElementPerformAction(matches[0], kAXPressAction as CFString) == .success else { throw Failure(code: "BOOKMARK_PARENT_UNAVAILABLE", message: "Safari rejected the requested Add Bookmark destination.") }
                try wait { label() == destination && !Editor.nodes(app).contains(where: { CFEqual($0, locationMenu!) }) }
            }
            try check()
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
                  AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, title as CFString) == .success,
                  Editor.string(field, kAXValueAttribute) == title, label() == destination,
                  (Editor.attribute(add, kAXEnabledAttribute) as? Bool) == true else {
                throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari did not verify the temporary bookmark title and exact destination. Add was not pressed.")
            }
            try check()
            delivered = true
            mutationDelivered()
            guard AXUIElementPerformAction(add, kAXPressAction as CFString) == .success else { throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "Safari's Add Bookmark command was delivered without a confirmed result.", mutationApplied: true) }
            try wait { !Editor.nodes(window).contains(where: { CFEqual($0, panel) }) }
        }
    }

    private final class Editor {
        let window: AXUIElement
        let authorized: () -> Bool
        let buttonAuthorized: ((CGMouseButton) -> Bool)?
        let outline: AXUIElement
        var currentRows: [AXUIElement] = []
        var expanded: [AXUIElement] = []
        var mutated = false

        init(window: AXUIElement, authorized: @escaping () -> Bool, buttonAuthorized: ((CGMouseButton) -> Bool)? = nil) throws {
            self.window = window; self.authorized = authorized
            self.buttonAuthorized = buttonAuthorized
            guard authorized(), let surface = Self.surface(window) else {
                throw Failure(code: "BOOKMARK_EDITOR_UNAVAILABLE", message: "The guarded native Safari bookmarks editor is unavailable.")
            }
            let outlines = surface.filter { Self.string($0, kAXIdentifierAttribute) == "Bookmarks" && Self.string($0, kAXRoleAttribute) == kAXOutlineRole }
            guard outlines.count == 1 else { throw Failure(code: "BOOKMARK_EDITOR_UNAVAILABLE", message: "Safari did not expose one exact native bookmark outline.") }
            self.outline = outlines[0]
            let search = surface.filter { Self.string($0, kAXIdentifierAttribute) == "BookmarksSearchField" }
            guard search.count == 1, Self.string(search[0], kAXValueAttribute) == "" else {
                throw Failure(code: "BOOKMARK_SEARCH_ACTIVE", message: "Safari's native bookmark editor has an active or unverifiable search filter. Clear that editor's search before using complete bookmark operations.")
            }
        }
        func check() throws {
            let ownerCurrent = authorized()
            let surface = Self.surface(window)
            let outlineCurrent = surface?.contains(where: {
                CFEqual($0, outline) && Self.string($0, kAXRoleAttribute) == kAXOutlineRole && Self.string($0, kAXIdentifierAttribute) == "Bookmarks"
            }) == true
            let searches = surface?.filter { Self.string($0, kAXIdentifierAttribute) == "BookmarksSearchField" } ?? []
            let searchEmpty = searches.count == 1 && Self.string(searches[0], kAXValueAttribute) == ""
            guard ownerCurrent, outlineCurrent, searchEmpty else {
                throw Failure(code: "FOCUS_CHANGED", message: "The guarded Safari bookmarks editor changed. Do not repeat a delivered update. Native editor check: authorized=\(ownerCurrent), surfaceComplete=\(surface != nil), outlineCurrent=\(outlineCurrent), searchEmpty=\(searchEmpty).", mutationApplied: mutated)
            }
        }
        func rows() throws -> [AXUIElement] {
            try check()
            guard let value = Self.attribute(outline, kAXRowsAttribute) as? [AXUIElement] else {
                throw Failure(code: "BOOKMARK_ROWS_UNAVAILABLE", message: "Safari did not expose its native bookmark rows.", mutationApplied: mutated)
            }
            return value
        }
        func expand() throws {
            for _ in 0..<20000 {
                let items = try rows()
                guard items.count <= 20000 else { throw Failure(code: "BOOKMARK_TREE_TOO_LARGE", message: "The native bookmark tree exceeds the bounded traversal limit.") }
                guard let row = items.first(where: { row in Self.folderTitle(row) != nil
                    && Self.nodes(row).contains(where: { Self.string($0, kAXIdentifierAttribute) == "SectionDisclosureTriangle" && (Self.attribute($0, kAXValueAttribute) as? NSNumber)?.boolValue == false }) }) else { return }
                guard let triangle = Self.nodes(row).first(where: { Self.string($0, kAXIdentifierAttribute) == "SectionDisclosureTriangle" }) else { return }
                try check()
                guard AXUIElementPerformAction(triangle, kAXPressAction as CFString) == .success else { throw Failure(code: "BOOKMARK_TREE_UNAVAILABLE", message: "A native bookmark folder could not be expanded.") }
                expanded.append(triangle)
                try wait { (Self.attribute(triangle, kAXValueAttribute) as? NSNumber)?.boolValue == true }
            }
            throw Failure(code: "BOOKMARK_TREE_TOO_LARGE", message: "The native bookmark folder traversal did not complete within its bound.")
        }
        func restore() -> Bool {
            for triangle in expanded.reversed() {
                guard authorized() else { return false }
                if (Self.attribute(triangle, kAXValueAttribute) as? NSNumber)?.boolValue == true {
                    guard AXUIElementPerformAction(triangle, kAXPressAction as CFString) == .success else { return false }
                    do { try wait { (Self.attribute(triangle, kAXValueAttribute) as? NSNumber)?.boolValue == false } }
                    catch { return false }
                } else if Self.attribute(triangle, kAXValueAttribute) == nil { return false }
            }
            return true
        }
        func records() throws -> [Record] {
            currentRows = try rows()
            var parents: [String] = [], indices: [[String]: Int] = [:], result: [Record] = []
            for row in currentRows {
                guard let depth = (Self.attribute(row, kAXDisclosureLevelAttribute) as? NSNumber)?.intValue, depth >= 0, depth <= 32, depth <= parents.count else {
                    throw Failure(code: "BOOKMARK_HIERARCHY_UNAVAILABLE", message: "Safari's native bookmark hierarchy could not be verified.", mutationApplied: mutated)
                }
                parents = Array(parents.prefix(depth))
                let nodes = Self.nodes(row)
                let titleField = nodes.first(where: { ["BookmarkTitle", "BookmarkFolderTitle"].contains(Self.string($0, kAXIdentifierAttribute) ?? "") })
                guard let title = titleField.flatMap({ Self.string($0, kAXValueAttribute) }) ?? Self.folderTitle(row) else {
                    throw Failure(code: "BOOKMARK_ROW_UNAVAILABLE", message: "A native bookmark row could not be read.", mutationApplied: mutated)
                }
                let urlField = nodes.first(where: { Self.string($0, kAXIdentifierAttribute) == "BookmarkURL" })
                let url = urlField.flatMap { Self.string($0, kAXValueAttribute) }
                let index = indices[parents, default: 0]; indices[parents] = index + 1
                result.append(Record(identity: Identity(parents: parents, title: title, url: url), depth: depth, index: index, editable: titleField != nil))
                if url == nil { parents.append(title) }
            }
            return result
        }
        func confirm(_ expected: [Record]) throws -> [Record] {
            let deadline = Date().addingTimeInterval(2)
            repeat {
                let observed = try records()
                if SafariBookmarks.matches(observed, expected) { return observed }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
            throw Failure(code: "BOOKMARK_RESULT_UNCONFIRMED", message: "Safari did not expose exactly the expected native bookmark result. The command was not replayed.", mutationApplied: mutated)
        }
        func confirmCreation(_ identity: Identity, before: [Record]) throws -> [Record] {
            let deadline = Date().addingTimeInterval(2)
            repeat {
                let observed = try records()
                if SafariBookmarks.confirmsCreation(identity, before: before, after: observed) { return observed }
                Thread.sleep(forTimeInterval: 0.025)
            } while Date() < deadline
            throw Failure(code: "BOOKMARK_CREATE_UNCONFIRMED", message: "Safari did not confirm exactly one new bookmark folder with the requested parent and preservation of unrelated bookmarks. Do not repeat it.", mutationApplied: mutated)
        }
        func set(_ field: AXUIElement, value: String) throws {
            try check()
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue,
                  AXUIElementSetAttributeValue(field, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
                throw Failure(code: "BOOKMARK_EDIT_REJECTED", message: "Safari rejected editing the native bookmark field.", mutationApplied: mutated)
            }
            var pid: pid_t = 0; AXUIElementGetPid(window, &pid)
            let application = AXUIElementCreateApplication(pid)
            try wait {
                guard let focused = Self.attribute(application, kAXFocusedUIElementAttribute) else { return false }
                return CFEqual(focused, field) && (Self.attribute(field, kAXFocusedAttribute) as? Bool) == true
            }
            try check()
            guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, value as CFString) == .success else {
                throw Failure(code: "BOOKMARK_EDIT_REJECTED", message: "Safari rejected editing the native bookmark field.", mutationApplied: mutated)
            }
            mutated = true
            try check()
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false) else {
                throw Failure(code: "NATIVE_EVENT_FAILED", message: "The native bookmark commit key could not be created.", mutationApplied: true)
            }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            try wait { Self.string(field, kAXValueAttribute) == value && (Self.attribute(field, kAXFocusedAttribute) as? Bool) != true }
        }
        func update(position: Int, title: String?, url: String?) throws {
            let rows = currentRows
            guard rows.indices.contains(position) else { throw Failure(code: "STALE_BOOKMARK", message: "The native bookmark row changed.") }
            if let url {
                guard let field = Self.nodes(rows[position]).first(where: { Self.string($0, kAXIdentifierAttribute) == "BookmarkURL" }) else { throw Failure(code: "BOOKMARK_EDIT_REJECTED", message: "The native bookmark has no editable URL.") }
                try set(field, value: url)
            }
            if let title {
                guard let field = Self.nodes(rows[position]).first(where: { ["BookmarkTitle", "BookmarkFolderTitle"].contains(Self.string($0, kAXIdentifierAttribute) ?? "") }) else { throw Failure(code: "BOOKMARK_EDIT_REJECTED", message: "The native bookmark has no editable title.", mutationApplied: mutated) }
                try set(field, value: title)
            }
        }
        func createFolder(title: String, parentPosition: Int?) throws {
            try check()
            if let parentPosition {
                guard currentRows.indices.contains(parentPosition), AXUIElementSetAttributeValue(currentRows[parentPosition], kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success else {
                    throw Failure(code: "BOOKMARK_PARENT_UNAVAILABLE", message: "Safari could not select the requested bookmark folder.")
                }
            } else {
                guard AXUIElementSetAttributeValue(outline, kAXSelectedRowsAttribute as CFString, [] as CFArray) == .success else {
                    throw Failure(code: "BOOKMARK_PARENT_UNAVAILABLE", message: "Safari could not select the bookmark root.")
                }
            }
            guard let button = Self.nodes(window).first(where: { Self.string($0, kAXIdentifierAttribute) == "NewFolder" }) else { throw Failure(code: "BOOKMARK_CREATE_UNAVAILABLE", message: "Safari's New Folder control is unavailable.") }
            try check()
            guard AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw Failure(code: "BOOKMARK_CREATE_REJECTED", message: "Safari rejected creating a bookmark folder.") }
            mutated = true
            var pid: pid_t = 0; AXUIElementGetPid(window, &pid)
            let application = AXUIElementCreateApplication(pid)
            var editor: AXUIElement?
            try wait {
                if let field = Self.attribute(application, kAXFocusedUIElementAttribute), CFGetTypeID(field) == AXUIElementGetTypeID() {
                    let candidate = unsafeBitCast(field, to: AXUIElement.self)
                    if Self.string(candidate, kAXIdentifierAttribute) == "BookmarkFolderTitle" { editor = candidate; return true }
                }
                return false
            }
            try set(editor!, value: title)
        }
        func remove(position: Int) throws {
            try check()
            guard currentRows.indices.contains(position) else { throw Failure(code: "STALE_BOOKMARK", message: "The native bookmark row changed.") }
            let row = currentRows[position]
            guard AXUIElementSetAttributeValue(outline, kAXSelectedRowsAttribute as CFString, [row] as CFArray) == .success,
                  let selected = Self.attribute(outline, kAXSelectedRowsAttribute) as? [AXUIElement],
                  selected.count == 1, CFEqual(selected[0], row) else {
                throw Failure(code: "BOOKMARK_SELECTION_UNCONFIRMED", message: "Safari did not select exactly the requested bookmark row. No bookmark was deleted.")
            }
            var pid: pid_t = 0; AXUIElementGetPid(window, &pid)
            let application = AXUIElementCreateApplication(pid)
            guard !Self.nodes(application).contains(where: { Self.string($0, kAXIdentifierAttribute) == "SafariContextMenu" }) else {
                throw Failure(code: "BOOKMARK_DELETE_UNAVAILABLE", message: "Dismiss the existing Safari context menu before deleting a bookmark.")
            }
            try check()
            // Safari's bookmark rows do not expose AXShowMenu. Use the real
            // native secondary click, bound to an AX-observed row and hit test.
            let point = try nativePoint(row: row)
            guard let source = CGEventSource(stateID: .combinedSessionState),
                  let down = CGEvent(mouseEventSource: source, mouseType: .rightMouseDown, mouseCursorPosition: point, mouseButton: .right),
                  let up = CGEvent(mouseEventSource: source, mouseType: .rightMouseUp, mouseCursorPosition: point, mouseButton: .right) else {
                throw Failure(code: "NATIVE_EVENT_FAILED", message: "The native bookmark context-menu events could not be created.")
            }
            for event in [down, up] { event.flags = []; event.setIntegerValueField(.mouseEventClickState, value: 1); event.post(tap: .cghidEventTap) }
            try waitForPostedButtonRelease(.right)
            var menu: AXUIElement?
            defer {
                if let menu, authorized(), Self.nodes(application).contains(where: { CFEqual($0, menu) }),
                   let down = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: true),
                   let up = CGEvent(keyboardEventSource: nil, virtualKey: 53, keyDown: false) {
                    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
                }
            }
            try wait {
                let menus = Self.nodes(application).filter { Self.string($0, kAXIdentifierAttribute) == "SafariContextMenu" }
                if menus.count == 1 { menu = menus[0]; return true }
                return false
            }
            let matches = Self.nodes(menu!).filter { Self.string($0, kAXIdentifierAttribute) == "DeleteMenuItem" }
            guard matches.count == 1, (Self.attribute(matches[0], kAXEnabledAttribute) as? Bool) == true,
                  let selected = Self.attribute(outline, kAXSelectedRowsAttribute) as? [AXUIElement],
                  selected.count == 1, CFEqual(selected[0], row) else {
                throw Failure(code: "BOOKMARK_DELETE_UNAVAILABLE", message: "Safari's native Delete command is not bound to exactly the requested bookmark row.")
            }
            try check()
            mutated = true
            guard AXUIElementPerformAction(matches[0], kAXPressAction as CFString) == .success else {
                throw Failure(code: "BOOKMARK_DELETE_UNCONFIRMED", message: "The native bookmark Delete command was delivered without a confirmed result. Do not repeat it.", mutationApplied: true)
            }
            try wait { !Self.nodes(application).contains(where: { CFEqual($0, menu!) }) }
        }
        func expansionNodes(in range: Range<Int>) -> [AXUIElement] {
            currentRows.enumerated().filter { range.contains($0.offset) }.flatMap { Self.nodes($0.element) }
                .filter { node in expanded.contains(where: { CFEqual($0, node) }) }
        }
        func expansionIdentities(in records: [Record]) -> [Identity] {
            zip(currentRows, records).compactMap { row, record in
                Self.nodes(row).contains(where: { node in expanded.contains(where: { CFEqual($0, node) }) }) ? record.identity : nil
            }
        }
        func rebindExpansions(_ identities: [Identity], in records: [Record]) throws {
            expanded = try identities.map { identity in
                let position = try SafariBookmarks.resolve(identity, in: records)
                guard currentRows.indices.contains(position), let triangle = Self.nodes(currentRows[position]).first(where: { Self.string($0, kAXIdentifierAttribute) == "SectionDisclosureTriangle" }) else {
                    throw Failure(code: "BOOKMARK_RESTORATION_UNCONFIRMED", message: "Safari did not preserve the temporary expansion identity after moving the bookmark folder.", mutationApplied: true)
                }
                return triangle
            }
        }
        func drag(position: Int, into destination: Int) throws {
            try check()
            guard currentRows.indices.contains(position), currentRows.indices.contains(destination), position != destination,
                  buttonAuthorized != nil else { throw Failure(code: "BOOKMARK_MOVE_UNAVAILABLE", message: "The native bookmark move has no bound source, destination, and trusted pointer authorization.") }
            let row = currentRows[position], target = currentRows[destination]
            guard AXUIElementSetAttributeValue(outline, kAXSelectedRowsAttribute as CFString, [row] as CFArray) == .success,
                  let selected = Self.attribute(outline, kAXSelectedRowsAttribute) as? [AXUIElement], selected.count == 1, CFEqual(selected[0], row) else {
                throw Failure(code: "BOOKMARK_SELECTION_UNCONFIRMED", message: "Safari did not select exactly the requested bookmark for native movement.")
            }
            let start = try nativePoint(row: row), finish = try nativePoint(row: target)
            guard hypot(start.x - finish.x, start.y - finish.y) >= 4,
                  let source = CGEventSource(stateID: .combinedSessionState),
                  let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left) else {
                throw Failure(code: "BOOKMARK_MOVE_UNAVAILABLE", message: "Safari did not expose distinct visible source and destination rows for the native drag.")
            }
            try check()
            down.flags = []; down.setIntegerValueField(.mouseEventClickState, value: 1)
            down.post(tap: .cghidEventTap)
            mutated = true
            var last = start, released = false
            defer {
                if !released, let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: last, mouseButton: .left) {
                    up.flags = []; up.post(tap: .cghidEventTap)
                }
            }
            for step in 1...12 {
                guard buttonAuthorized?(.left) == true, Self.nodes(window).contains(where: { CFEqual($0, outline) }) else {
                    throw Failure(code: "FOCUS_CHANGED", message: "Safari changed during the delivered bookmark drag. Inspect the current hierarchy; do not repeat it.", mutationApplied: true)
                }
                let fraction = CGFloat(step) / 12
                let point = CGPoint(x: start.x + (finish.x - start.x) * fraction, y: start.y + (finish.y - start.y) * fraction)
                var hit: AXUIElement?
                guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
                      let hit, Self.descendant(hit, of: step == 12 ? target : outline),
                      let event = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left) else {
                    throw Failure(code: "BOOKMARK_MOVE_UNCONFIRMED", message: "The delivered bookmark drag no longer targets the exact native editor and destination folder. Inspect the current hierarchy; do not repeat it.", mutationApplied: true)
                }
                event.flags = []; event.post(tap: .cghidEventTap); last = point
                Thread.sleep(forTimeInterval: 0.02)
            }
            guard buttonAuthorized?(.left) == true,
                  let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: finish, mouseButton: .left) else {
                throw Failure(code: "FOCUS_CHANGED", message: "Safari changed before the native bookmark drop completed. Inspect the current hierarchy; do not repeat it.", mutationApplied: true)
            }
            up.flags = []; up.post(tap: .cghidEventTap); released = true
            try waitForPostedButtonRelease(.left)
        }
        func waitForPostedButtonRelease(_ button: CGMouseButton) throws {
            let deadline = Date().addingTimeInterval(0.5)
            while CGEventSource.buttonState(.combinedSessionState, button: button) {
                guard buttonAuthorized?(button) == true, Date() < deadline else {
                    throw Failure(code: "FOCUS_CHANGED", message: "Safari changed while a delivered native bookmark pointer event completed. No command was replayed.", mutationApplied: mutated)
                }
                Thread.sleep(forTimeInterval: 0.005)
            }
            try check()
        }
        func acceptRemovedExpansions(_ removed: [AXUIElement]) {
            expanded.removeAll { node in removed.contains(where: { CFEqual($0, node) }) }
        }
        func nativePoint(row: AXUIElement) throws -> CGPoint {
            try check()
            guard let bounds = Self.frame(row), let windowFrame = Self.frame(window),
                  bounds.width > 0, bounds.height > 0 else {
                throw Failure(code: "BOOKMARK_TARGET_UNAVAILABLE", message: "Safari did not expose the requested bookmark's native bounds.")
            }
            let title = Self.nodes(row).first { ["BookmarkTitle", "BookmarkFolderTitle"].contains(Self.string($0, kAXIdentifierAttribute) ?? "") }
            let visible = (title.flatMap(Self.frame) ?? bounds).intersection(windowFrame)
            guard !visible.isNull, visible.width > 2, visible.height > 2 else {
                throw Failure(code: "BOOKMARK_TARGET_OBSCURED", message: "The requested bookmark is outside the native editor's visible window. No context-menu command was delivered.")
            }
            let point = CGPoint(x: visible.midX, y: visible.midY)
            var hit: AXUIElement?
            guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success,
                  let hit, Self.descendant(hit, of: row) else {
                throw Failure(code: "BOOKMARK_TARGET_OBSCURED", message: "The native bookmark row is obscured by another Safari surface. No context-menu command was delivered.")
            }
            return point
        }
        func wait(_ ready: () -> Bool) throws {
            let deadline = Date().addingTimeInterval(2)
            repeat { try check(); if ready() { return }; Thread.sleep(forTimeInterval: 0.025) } while Date() < deadline
            throw Failure(code: "BOOKMARK_OPERATION_UNCONFIRMED", message: "The delivered native bookmark operation did not finish. Do not repeat it.", mutationApplied: mutated)
        }
        static func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? { var value: CFTypeRef?; return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil }
        static func string(_ node: AXUIElement, _ name: String) -> String? { attribute(node, name) as? String }
        static func descendant(_ node: AXUIElement, of ancestor: AXUIElement) -> Bool {
            var current: AXUIElement? = node
            for _ in 0..<40 {
                guard let candidate = current else { return false }
                if CFEqual(candidate, ancestor) { return true }
                guard let parent = attribute(candidate, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { return false }
                current = unsafeBitCast(parent, to: AXUIElement.self)
            }
            return false
        }
        static func frame(_ node: AXUIElement) -> CGRect? {
            guard let rawPosition = attribute(node, kAXPositionAttribute), let rawSize = attribute(node, kAXSizeAttribute),
                  CFGetTypeID(rawPosition) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
            let position = unsafeBitCast(rawPosition, to: AXValue.self), size = unsafeBitCast(rawSize, to: AXValue.self)
            var point = CGPoint.zero, dimensions = CGSize.zero
            guard AXValueGetType(position) == .cgPoint, AXValueGetType(size) == .cgSize,
                  AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions),
                  [point.x, point.y, dimensions.width, dimensions.height].allSatisfy(\.isFinite) else { return nil }
            return CGRect(origin: point, size: dimensions)
        }
        static func folderTitle(_ row: AXUIElement) -> String? {
            let descendants = nodes(row)
            if let field = descendants.first(where: { string($0, kAXIdentifierAttribute) == "BookmarkFolderTitle" }) { return string(field, kAXValueAttribute) }
            guard !descendants.contains(where: { string($0, kAXIdentifierAttribute) == "BookmarkTitle" || string($0, kAXIdentifierAttribute) == "BookmarkURL" }) else { return nil }
            return SafariBookmarks.categoryTitle(description: string(row, kAXDescriptionAttribute), value: string(row, kAXValueAttribute),
                                                  hasDisclosureTriangle: descendants.contains(where: { string($0, kAXIdentifierAttribute) == "SectionDisclosureTriangle" }))
        }
        static func nodes(_ root: AXUIElement) -> [AXUIElement] {
            var result: [AXUIElement] = [], pending = [root]
            while let node = pending.popLast(), result.count < 10000 {
                result.append(node)
                if let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] { pending.append(contentsOf: children.reversed()) }
            }
            return result
        }
        static func surface(_ window: AXUIElement) -> [AXUIElement]? {
            SafariBookmarks.editorSurfaceNodes(window, children: {
                (attribute($0, kAXChildrenAttribute) as? [AXUIElement] ?? [])
                    + (attribute($0, "AXSheets") as? [AXUIElement] ?? [])
            }, role: { string($0, kAXRoleAttribute) }, identifier: { string($0, kAXIdentifierAttribute) }, equal: { CFEqual($0, $1) })
        }
    }
}
