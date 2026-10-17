import Foundation

@main struct SafariBookmarksGuardChecks {
    private final class SurfaceNode {
        let role: String
        let identifier: String?
        var children: [SurfaceNode]
        init(_ role: String, _ identifier: String? = nil, _ children: [SurfaceNode] = []) {
            self.role = role; self.identifier = identifier; self.children = children
        }
    }
    static func main() throws {
        let issued = Date(timeIntervalSince1970: 1000), deadline = SafariBookmarks.OperationDeadline(now: Date(timeIntervalSince1970: 1000))
        precondition(deadline.issuedAt == issued && deadline.expiresAt == issued.addingTimeInterval(20))
        precondition(deadline.authorization(ownerCurrent: true, now: issued.addingTimeInterval(19.999)) == .current)
        precondition(deadline.authorization(ownerCurrent: false, now: issued.addingTimeInterval(19)) == .owner)
        precondition(deadline.authorization(ownerCurrent: true, now: issued.addingTimeInterval(20)) == .deadline)
        precondition(deadline.authorization(ownerCurrent: false, now: issued.addingTimeInterval(20)) == .ownerAndDeadline,
                     "The native deadline must not masquerade as an owner/account authorization change")
        let scopeCommand: [String: Any] = ["operationId": UUID().uuidString, "_bookmarkOwnerToken": "original-owner", "sessionId": "session", "turnId": "turn", "issuedAtMs": 1_000_000]
        let scope = try SafariBookmarks.ContinuationScope(scopeCommand, profileIdentity: "profile:account-epoch")
        let gate = SafariBookmarks.ContinuationGate(scope: scope, now: issued)
        let receipt = try gate.issueReceipt(now: issued.addingTimeInterval(19))
        precondition(gate.phase == .awaitingFinalize && gate.authorized(now: issued.addingTimeInterval(23.9)))
        for key in ["operationId", "_bookmarkOwnerToken", "sessionId", "turnId", "profile"] {
            var otherCommand = scopeCommand; otherCommand[key] = key == "operationId" ? UUID().uuidString : "different"
            let other = try SafariBookmarks.ContinuationScope(otherCommand, profileIdentity: key == "profile" ? "other-profile" : scope.profileIdentity)
            do { _ = try gate.beginFinalize(receipt: receipt, scope: other, now: issued.addingTimeInterval(20)); preconditionFailure("A foreign continuation scope was accepted") }
            catch let failure as SafariBookmarks.Failure { precondition(failure.code == "BOOKMARK_CONTINUATION_EXPIRED") }
        }
        let finalDeadline = try gate.beginFinalize(receipt: receipt, scope: scope, now: issued.addingTimeInterval(23))
        precondition(finalDeadline.expiresAt == issued.addingTimeInterval(43) && gate.overallExpiry == issued.addingTimeInterval(45))
        do { _ = try gate.beginFinalize(receipt: receipt, scope: scope, now: issued.addingTimeInterval(23.1)); preconditionFailure("A consumed receipt was replayed") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.mutationApplied) }
        gate.complete(); precondition(!gate.authorized(now: issued.addingTimeInterval(24)))
        let expiredGate = SafariBookmarks.ContinuationGate(scope: scope, now: issued)
        let expiredReceipt = try expiredGate.issueReceipt(now: issued.addingTimeInterval(5))
        do { _ = try expiredGate.beginFinalize(receipt: expiredReceipt, scope: scope, now: issued.addingTimeInterval(10)); preconditionFailure("An expired handoff was accepted") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "BOOKMARK_CONTINUATION_EXPIRED") }
        let cancelled = SafariBookmarks.ContinuationGate(scope: scope, now: issued)
        let cancelledReceipt = try cancelled.issueReceipt(now: issued.addingTimeInterval(1))
        precondition(cancelled.cancel(scope: scope) && !cancelled.authorized(now: issued.addingTimeInterval(2)))
        do { _ = try cancelled.beginFinalize(receipt: cancelledReceipt, scope: scope, now: issued.addingTimeInterval(2)); preconditionFailure("A cancelled operation continued") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.mutationApplied) }
        let restarted = SafariBookmarks.ContinuationGate(scope: scope, now: issued)
        do { _ = try restarted.beginFinalize(receipt: receipt, scope: scope, now: issued.addingTimeInterval(2)); preconditionFailure("A receipt survived a native runtime restart") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "BOOKMARK_CONTINUATION_EXPIRED") }
        precondition(SafariBookmarks.acceptsAddBookmarkSheet(phaseAllowed: true, role: "AXSheet", identifier: "AddBookmarkSheet", attachedCount: 1, exactFocusedAttachment: true))
        for mismatch in 0..<5 {
            precondition(!SafariBookmarks.acceptsAddBookmarkSheet(phaseAllowed: mismatch != 0, role: mismatch == 1 ? "AXWindow" : "AXSheet",
                identifier: mismatch == 2 ? "OtherSheet" : "AddBookmarkSheet", attachedCount: mismatch == 3 ? 2 : 1, exactFocusedAttachment: mismatch != 4),
                "A focused sheet is authorized only in the bounded Add Bookmark phase and as the one exact attachment to the existing utility window")
        }
        let diagnostic = SafariBookmarks.Diagnostics(stage: .urlFocus, waitMS: 2048, expansionMS: -1,
            inventoryMS: 1_000_000_001, observation: .init(focusedElementMatches: false, fieldFocused: true, valueMatches: false)).data
        precondition(diagnostic["stage"] as? String == "url_focus" && diagnostic["waitMS"] as? Int == 2048)
        precondition(diagnostic["expansionMS"] as? Int == 0 && diagnostic["inventoryMS"] as? Int == 1_000_000_000)
        precondition(diagnostic["focusedElementMatches"] as? Bool == false && diagnostic["fieldFocused"] as? Bool == true
            && diagnostic["valueMatches"] as? Bool == false)
        precondition(Set(diagnostic.keys) == ["stage", "waitMS", "expansionMS", "inventoryMS", "focusedElementMatches", "fieldFocused", "valueMatches"],
                     "Native bookmark diagnostics must remain fixed timings and booleans, without private identities or values")
        let viewport = CGRect(x: 0, y: 100, width: 800, height: 400)
        let content = CGRect(x: 0, y: 100, width: 800, height: 2000)
        let reveal = try SafariBookmarks.revealScrollValue(current: 0, minimum: 0, maximum: 1,
            row: CGRect(x: 0, y: 1480, width: 800, height: 40), viewport: viewport, content: content)
        precondition(abs(reveal - 0.75) < 0.001, "Reveal uses the exact observed row and native scroll range, not a guessed screen coordinate")
        let top = try SafariBookmarks.revealScrollValue(current: 0.75, minimum: 0, maximum: 1,
            row: CGRect(x: 0, y: -1100, width: 800, height: 40), viewport: viewport, content: content)
        precondition(top == 0)
        do {
            _ = try SafariBookmarks.revealScrollValue(current: 0, minimum: 0, maximum: 1,
                row: CGRect(x: 0, y: 500, width: 800, height: 400), viewport: viewport, content: content)
            preconditionFailure("A bookmark larger than the verified viewport was accepted")
        } catch let failure as SafariBookmarks.Failure { precondition(failure.code == "BOOKMARK_TARGET_OBSCURED") }
        var opened = Set<Int>(), rowScans = 0, classified = 0
        try SafariBookmarks.expandInRounds(rows: {
            rowScans += 1
            return (0..<100).flatMap { opened.contains($0) ? [$0, $0 + 100] : [$0] }
        }, collapsedTriangle: { row -> Int? in
            classified += 1
            return opened.contains(row) ? nil : row
        }, expand: { row, triangle in
            precondition(row == triangle && !opened.contains(row), "A delivered folder expansion must never be replayed")
            opened.insert(row)
        })
        precondition(opened.count == 200 && rowScans == 3 && classified == 500,
                     "Sibling folders are classified in one AXRows round; only newly disclosed depth requires another pass")
        enum Interrupted: Error { case ownerChanged }
        var delivered: [Int] = []
        do {
            try SafariBookmarks.expandInRounds(rows: { [1, 2, 3] }, collapsedTriangle: { Optional($0) }, expand: { row, _ in
                if row == 3 { throw Interrupted.ownerChanged }
                delivered.append(row)
            })
            preconditionFailure("An interrupted native expansion was accepted")
        } catch Interrupted.ownerChanged { precondition(delivered == [1, 2]) }
        do {
            try SafariBookmarks.expandInRounds(rows: { Array(0...20000) }, collapsedTriangle: { Optional($0) }, expand: { _, _ in
                preconditionFailure("An oversized row collection delivered an expansion")
            })
            preconditionFailure("An oversized native row collection was accepted")
        } catch let failure as SafariBookmarks.Failure { precondition(failure.code == "BOOKMARK_TREE_TOO_LARGE") }
        let outline = SurfaceNode("AXOutline", "Bookmarks", (0..<3000).map { _ in SurfaceNode("AXRow") })
        let address = SurfaceNode("AXTextField", "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD")
        let search = SurfaceNode("AXTextField", "BookmarksSearchField")
        let window = SurfaceNode("AXWindow", nil, [SurfaceNode("AXGroup", nil, [outline, search]), SurfaceNode("AXToolbar", nil, [address])])
        var traversedContents = false
        func surface(_ root: SurfaceNode, limit: Int = 2048, depth: Int = 24) -> [SurfaceNode]? {
            SafariBookmarks.editorSurfaceNodes(root, children: {
                if $0 === outline { traversedContents = true }
                return $0.children
            }, role: { $0.role }, identifier: { $0.identifier }, equal: { $0 === $1 }, limit: limit, maximumDepth: depth)
        }
        let chrome = surface(window)!
        precondition(!traversedContents && chrome.count == 6 && chrome.contains { $0 === address } && chrome.contains { $0 === search },
                     "Expanded bookmark inventory must not consume or delay the separate native chrome identity traversal")
        let foreignPage = SurfaceNode("AXWebArea", nil, [SurfaceNode("AXOutline", "Bookmarks")])
        window.children.append(foreignPage)
        let withPage = surface(window)!
        precondition(withPage.contains { $0 === foreignPage } && withPage.filter { $0.identifier == "Bookmarks" }.count == 1,
                     "A web document remains visible as disqualifying identity evidence; its DOM cannot provide a native outline")
        window.children.removeLast()
        let secondOutline = SurfaceNode("AXOutline", "Bookmarks")
        window.children.append(secondOutline)
        precondition(surface(window)!.filter { $0.identifier == "Bookmarks" }.count == 2,
                     "Pruning inventory cannot hide another native editor surface")
        window.children.removeLast()
        precondition(surface(window, limit: 5) == nil && surface(window, depth: 1) == nil,
                     "A partial native chrome tree cannot establish exact editor identity")
        window.children.append(window.children[0])
        precondition(surface(window)!.count == 6, "Duplicate AXChildren/AXSheets identities must be counted once")
        let utility = "http://chatgpt-utility-fixture.localhost:1234/bookmarks/synthetic"
        for address in [nil, "", utility, String(utility.dropFirst("http://".count)), "bookmarks://"] {
            precondition(SafariBookmarks.editorReadiness(address: address, utilityURL: utility, nativeOutlineCount: 0, nativeTitleMatchesOutline: true, hasWebArea: false) == .waiting)
        }
        precondition(SafariBookmarks.editorReadiness(address: "bookmarks://", utilityURL: utility, nativeOutlineCount: 1, nativeTitleMatchesOutline: true, hasWebArea: false) == .ready)
        precondition(SafariBookmarks.editorReadiness(address: "bookmarks://", utilityURL: utility, nativeOutlineCount: 2, nativeTitleMatchesOutline: true, hasWebArea: false) == .waiting)
        for address in [utility, String(utility.dropFirst("http://".count))] {
            precondition(SafariBookmarks.editorReadiness(address: address, utilityURL: utility, nativeOutlineCount: 1, nativeTitleMatchesOutline: true, hasWebArea: false) == .ready,
                         "The observed native editor keeps the exact source in its address field")
            precondition(SafariBookmarks.editorReadiness(address: address, utilityURL: utility, nativeOutlineCount: 1, nativeTitleMatchesOutline: true, hasWebArea: true) == .waiting,
                         "An ordinary web page must not impersonate the native editor outline")
            precondition(SafariBookmarks.editorReadiness(address: address, utilityURL: utility, nativeOutlineCount: 1, nativeTitleMatchesOutline: false, hasWebArea: false) == .waiting)
        }
        for address in ["https://example.test/other", "file:///tmp/test", "Unverified native label"] {
            precondition(SafariBookmarks.editorReadiness(address: address, utilityURL: utility, nativeOutlineCount: 1, nativeTitleMatchesOutline: true, hasWebArea: false) == .changed)
        }
        let identity = SafariBookmarks.Identity(parents: ["Favorites", "Research"], title: "Example", url: "https://example.test/")
        let record = SafariBookmarks.Record(identity: identity, depth: 2, index: 0)
        let position = try SafariBookmarks.resolve(identity, in: [record])
        precondition(position == 0)
        precondition(SafariBookmarks.categoryTitle(description: "Favorites", value: "Favorites", hasDisclosureTriangle: true) == "Favorites")
        precondition(SafariBookmarks.categoryTitle(description: "Favorites", value: nil, hasDisclosureTriangle: true) == nil)
        precondition(SafariBookmarks.categoryTitle(description: "Favorites", value: "Other", hasDisclosureTriangle: true) == nil)
        for records in [[], [record, record], [SafariBookmarks.Record(identity: .init(parents: ["Other"], title: "Example", url: "https://example.test/"), depth: 1, index: 0)]] {
            do { _ = try SafariBookmarks.resolve(identity, in: records); preconditionFailure("An absent or ambiguous bookmark was accepted") }
            catch let failure as SafariBookmarks.Failure { precondition(failure.code == "STALE_BOOKMARK" && !failure.mutationApplied) }
        }
        try SafariBookmarks.validateURL("https://example.test/path?q=synthetic")
        for value in ["javascript:alert(1)", "file:///tmp/test", "https://user:password@example.test/", "data:text/plain,test"] {
            do { try SafariBookmarks.validateURL(value); preconditionFailure("A non-HTTP or credentialed bookmark URL was accepted") }
            catch let failure as SafariBookmarks.Failure { precondition(failure.code == "INVALID_ARGUMENTS") }
        }
        func row(_ parents: [String], _ title: String, _ url: String? = nil, _ index: Int = 0, editable: Bool = true) -> SafariBookmarks.Record {
            .init(identity: .init(parents: parents, title: title, url: url), depth: parents.count, index: index, editable: editable)
        }
        let inventory = [row([], "Favorites", editable: false), row(["Favorites"], "Source"),
                         row(["Favorites", "Source"], "First", "https://example.test/first"),
                         row(["Favorites", "Source"], "Nested", nil, 1),
                         row(["Favorites", "Source", "Nested"], "Leaf", "https://example.test/leaf"),
                         row(["Favorites"], "Destination", nil, 1),
                         row(["Favorites", "Destination"], "Existing", "https://example.test/existing")]
        let source = inventory[1].identity, leaf = inventory[4].identity, destination = inventory[5].identity
        let range = try SafariBookmarks.subtree(source, in: inventory)
        precondition(range == 1..<5)
        do { _ = try SafariBookmarks.deletion(source, recursive: false, in: inventory); preconditionFailure("remove accepted a nonempty folder") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "BOOKMARK_FOLDER_NOT_EMPTY" && !failure.mutationApplied) }
        let deleted = try SafariBookmarks.deletion(source, recursive: true, in: inventory)
        precondition(deleted.map(\.identity.title) == ["Favorites", "Destination", "Existing"])
        precondition(deleted[1].index == 0 && deleted[2].index == 0)
        let single = try SafariBookmarks.deletion(leaf, recursive: false, in: inventory)
        precondition(single.count == inventory.count - 1 && single.allSatisfy { $0.identity != leaf })
        for recursive in [true, false] {
            do { _ = try SafariBookmarks.deletion(inventory[0].identity, recursive: recursive, in: inventory); preconditionFailure("A special root was deleted") }
            catch let failure as SafariBookmarks.Failure { precondition(failure.code == "PROTECTED_BOOKMARK") }
        }
        let moved = try SafariBookmarks.move(source, to: destination, index: 0, in: inventory)
        precondition(moved.expected.map(\.identity.title) == ["Favorites", "Destination", "Source", "First", "Nested", "Leaf", "Existing"])
        precondition(moved.expected[2].identity.parents == ["Favorites", "Destination"])
        precondition(moved.expected[5].identity.parents == ["Favorites", "Destination", "Source", "Nested"])
        precondition(moved.expected[6].index == 1)
        precondition(moved.replacements[leaf]?.parents == ["Favorites", "Destination", "Source", "Nested"])
        let appended = try SafariBookmarks.move(source, to: destination, index: nil, in: inventory)
        precondition(appended.expected.map(\.identity.title) == ["Favorites", "Destination", "Existing", "Source", "First", "Nested", "Leaf"])
        let noop = try SafariBookmarks.move(source, to: inventory[0].identity, index: 0, in: inventory)
        precondition(SafariBookmarks.matches(noop.expected, inventory))
        let reordered = try SafariBookmarks.move(source, to: inventory[0].identity, index: 1, in: inventory)
        precondition(reordered.expected.map(\.identity.title) == ["Favorites", "Destination", "Existing", "Source", "First", "Nested", "Leaf"])
        precondition(SafariBookmarks.matches(inventory, inventory))
        precondition(!SafariBookmarks.matches(reordered.expected, inventory))
        for target in [source, inventory[3].identity, leaf] {
            do { _ = try SafariBookmarks.move(source, to: target, index: nil, in: inventory); preconditionFailure("A folder was moved into itself/descendants or a bookmark") }
            catch let failure as SafariBookmarks.Failure { precondition(failure.code == "INVALID_ARGUMENTS") }
        }
        for index in [-1, 2] {
            do { _ = try SafariBookmarks.move(source, to: destination, index: index, in: inventory); preconditionFailure("An out-of-range destination index was accepted") }
            catch let failure as SafariBookmarks.Failure { precondition(failure.code == "INVALID_ARGUMENTS") }
        }
        let collision = inventory + [row(["Favorites", "Destination"], "Source", nil, 1)]
        do { _ = try SafariBookmarks.move(source, to: destination, index: nil, in: collision); preconditionFailure("A move created a duplicate native identity") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "AMBIGUOUS_BOOKMARK") }
        let newURL = SafariBookmarks.Identity(parents: ["Favorites", "Destination"], title: "Created", url: "https://example.test/created")
        let created = try SafariBookmarks.inserting(newURL, in: inventory)
        precondition(created.last?.identity == newURL && created.last?.index == 1)
        let createdFirst = try SafariBookmarks.inserting(newURL, in: inventory, index: 0)
        precondition(createdFirst[6].identity == newURL && createdFirst[7].identity.title == "Existing" && createdFirst[7].index == 1)
        let rootCreated = try SafariBookmarks.inserting(.init(parents: [], title: "Root URL", url: "https://example.test/root"), in: inventory)
        precondition(rootCreated.last?.depth == 0 && rootCreated.last?.index == 1)
        do { _ = try SafariBookmarks.inserting(inventory[2].identity, in: inventory); preconditionFailure("A duplicate staged/final bookmark identity was accepted") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "AMBIGUOUS_BOOKMARK") }
        precondition(SafariBookmarks.confirmsCreation(newURL, before: inventory, after: created))
        precondition(SafariBookmarks.confirmsCreation(newURL, before: inventory, after: createdFirst))
        precondition(!SafariBookmarks.confirmsCreation(newURL, before: inventory, after: Array(created.dropFirst())))
        var tamperedCreation = created
        tamperedCreation[2] = row(["Favorites", "Source"], "Unrelated title changed", "https://example.test/first")
        precondition(!SafariBookmarks.confirmsCreation(newURL, before: inventory, after: tamperedCreation))
        let renamed = try SafariBookmarks.updating(source, title: "Renamed", url: nil, in: inventory)
        precondition(renamed.expected.map(\.identity.title) == ["Favorites", "Renamed", "First", "Nested", "Leaf", "Destination", "Existing"])
        precondition(renamed.expected[4].identity.parents == ["Favorites", "Renamed", "Nested"])
        precondition(renamed.replacements[leaf]?.parents == ["Favorites", "Renamed", "Nested"])
        precondition(renamed.expected[6].identity == inventory[6].identity && renamed.expected[6].index == inventory[6].index)
        let updatedURL = try SafariBookmarks.updating(inventory[2].identity, title: nil, url: "https://example.test/new-url", in: inventory)
        precondition(updatedURL.expected[2].identity.url == "https://example.test/new-url")
        precondition(zip(updatedURL.expected, inventory).enumerated().allSatisfy { position, rows in position == 2 || rows.0.identity == rows.1.identity })
        let noUpdate = try SafariBookmarks.updating(source, title: nil, url: nil, in: inventory)
        precondition(SafariBookmarks.matches(noUpdate.expected, inventory))
        do { _ = try SafariBookmarks.updating(source, title: "Destination", url: nil, in: inventory); preconditionFailure("A folder rename collided with an existing native folder") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "AMBIGUOUS_BOOKMARK") }
        do { _ = try SafariBookmarks.updating(inventory[0].identity, title: "Changed", url: nil, in: inventory); preconditionFailure("A protected collection was edited") }
        catch let failure as SafariBookmarks.Failure { precondition(failure.code == "PROTECTED_BOOKMARK") }
        print("Safari bookmarks: exact identity, safe URL, protected roots, deletion preservation, and subtree move planning passed")
    }
}
