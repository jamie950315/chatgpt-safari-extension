import Foundation
import SQLite3

@main struct SafariPersonalDataChecks {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("safari-history-fixture-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("History.db")
        var db: OpaquePointer?
        precondition(sqlite3_open(file.path, &db) == SQLITE_OK)
        let sql = """
        CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL);
        CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, title TEXT, visit_time REAL);
        INSERT INTO history_items VALUES (1, 'https://research.example/one'), (2, 'https://example.test/two'), (3, 'https://example.test/three');
        INSERT INTO history_visits VALUES (1, 1, 'Older title', 100), (2, 1, 'Café Research', 300), (3, 2, 'Research Two', 200), (4, 3, NULL, 400);
        """
        precondition(sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)
        let from = "2001-01-01T00:00:00.000Z", to = "2001-01-01T00:10:00.000Z"
        func read(_ arguments: [String: Any]) throws -> [[String: String]] {
            try SafariPersonalData.readHistory(store: file, request: SafariPersonalData.HistoryRequest(["from": from, "to": to].merging(arguments) { _, new in new }))
        }
        let all = try read([:])
        precondition(all.map { $0["url"]! } == ["https://example.test/three", "https://research.example/one", "https://example.test/two"])
        precondition(all[1]["title"] == "Café Research" && all[1]["dateVisited"] == "2001-01-01T00:05:00.000Z")
        precondition(all[0]["title"] == nil)
        let merged = try read(["queries": ["research", "CAFÉ"], "limit": 2])
        precondition(merged.count == 2 && merged[0]["url"] == "https://research.example/one", "Queries merge, sort, and deduplicate by URL")
        let injection = try read(["queries": ["' OR 1=1 --"]])
        let historicalTitle = try read(["queries": ["Older title"]])
        precondition(injection.isEmpty, "Query strings are values, never SQL")
        precondition(historicalTitle.isEmpty, "Search uses the latest title in the requested interval")
        let older = try read(["to": "2001-01-01T00:02:30.000Z"])
        precondition(older.count == 1 && older[0]["title"] == "Older title")
        for arguments: [String: Any] in [["limit": true], ["limit": 0], ["queries": []], ["queries": [1]], ["from": "invalid"]] {
            do { _ = try read(arguments); preconditionFailure("Invalid history arguments were accepted") } catch {}
        }
        do {
            _ = try SafariPersonalData.readHistory(store: file, request: .init([:]), isAuthorized: { false })
            preconditionFailure("A stale owner returned history")
        } catch let error as SafariPersonalData.Failure { precondition(error.code == "STALE_OWNER") }
        do {
            _ = try SafariPersonalData.readHistory(store: directory.appendingPathComponent("missing.db"), request: .init([:]))
            preconditionFailure("A missing database returned empty history")
        } catch let error as SafariPersonalData.Failure { precondition(error.code == "HISTORY_STORE_NOT_FOUND") }
        precondition(sqlite3_open_v2(file.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK)
        var count: OpaquePointer?
        precondition(sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM history_visits", -1, &count, nil) == SQLITE_OK)
        precondition(sqlite3_step(count) == SQLITE_ROW && sqlite3_column_int(count, 0) == 4)
        sqlite3_finalize(count); sqlite3_close(db)
        let profileDirectory = directory.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Safari")
        try FileManager.default.createDirectory(at: profileDirectory, withIntermediateDirectories: true)
        let metadata = profileDirectory.appendingPathComponent("SafariTabs.db")
        precondition(sqlite3_open(metadata.path, &db) == SQLITE_OK)
        let named = UUID()
        precondition(sqlite3_exec(db, "CREATE TABLE bookmarks (type INTEGER, subtype INTEGER, external_uuid TEXT); INSERT INTO bookmarks VALUES (1, 2, 'DefaultProfile'), (1, 2, '\(named.uuidString)');", nil, nil, nil) == SQLITE_OK)
        sqlite3_close(db)
        let defaultStore = try SafariPersonalData.resolveHistoryStore(nativeProfileUUID: nil, home: directory)
        let namedStore = try SafariPersonalData.resolveHistoryStore(nativeProfileUUID: named, home: directory)
        precondition(defaultStore == directory.appendingPathComponent("Library/Safari/History.db"))
        precondition(namedStore == profileDirectory.appendingPathComponent("Profiles/\(named.uuidString)/History.db"))
        do {
            _ = try SafariPersonalData.resolveHistoryStore(nativeProfileUUID: UUID(), home: directory)
            preconditionFailure("An unrecognized native profile fell back to the default profile")
        } catch let error as SafariPersonalData.Failure { precondition(error.code == "HISTORY_PROFILE_UNBOUND") }
        print("Safari personal data: read-only synthetic history, bounds, search, deduplication, ISO dates, invalid arguments, and stale-owner rejection passed")
    }
}
