import Foundation
import Darwin

@main struct Test {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("chatgpt-download-writer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let writer = SafariDownloadWriter(directory: directory)
        let original = directory.appendingPathComponent("report.txt")
        try Data("original".utf8).write(to: original)
        let operation = UUID().uuidString
        func result(_ value: [String: Any]) -> [String: Any] {
            precondition(value["ok"] as? Bool == true, "Expected a successful writer response: \(value)")
            return value["result"] as! [String: Any]
        }
        func begin(_ filename: String, owner: String = operation) -> String {
            result(writer.handle(["action": "begin", "filename": filename], operationID: owner))["transferId"] as! String
        }
        let id = begin("report.txt")
        let content = Data("ordinary Safari session download ✓".utf8)
        let appended = result(writer.handle(["action": "append", "transferId": id, "sequence": 0,
                                              "data": content.base64EncodedString()], operationID: operation))
        precondition(appended["bytesWritten"] as? Int == content.count)
        let partial = directory.appendingPathComponent(".chatgpt-\(id).download")
        var partialAttributes = stat()
        precondition(lstat(partial.path, &partialAttributes) == 0)
        let saved = result(writer.handle(["action": "finish", "transferId": id, "sequence": 1,
                                          "expectedBytes": content.count], operationID: operation))
        let savedURL = URL(fileURLWithPath: saved["path"] as! String)
        precondition(savedURL.lastPathComponent == "report (1).txt")
        let originalBytes = try Data(contentsOf: original), savedBytes = try Data(contentsOf: savedURL)
        precondition(originalBytes == Data("original".utf8), "A completed download must not overwrite an existing file")
        precondition(savedBytes == content)
        var attributes = stat()
        precondition(lstat(savedURL.path, &attributes) == 0 && attributes.st_mode & 0o777 == 0o600)
        precondition(attributes.st_ino == partialAttributes.st_ino && attributes.st_nlink == 1,
                     "Publication must retain the owned inode without creating a hard-link alias")
        precondition(lstat(partial.path, &partialAttributes) != 0 && errno == ENOENT,
                     "Atomic publication must move the partial out of its temporary name")
        precondition(getxattr(savedURL.path, "com.apple.quarantine", nil, 0, 0, 0) > 0, "Downloaded files must retain macOS quarantine")

        let otherOperation = UUID().uuidString
        let staleID = begin("stale.txt", owner: otherOperation)
        let stolen = writer.handle(["action": "append", "transferId": staleID, "sequence": 0, "data": "eA=="], operationID: operation)
        precondition(stolen["ok"] as? Bool == false, "Another operation cannot append bytes")
        writer.cancel(operationID: otherOperation)
        precondition(writer.handle(["action": "finish", "transferId": staleID, "sequence": 0, "expectedBytes": 0], operationID: otherOperation)["ok"] as? Bool == false)

        let replayID = begin("replay.txt")
        _ = result(writer.handle(["action": "append", "transferId": replayID, "sequence": 0, "data": "eA=="], operationID: operation))
        precondition(writer.handle(["action": "append", "transferId": replayID, "sequence": 0, "data": "eA=="], operationID: operation)["ok"] as? Bool == false)
        precondition(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("replay.txt").path))
        let largeID = begin("large.txt")
        precondition(writer.handle(["action": "append", "transferId": largeID, "sequence": 0,
                                   "data": Data(repeating: 1, count: SafariDownloadWriter.maximumChunkBytes + 1).base64EncodedString()], operationID: operation)["ok"] as? Bool == false)
        let incomplete = begin("incomplete.txt")
        precondition(writer.handle(["action": "finish", "transferId": incomplete, "sequence": 0,
                                   "expectedBytes": 1], operationID: operation)["ok"] as? Bool == false)

