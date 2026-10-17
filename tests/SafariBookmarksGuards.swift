import Foundation

@main struct SafariBookmarksGuardChecks {
    static func main() throws {
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
