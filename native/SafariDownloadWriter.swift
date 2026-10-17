import Foundation
import Darwin

/// Writes bounded downloads received from the owning ordinary-profile page.
/// The live broker validates operation, profile, session, and owner before every
/// call. This class receives bytes and asset-manifest metadata, never browser
/// credentials or instructions to fetch URLs.
/// All methods run on the containing app's serial download I/O queue.
final class SafariDownloadWriter {
    static let maximumBytes = 32 * 1024 * 1024
    static let maximumChunkBytes = 48 * 1024
    private struct Transfer {
        let id: String
        let operationID: String
        let filename: String
        let directory: URL
        let bundleID: String?
        let partial: URL
        let descriptor: Int32
        var bytes = 0
        var sequence = 0
    }
    private struct Bundle {
        let id: String
        let operationID: String
        let directory: URL
        var files: Set<String> = []
        var bytes = 0
    }
    private let directory: URL
    private var transfers: [String: Transfer] = [:]
    private var bundles: [String: Bundle] = [:]

    init(directory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads", isDirectory: true)) {
        self.directory = directory
    }

    func handle(_ input: [String: Any], operationID: String, isAuthorized: () -> Bool = { true }) -> [String: Any] {
        do {
            guard !operationID.isEmpty else { throw Failure("STALE_DOWNLOAD", "The download operation is no longer active.") }
            func requireAuthorization() throws {
                guard isAuthorized() else {
                    throw Failure("STALE_DOWNLOAD", "The sidebar owner or download operation changed. The incomplete file was discarded.")
                }
            }
            try requireAuthorization()
            if input["action"] as? String == "bundleBegin" {
                guard !bundles.values.contains(where: { $0.operationID == operationID }),
                      !transfers.values.contains(where: { $0.operationID == operationID }) else {
                    throw Failure("INVALID_BUNDLE", "This operation already owns an active download or asset bundle.")
                }
                let id = UUID().uuidString
                let destination = directory.appendingPathComponent("ChatGPT Page Assets \(id)", isDirectory: true)
                try requireAuthorization()
                guard mkdir(destination.path, S_IRWXU) == 0 else {
                    throw Failure(errno == EACCES || errno == EPERM ? "DOWNLOAD_ACCESS_DENIED" : "DOWNLOAD_WRITE_FAILED",
                                  "macOS could not create a private page-asset directory in Downloads.")
                }
                bundles[id] = Bundle(id: id, operationID: operationID, directory: destination)
                var attributes = stat()
                guard lstat(destination.path, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFDIR,
                      attributes.st_uid == getuid(), attributes.st_mode & 0o777 == 0o700 else {
                    throw Failure("DOWNLOAD_WRITE_FAILED", "The private asset directory could not be verified.")
                }
                try requireAuthorization()
                return Self.success(["bundleId": id, "directoryPath": destination.path])
            }
            if ["bundleFinish", "bundleCancel"].contains(input["action"] as? String ?? "") {
                guard let id = input["bundleId"] as? String, let bundle = bundles[id], bundle.operationID == operationID else {
                    throw Failure("STALE_DOWNLOAD", "This page-asset bundle no longer belongs to the live operation.")
                }
                if input["action"] as? String == "bundleCancel" {
                    cancel(operationID: operationID)
                    return Self.success(["cancelled": true, "completedFilesPreserved": true])
                }
                guard !transfers.values.contains(where: { $0.operationID == operationID }),
                      let manifest = input["manifest"] as? [String: Any],
                      let assets = manifest["assets"] as? [[String: Any]], manifest["failures"] is [[String: Any]],
                      assets.allSatisfy({ ($0["path"] as? String).map(bundle.files.contains) == true }),
                      JSONSerialization.isValidJSONObject(manifest) else {
                    throw Failure("INVALID_BUNDLE", "A complete asset manifest must reference only files actually saved by this bundle.")
                }
                let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
                guard data.count <= 512 * 1024 else { throw Failure("INVALID_BUNDLE", "The page-asset manifest is too large.") }
                let opened = try Self.unwrap(handle(["action": "begin", "filename": "manifest.json", "bundleId": id], operationID: operationID, isAuthorized: isAuthorized))
                let transferID = opened["transferId"] as! String
                var sequence = 0
                for offset in stride(from: 0, to: data.count, by: Self.maximumChunkBytes) {
                    let chunk = data.subdata(in: offset..<min(offset + Self.maximumChunkBytes, data.count))
                    _ = try Self.unwrap(handle(["action": "append", "transferId": transferID, "sequence": sequence,
                                                "data": chunk.base64EncodedString()], operationID: operationID, isAuthorized: isAuthorized))
                    sequence += 1
                }
                let saved = try Self.unwrap(handle(["action": "finish", "transferId": transferID, "sequence": sequence,
                                                      "expectedBytes": data.count], operationID: operationID, isAuthorized: isAuthorized))
                bundles.removeValue(forKey: id)
                return Self.success(["directoryPath": bundle.directory.path, "manifestPath": saved["path"]!])
            }
            if input["action"] as? String == "begin" {
                guard !transfers.values.contains(where: { $0.operationID == operationID }),
                      let filename = input["filename"] as? String else {
                    throw Failure("INVALID_DOWNLOAD", "A new download requires a filename and an unused operation.")
                }
                var destination = directory
                let bundleID = input["bundleId"] as? String
                if bundleID == nil && bundles.values.contains(where: { $0.operationID == operationID }) {
                    throw Failure("INVALID_BUNDLE", "An asset-bundle operation must use its private bundle destination.")
                }
                if let bundleID {
                    guard let bundle = bundles[bundleID], bundle.operationID == operationID, bundle.files.count < 256 else {
                        throw Failure("STALE_DOWNLOAD", "The page-asset destination is no longer valid or exceeds 256 files.")
                    }
                    destination = bundle.directory
                }
                // Creating a new file in Downloads is an explicitly permitted
                // macOS file-access path. Do not open/read the entire parent
                // directory: that requests access to unrelated existing files
                // and can wait for a separate system permission prompt.
                let id = UUID().uuidString
                let partial = destination.appendingPathComponent(".chatgpt-\(id).download")
                try requireAuthorization()
                let descriptor = open(partial.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
                guard descriptor >= 0 else {
                    if errno == EACCES || errno == EPERM { throw Failure("DOWNLOAD_ACCESS_DENIED", "macOS did not allow creation of a new file in Downloads.") }
                    throw Failure("DOWNLOAD_WRITE_FAILED", "Could not create a private download file.")
                }
                transfers[id] = Transfer(id: id, operationID: operationID, filename: Self.safeFilename(filename),
                                         directory: destination, bundleID: bundleID, partial: partial, descriptor: descriptor)
                var attributes = stat()
                guard fstat(descriptor, &attributes) == 0, attributes.st_mode & S_IFMT == S_IFREG,
                      attributes.st_uid == getuid(), fchmod(descriptor, S_IRUSR | S_IWUSR) == 0 else {
                    throw Failure("DOWNLOAD_WRITE_FAILED", "The private download file could not be verified.")
                }
                try requireAuthorization()
                return Self.success(["transferId": id, "maximumBytes": Self.maximumBytes, "chunkBytes": Self.maximumChunkBytes])
            }
            guard let id = input["transferId"] as? String, var transfer = transfers[id], transfer.operationID == operationID else {
                throw Failure("STALE_DOWNLOAD", "The download no longer belongs to this live operation.")
            }
            if input["action"] as? String == "abort" {
                discard(id)
                return Self.success(["aborted": true])
            }
            guard let sequence = Self.integer(input["sequence"]), sequence == transfer.sequence else {
                discard(id)
                throw Failure("DOWNLOAD_SEQUENCE", "Download chunks arrived out of order. The incomplete file was discarded.")
            }
            switch input["action"] as? String {
            case "append":
                guard let encoded = input["data"] as? String, encoded.utf8.count <= (Self.maximumChunkBytes + 2) / 3 * 4,
                      let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= Self.maximumChunkBytes,
                      transfer.bytes <= Self.maximumBytes - data.count else {
                    discard(id)
                    throw Failure("DOWNLOAD_SIZE", "Download data is invalid or exceeds the 32 MiB limit. The incomplete file was discarded.")
                }
                if let bundleID = transfer.bundleID {
                    guard let bundle = bundles[bundleID], bundle.operationID == operationID,
                          bundle.bytes <= Self.maximumBytes - transfer.bytes - data.count else {
                        throw Failure("DOWNLOAD_SIZE", "The page-asset bundle exceeds its combined 32 MiB limit.")
                    }
                }
                try data.withUnsafeBytes { buffer in
                    var offset = 0
                    while offset < buffer.count {
                        try requireAuthorization()
                        let count = Darwin.write(transfer.descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                        if count < 0 && errno == EINTR { continue }
                        guard count > 0 else { throw Failure("DOWNLOAD_WRITE_FAILED", "Could not write the download file.") }
                        offset += count
                    }
                }
                try requireAuthorization()
                transfer.bytes += data.count
                transfer.sequence += 1
                transfers[id] = transfer
                return Self.success(["bytesWritten": transfer.bytes, "sequence": transfer.sequence])
            case "finish":
                guard let expected = Self.integer(input["expectedBytes"]), expected == transfer.bytes,
                      fsync(transfer.descriptor) == 0 else {
                    discard(id)
                    throw Failure("DOWNLOAD_INCOMPLETE", "The complete download could not be verified. The incomplete file was discarded.")
                }
                // Keep all downloaded file types quarantined and nonexecutable.
                // No downloaded document or application is opened automatically.
                let quarantine = "0081;\(String(Int(Date().timeIntervalSince1970), radix: 16));ChatGPT for Safari;\(UUID().uuidString)"
                let marked = quarantine.withCString { value in
                    fsetxattr(transfer.descriptor, "com.apple.quarantine", value, strlen(value), 0, 0)
                }
                guard marked == 0 else {
                    discard(id)
                    throw Failure("DOWNLOAD_QUARANTINE", "The downloaded file could not be marked for macOS safety checks.")
                }
                var saved: URL?
                for index in 0..<10000 {
                    try requireAuthorization()
                    let filename = Self.collisionFilename(transfer.filename, index: index)
                    let candidate = transfer.directory.appendingPathComponent(filename)
                    // Publish the owned partial by an atomic exclusive move,
                    // never by creating another hard-link alias. A file,
                    // directory, or symlink appearing here is not overwritten.
                    if renamex_np(transfer.partial.path, candidate.path, UInt32(RENAME_EXCL)) == 0 { saved = candidate; break }
                    guard errno == EEXIST else { throw Failure("DOWNLOAD_SAVE_FAILED", "Could not save the completed download.") }
                }
                guard let saved else { throw Failure("DOWNLOAD_COLLISIONS", "There are too many downloads with this filename.") }
                let bytes = transfer.bytes
                if let bundleID = transfer.bundleID, var bundle = bundles[bundleID] {
                    bundle.files.insert(saved.path); bundle.bytes += bytes; bundles[bundleID] = bundle
                }
                transfers.removeValue(forKey: id)
                Darwin.close(transfer.descriptor)
                return Self.success(["state": "complete", "path": saved.path, "filename": saved.lastPathComponent, "bytesWritten": bytes])
            default:
                discard(id)
                throw Failure("INVALID_DOWNLOAD", "Unknown download write operation.")
            }
        } catch let failure as Failure {
            cancel(operationID: operationID)
            return ["ok": false, "error": ["code": failure.code, "message": failure.message]]
        } catch {
            cancel(operationID: operationID)
            return ["ok": false, "error": ["code": "DOWNLOAD_WRITE_FAILED", "message": "The download could not be saved. The incomplete file was discarded."]]
        }
    }

    func cancel(operationID: String) {
        for id in transfers.values.filter({ $0.operationID == operationID }).map(\.id) { discard(id) }
        for bundle in bundles.values.filter({ $0.operationID == operationID }) {
            bundles.removeValue(forKey: bundle.id)
            // rmdir removes only our own empty directory. Completed files and
            // any user-added files are never recursively deleted.
            rmdir(bundle.directory.path)
        }
    }

    func close() {
        for id in Array(transfers.keys) { discard(id) }
        for bundle in Array(bundles.values) { bundles.removeValue(forKey: bundle.id); rmdir(bundle.directory.path) }
    }
    deinit { close() }

    private func discard(_ id: String) {
        guard let transfer = transfers.removeValue(forKey: id) else { return }
        Darwin.close(transfer.descriptor)
        // Only the unpredictable, exclusively created partial is removed.
        unlink(transfer.partial.path)
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= 0, number.doubleValue < Double(Int.max) else { return nil }
        return number.intValue
    }

    private static func safeFilename(_ name: String) -> String {
        var result = String(name.unicodeScalars.map { scalar -> Character in
            if CharacterSet.controlCharacters.contains(scalar) || "/\\:".unicodeScalars.contains(scalar) { return "_" }
            return Character(String(scalar))
        }).trimmingCharacters(in: .whitespacesAndNewlines)
        while result.hasPrefix(".") { result.removeFirst() }
        if result.isEmpty { result = "download" }
        while result.utf8.count > 180 { result.removeLast() }
        return result
    }

    private static func collisionFilename(_ filename: String, index: Int) -> String {
        guard index > 0 else { return filename }
        let value = filename as NSString
        let ext = value.pathExtension
        let stem = ext.isEmpty ? filename : value.deletingPathExtension
        return "\(stem) (\(index))" + (ext.isEmpty ? "" : ".\(ext)")
    }

    private struct Failure: Error { let code: String; let message: String
        init(_ code: String, _ message: String) { self.code = code; self.message = message }
    }
    private static func unwrap(_ value: [String: Any]) throws -> [String: Any] {
        if value["ok"] as? Bool == true, let result = value["result"] as? [String: Any] { return result }
        let error = value["error"] as? [String: Any]
        throw Failure(error?["code"] as? String ?? "DOWNLOAD_WRITE_FAILED", error?["message"] as? String ?? "The asset bundle could not be completed.")
    }
    private static func success(_ value: [String: Any]) -> [String: Any] { ["ok": true, "result": value] }
}