        let safe = begin("../../outside.txt")
        let safeSaved = result(writer.handle(["action": "finish", "transferId": safe, "sequence": 0, "expectedBytes": 0], operationID: operation))
        precondition(URL(fileURLWithPath: safeSaved["path"] as! String).deletingLastPathComponent() == directory)
        let symlink = directory.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: original)
        let linkID = begin("link.txt")
        let linkSaved = result(writer.handle(["action": "finish", "transferId": linkID, "sequence": 0, "expectedBytes": 0], operationID: operation))
        precondition((linkSaved["filename"] as? String) == "link (1).txt", "A symlink cannot replace the completed file")
        let originalAfterSymlink = try Data(contentsOf: original)
        precondition(originalAfterSymlink == Data("original".utf8))
        let lateID = begin("late.txt")
        let lateDestination = directory.appendingPathComponent("late.txt")
        try Data("created after begin".utf8).write(to: lateDestination)
        let lateSaved = result(writer.handle(["action": "finish", "transferId": lateID, "sequence": 0, "expectedBytes": 0], operationID: operation))
        let lateOriginalBytes = try Data(contentsOf: lateDestination)
        precondition(lateSaved["filename"] as? String == "late (1).txt" && lateOriginalBytes == Data("created after begin".utf8),
                     "A destination appearing after begin must never be overwritten")
        let directoryDestination = directory.appendingPathComponent("folder.txt", isDirectory: true)
        try FileManager.default.createDirectory(at: directoryDestination, withIntermediateDirectories: false)
        let directoryCollisionID = begin("folder.txt")
        let directoryCollision = result(writer.handle(["action": "finish", "transferId": directoryCollisionID,
                                                        "sequence": 0, "expectedBytes": 0], operationID: operation))
        var directoryAttributes = stat()
        precondition(directoryCollision["filename"] as? String == "folder (1).txt"
                     && lstat(directoryDestination.path, &directoryAttributes) == 0 && directoryAttributes.st_mode & S_IFMT == S_IFDIR,
                     "An existing directory must not be replaced by a completed download")

        let deniedBegin = writer.handle(["action": "begin", "filename": "denied-begin.txt"], operationID: operation, isAuthorized: { false })
        precondition((deniedBegin["error"] as? [String: Any])?["code"] as? String == "STALE_DOWNLOAD")
        var beginChecks = 0
        let cancelledBegin = writer.handle(["action": "begin", "filename": "cancelled-begin.txt"], operationID: operation, isAuthorized: {
            beginChecks += 1
            return beginChecks < 3
        })
        precondition(beginChecks == 3 && cancelledBegin["ok"] as? Bool == false,
                     "Owner invalidation after creating the partial must discard it")
        let cancelledAppend = begin("cancelled-append.txt")
        var appendChecks = 0
        let appendResult = writer.handle(["action": "append", "transferId": cancelledAppend, "sequence": 0,
                                          "data": content.base64EncodedString()], operationID: operation, isAuthorized: {
            appendChecks += 1
            return appendChecks < 2
        })
        precondition(appendChecks == 2 && appendResult["ok"] as? Bool == false,
                     "Owner invalidation before writing a chunk must discard the partial")
        let cancelledFinish = begin("cancelled-finish.txt")
        _ = result(writer.handle(["action": "append", "transferId": cancelledFinish, "sequence": 0,
                                   "data": content.base64EncodedString()], operationID: operation))
        var finishChecks = 0
        let finishResult = writer.handle(["action": "finish", "transferId": cancelledFinish, "sequence": 1,
                                          "expectedBytes": content.count], operationID: operation, isAuthorized: {
            finishChecks += 1
            return finishChecks < 2
        })
        precondition(finishChecks == 2 && finishResult["ok"] as? Bool == false,
                     "Owner invalidation after flush and quarantine must prevent final publication")
        for name in ["denied-begin.txt", "cancelled-begin.txt", "cancelled-append.txt", "cancelled-finish.txt"] {
            var entry = stat()
            precondition(lstat(directory.appendingPathComponent(name).path, &entry) != 0 && errno == ENOENT,
                         "A cancelled operation must not publish \(name)")
        }
        let notDirectory = SafariDownloadWriter(directory: original)
        precondition(notDirectory.handle(["action": "begin", "filename": "not-a-directory.txt"], operationID: operation)["ok"] as? Bool == false)

        // Downloads only needs permission to create its own files. Reproduce a
        // parent where directory reading is unavailable but creation is valid.
        let createOnlyDirectory = directory.appendingPathComponent("create-only", isDirectory: true)
        try FileManager.default.createDirectory(at: createOnlyDirectory, withIntermediateDirectories: false)
        precondition(chmod(createOnlyDirectory.path, 0o300) == 0)
        defer { chmod(createOnlyDirectory.path, 0o700) }
        let directoryRead = open(createOnlyDirectory.path, O_RDONLY | O_DIRECTORY)
        precondition(directoryRead < 0 && errno == EACCES, "The regression fixture must deny opening the parent for reading")
        let createOnlyWriter = SafariDownloadWriter(directory: createOnlyDirectory)
        let createOnlyID = result(createOnlyWriter.handle(["action": "begin", "filename": "created.txt"], operationID: operation))["transferId"] as! String
        _ = result(createOnlyWriter.handle(["action": "append", "transferId": createOnlyID, "sequence": 0,
                                             "data": content.base64EncodedString()], operationID: operation))
        let created = result(createOnlyWriter.handle(["action": "finish", "transferId": createOnlyID, "sequence": 1,
                                                       "expectedBytes": content.count], operationID: operation))
        let createdBytes = try Data(contentsOf: URL(fileURLWithPath: created["path"] as! String))
        precondition(createdBytes == content, "Creating and publishing a download must not require parent-directory read access")
        precondition(chmod(createOnlyDirectory.path, 0o000) == 0)
        let deniedCreate = createOnlyWriter.handle(["action": "begin", "filename": "denied-create.txt"], operationID: operation)
        precondition((deniedCreate["error"] as? [String: Any])?["code"] as? String == "DOWNLOAD_ACCESS_DENIED",
                     "An actual filesystem access denial must be returned, not bypassed")
        precondition(chmod(createOnlyDirectory.path, 0o700) == 0)

        let bundleOperation = UUID().uuidString
        let bundle = result(writer.handle(["action": "bundleBegin"], operationID: bundleOperation))
        let bundleID = bundle["bundleId"] as! String
        let bundleDirectory = URL(fileURLWithPath: bundle["directoryPath"] as! String, isDirectory: true)
        var bundleAttributes = stat()
        precondition(lstat(bundleDirectory.path, &bundleAttributes) == 0 && bundleAttributes.st_mode & 0o777 == 0o700)
        let bundleTransfer = result(writer.handle(["action": "begin", "filename": "asset.svg", "bundleId": bundleID], operationID: bundleOperation))["transferId"] as! String
        _ = result(writer.handle(["action": "append", "transferId": bundleTransfer, "sequence": 0,
                                  "data": content.base64EncodedString()], operationID: bundleOperation))
        let bundleAsset = result(writer.handle(["action": "finish", "transferId": bundleTransfer, "sequence": 1,
                                                 "expectedBytes": content.count], operationID: bundleOperation))
        let bundleAssetURL = URL(fileURLWithPath: bundleAsset["path"] as! String)
        precondition(bundleAssetURL.deletingLastPathComponent() == bundleDirectory)
        let bundleAssetData = try Data(contentsOf: bundleAssetURL)
        precondition(bundleAssetData == content)
        precondition(getxattr(bundleAssetURL.path, "com.apple.quarantine", nil, 0, 0, 0) > 0)
        let manifest = ["assets": [["id": "observed-image", "path": bundleAssetURL.path]], "failures": []] as [String: Any]
        let completeBundle = result(writer.handle(["action": "bundleFinish", "bundleId": bundleID, "manifest": manifest], operationID: bundleOperation))
        let manifestURL = URL(fileURLWithPath: completeBundle["manifestPath"] as! String)
        let manifestObject = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as! [String: Any]
        precondition((manifestObject["assets"] as? [[String: Any]])?.first?["path"] as? String == bundleAssetURL.path)
        precondition(lstat(manifestURL.path, &attributes) == 0 && attributes.st_mode & 0o777 == 0o600)
        precondition(writer.handle(["action": "bundleFinish", "bundleId": bundleID, "manifest": manifest], operationID: bundleOperation)["ok"] as? Bool == false,
                     "Completed bundles cannot be replayed")

        let cancelledBundle = result(writer.handle(["action": "bundleBegin"], operationID: bundleOperation))
        let cancelledBundleID = cancelledBundle["bundleId"] as! String
        let cancelledDirectory = URL(fileURLWithPath: cancelledBundle["directoryPath"] as! String)
        let retainedTransfer = result(writer.handle(["action": "begin", "filename": "retained.txt", "bundleId": cancelledBundleID], operationID: bundleOperation))["transferId"] as! String
        let retained = result(writer.handle(["action": "finish", "transferId": retainedTransfer, "sequence": 0, "expectedBytes": 0], operationID: bundleOperation))
        let bundlePartial = result(writer.handle(["action": "begin", "filename": "partial.txt", "bundleId": cancelledBundleID], operationID: bundleOperation))["transferId"] as! String
        _ = result(writer.handle(["action": "bundleCancel", "bundleId": cancelledBundleID], operationID: bundleOperation))
        precondition(FileManager.default.fileExists(atPath: retained["path"] as! String), "Cancelling a bundle preserves its completed files")
        precondition(!FileManager.default.fileExists(atPath: cancelledDirectory.appendingPathComponent(".chatgpt-\(bundlePartial).download").path),
                     "Cancelling a bundle removes only its own incomplete files")

        let forgedBundle = result(writer.handle(["action": "bundleBegin"], operationID: bundleOperation))
        let forgedBundleID = forgedBundle["bundleId"] as! String
        precondition(writer.handle(["action": "begin", "filename": "stolen.txt", "bundleId": forgedBundleID], operationID: otherOperation)["ok"] as? Bool == false)
        let badManifest: [String: Any] = ["assets": [["path": original.path]], "failures": []]
        precondition(writer.handle(["action": "bundleFinish", "bundleId": forgedBundleID, "manifest": badManifest], operationID: bundleOperation)["ok"] as? Bool == false,
                     "A manifest cannot claim an unrelated file was downloaded")
        writer.close()
        let remaining = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        precondition(remaining.allSatisfy { !$0.hasPrefix(".chatgpt-") }, "No partial downloads may survive completion or rejection")
        print("Download writer saved exact bytes without directory-read access, preserved collision/quarantine/cancellation guards, and returned actual access denial")
    }
}
