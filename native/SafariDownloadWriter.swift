import Foundation
import Darwin

/// Writes bounded downloads received from the owning ordinary-profile page.
/// The live broker validates operation, profile, session, and owner before every
/// call. This class receives bytes only, never browser credentials or fetch URLs.
/// All methods run on the containing app's serial download I/O queue.
final class SafariDownloadWriter {
    static let maximumBytes = 32 * 1024 * 1024
    static let maximumChunkBytes = 48 * 1024
    private struct Transfer {
        let id: String
        let operationID: String
        let filename: String
        let partial: URL
        let descriptor: Int32
        var bytes = 0
        var sequence = 0
    }
    private let directory: URL
    private var transfers: [String: Transfer] = [:]

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
            if input["action"] as? String == "begin" {
                guard !transfers.values.contains(where: { $0.operationID == operationID }),
                      let filename = input["filename"] as? String else {
                    throw Failure("INVALID_DOWNLOAD", "A new download requires a filename and an unused operation.")
                }
                // Creating a new file in Downloads is an explicitly permitted
                // macOS file-access path. Do not open/read the entire parent
                // directory: that requests access to unrelated existing files
                // and can wait for a separate system permission prompt.
                let id = UUID().uuidString
                let partial = directory.appendingPathComponent(".chatgpt-\(id).download")
                try requireAuthorization()
                let descriptor = open(partial.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
                guard descriptor >= 0 else {
                    if errno == EACCES || errno == EPERM { throw Failure("DOWNLOAD_ACCESS_DENIED", "macOS did not allow creation of a new file in Downloads.") }
                    throw Failure("DOWNLOAD_WRITE_FAILED", "Could not create a private download file.")
                }
                transfers[id] = Transfer(id: id, operationID: operationID, filename: Self.safeFilename(filename),
                                         partial: partial, descriptor: descriptor)
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
                    let candidate = directory.appendingPathComponent(filename)
                    // Publish the owned partial by an atomic exclusive move,
                    // never by creating another hard-link alias. A file,
                    // directory, or symlink appearing here is not overwritten.
                    if renamex_np(transfer.partial.path, candidate.path, UInt32(RENAME_EXCL)) == 0 { saved = candidate; break }
                    guard errno == EEXIST else { throw Failure("DOWNLOAD_SAVE_FAILED", "Could not save the completed download.") }
                }
                guard let saved else { throw Failure("DOWNLOAD_COLLISIONS", "There are too many downloads with this filename.") }
                let bytes = transfer.bytes
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
    }

    func close() { for id in Array(transfers.keys) { discard(id) } }
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
    private static func success(_ value: [String: Any]) -> [String: Any] { ["ok": true, "result": value] }
}
