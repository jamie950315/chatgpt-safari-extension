import Foundation
import SQLite3
import Darwin

/// Reads a specifically bound Safari profile. It never discovers profiles,
/// copies databases, modifies browser stores, or substitutes another profile.
final class SafariPersonalData {
    struct Failure: Error {
        let code: String
        let message: String
    }
    struct HistoryRequest {
        let queries: [String]
        let limit: Int
        let from: Date
        let to: Date

        init(_ arguments: [String: Any]) throws {
            if let raw = arguments["queries"] {
                guard let value = raw as? [String], !value.isEmpty else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "History queries must be a nonempty array of strings.")
                }
                queries = value
            } else { queries = [""] }
            if let raw = arguments["limit"] {
                guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
                      value.doubleValue.isFinite, value.doubleValue.rounded() == value.doubleValue,
                      value.doubleValue > 0, value.doubleValue <= Double(Int32.max) else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "History limit must be a positive integer.")
                }
                limit = value.intValue
            } else { limit = 100 }
            func date(_ key: String) throws -> Date? {
                guard let raw = arguments[key] else { return nil }
                guard let value = raw as? String else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "History \(key) must be an ISO date.")
                }
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let parsed = formatter.date(from: value) { return parsed }
                formatter.formatOptions = [.withInternetDateTime]
                guard let parsed = formatter.date(from: value) else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "History \(key) must be an ISO date.")
                }
                return parsed
            }
            from = try date("from") ?? Date(timeIntervalSince1970: 0)
            to = try date("to") ?? Date()
            guard from <= to else { throw Failure(code: "INVALID_ARGUMENTS", message: "History from must not be after to.") }
        }
    }

    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.personal-data")
    private let historyStore: (UUID?) throws -> URL

    init(historyStore: @escaping (UUID?) throws -> URL = { try SafariPersonalData.resolveHistoryStore(nativeProfileUUID: $0) }) {
        self.historyStore = historyStore
    }

    /// nativeProfileUUID comes only from SFExtensionProfileKey in the native
    /// extension context. nil denotes its observed absent-key default profile.
    func handle(_ command: [String: Any], nativeProfileUUID: UUID?, isAuthorized: @escaping () -> Bool,
                reply: @escaping ([String: Any]) -> Void) {
        queue.async {
            do {
                let authorized = { DispatchQueue.main.sync(execute: isAuthorized) }
                guard command["action"] as? String == "history", let profile = command["profileId"] as? String,
                      !profile.isEmpty, let arguments = command["arguments"] as? [String: Any] else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "Expected an owner-bound Safari history request.")
                }
                guard authorized() else { throw Failure(code: "STALE_OWNER", message: "The original side-chat owner changed.") }
                let request = try HistoryRequest(arguments)
                let store = try self.historyStore(nativeProfileUUID)
                let history = try Self.readHistory(store: store, request: request, isAuthorized: authorized)
                guard authorized() else { throw Failure(code: "STALE_OWNER", message: "The original side-chat owner changed.") }
                reply(["ok": true, "result": history])
            } catch {
                let error = error as? Failure ?? Failure(code: "HISTORY_READ_FAILED", message: "Safari history could not be read.")
                reply(["ok": false, "error": ["code": error.code, "message": error.message]])
            }
        }
    }

    static func resolveHistoryStore(nativeProfileUUID: UUID?, home: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> URL {
        let safari = home.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/Safari", isDirectory: true)
        let metadata = safari.appendingPathComponent("SafariTabs.db")
        let descriptor = Darwin.open(metadata.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            throw Failure(code: errno == EPERM || errno == EACCES ? "PROFILE_METADATA_ACCESS_DENIED" : "PROFILE_METADATA_UNAVAILABLE",
                          message: "The app cannot read Safari profile metadata with its current macOS access.")
        }
        Darwin.close(descriptor)
        var database: OpaquePointer?
        guard sqlite3_open_v2(metadata.path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK,
              let database else {
            if let database { sqlite3_close(database) }
            throw Failure(code: "PROFILE_METADATA_UNAVAILABLE", message: "Safari profile metadata could not be opened read-only.")
        }
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        let query = "SELECT external_uuid FROM bookmarks WHERE type = 1 AND subtype = 2 AND external_uuid = ? COLLATE NOCASE LIMIT 2"
        guard sqlite3_prepare_v2(database, query, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw Failure(code: "PROFILE_METADATA_UNSUPPORTED", message: "Safari profile metadata uses an unsupported schema.")
        }
        defer { sqlite3_finalize(statement) }
        let expected = nativeProfileUUID?.uuidString ?? "DefaultProfile"
        sqlite3_bind_text(statement, 1, expected, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        guard sqlite3_step(statement) == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else {
            throw Failure(code: "HISTORY_PROFILE_UNBOUND", message: "The native Safari profile does not match a verified history store.")
        }
        let identifier = String(cString: text)
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw Failure(code: "HISTORY_PROFILE_UNBOUND", message: "The native Safari profile has no unique history-store identity.")
        }
        if nativeProfileUUID == nil {
            guard identifier == "DefaultProfile" else {
                throw Failure(code: "HISTORY_PROFILE_UNBOUND", message: "Safari's default history-store identity was not verified.")
            }
            return home.appendingPathComponent("Library/Safari/History.db")
        }
        guard UUID(uuidString: identifier) == nativeProfileUUID else {
            throw Failure(code: "HISTORY_PROFILE_UNBOUND", message: "The native Safari profile does not match its history-store identity.")
        }
        return safari.appendingPathComponent("Profiles", isDirectory: true).appendingPathComponent(identifier, isDirectory: true).appendingPathComponent("History.db")
    }

    static func readHistory(store: URL, request: HistoryRequest, isAuthorized: @escaping () -> Bool = { true }) throws -> [[String: String]] {
        guard store.isFileURL else { throw Failure(code: "HISTORY_PROFILE_UNBOUND", message: "The Safari profile has no verified local history store.") }
        let descriptor = Darwin.open(store.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            switch errno {
            case EACCES, EPERM:
                throw Failure(code: "HISTORY_ACCESS_DENIED", message: "macOS denied this app access to Safari history. Allow access to Safari data in System Settings, then try again.")
            case ENOENT:
                throw Failure(code: "HISTORY_STORE_NOT_FOUND", message: "The bound Safari profile history store is unavailable.")
            default:
                throw Failure(code: "HISTORY_READ_FAILED", message: "The bound Safari history store could not be opened read-only.")
            }
        }
        var metadata = stat()
        let regular = fstat(descriptor, &metadata) == 0 && (metadata.st_mode & S_IFMT) == S_IFREG
        Darwin.close(descriptor)
        guard regular else { throw Failure(code: "HISTORY_READ_FAILED", message: "The bound Safari history store is not a regular database.") }
        var database: OpaquePointer?
        let opened = sqlite3_open_v2(store.path, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil)
        defer { if let database { sqlite3_close(database) } }
        guard opened == SQLITE_OK, let database, sqlite3_db_readonly(database, "main") == 1 else {
            let systemError = database.map { sqlite3_system_errno($0) } ?? 0
            if systemError == EPERM || systemError == EACCES {
                throw Failure(code: "HISTORY_ACCESS_DENIED", message: "macOS denied the app access to Safari history or its read-only journal.")
            }
            throw Failure(code: "HISTORY_READ_FAILED", message: "Safari history could not be opened read-only.")
        }
        sqlite3_busy_timeout(database, 250)
        let deadline = Date().addingTimeInterval(5)
        final class Progress {
            let deadline: Date
            let authorized: () -> Bool
            init(_ deadline: Date, _ authorized: @escaping () -> Bool) { self.deadline = deadline; self.authorized = authorized }
        }
        let progress = Progress(deadline, isAuthorized)
        sqlite3_progress_handler(database, 1000, { pointer in
            guard let pointer else { return 1 }
            let value = Unmanaged<Progress>.fromOpaque(pointer).takeUnretainedValue()
            return Date() > value.deadline || !value.authorized() ? 1 : 0
        }, Unmanaged.passUnretained(progress).toOpaque())
        defer { sqlite3_progress_handler(database, 0, nil, nil); withExtendedLifetime(progress) {} }
        sqlite3_create_function_v2(database, "safari_contains", 2, SQLITE_UTF8 | SQLITE_DETERMINISTIC, nil, { context, count, values in
            guard count == 2, let values, let first = sqlite3_value_text(values[0]), let second = sqlite3_value_text(values[1]) else {
                sqlite3_result_int(context, 0); return
            }
            let haystack = String(cString: first), needle = String(cString: second)
            sqlite3_result_int(context, haystack.range(of: needle, options: [.caseInsensitive], locale: Locale(identifier: "en_US_POSIX")) == nil ? 0 : 1)
        }, nil, nil, nil)
        let sql = """
        WITH recent AS (
          SELECT i.url, v.title, v.visit_time,
                 ROW_NUMBER() OVER (PARTITION BY i.url ORDER BY v.visit_time DESC, v.id DESC) AS position
          FROM history_items AS i JOIN history_visits AS v ON v.history_item = i.id
          WHERE v.visit_time >= ? AND v.visit_time <= ?
        )
        SELECT url, title, visit_time FROM recent WHERE position = 1
          AND (? = '' OR safari_contains(url, ?) OR safari_contains(COALESCE(title, ''), ?))
        ORDER BY visit_time DESC, url ASC LIMIT ?
        """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw Failure(code: "HISTORY_SCHEMA_UNSUPPORTED", message: "The Safari history database schema is not supported.")
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var found: [String: (Date, [String: String])] = [:]
        for query in request.queries {
            guard isAuthorized() else { throw Failure(code: "STALE_OWNER", message: "The original side-chat owner changed.") }
            sqlite3_reset(statement); sqlite3_clear_bindings(statement)
            sqlite3_bind_double(statement, 1, request.from.timeIntervalSinceReferenceDate)
            sqlite3_bind_double(statement, 2, request.to.timeIntervalSinceReferenceDate)
            for index: Int32 in [3, 4, 5] { sqlite3_bind_text(statement, index, query, -1, transient) }
            sqlite3_bind_int(statement, 6, Int32(request.limit))
            var status = sqlite3_step(statement)
            while status == SQLITE_ROW {
                if let rawURL = sqlite3_column_text(statement, 0) {
                    let url = String(cString: rawURL)
                    let date = Date(timeIntervalSinceReferenceDate: sqlite3_column_double(statement, 2))
                    var item = ["url": url, "dateVisited": formatter.string(from: date)]
                    if let title = sqlite3_column_text(statement, 1) { item["title"] = String(cString: title) }
                    if found[url] == nil || found[url]!.0 < date { found[url] = (date, item) }
                }
                status = sqlite3_step(statement)
            }
            guard status == SQLITE_DONE else {
                if !isAuthorized() { throw Failure(code: "STALE_OWNER", message: "The original side-chat owner changed.") }
                throw Failure(code: status == SQLITE_INTERRUPT ? "HISTORY_QUERY_TIMEOUT" : "HISTORY_READ_FAILED",
                              message: status == SQLITE_INTERRUPT ? "The bounded Safari history query timed out." : "Safari history changed or could not be read.")
            }
        }
        return found.values.sorted { $0.0 == $1.0 ? $0.1["url"]! < $1.1["url"]! : $0.0 > $1.0 }
            .prefix(request.limit).map { $0.1 }
    }
}
