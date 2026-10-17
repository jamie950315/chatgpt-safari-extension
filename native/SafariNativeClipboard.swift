import AppKit
import Foundation
import ImageIO

/// Session clipboard bytes cross the OS clipboard only during one real Safari
/// shortcut. Prior user data remains in memory and is restored only while the
/// transient generation is still owned. No file URL is dereferenced.
final class SafariNativeClipboard {
    struct Failure: Error {
        let code: String
        let message: String
        var ownedChangeCount: Int? = nil
    }
    struct Flavor: Equatable { let type: String; let data: Data }
    struct Item: Equatable { let flavors: [Flavor] }
    struct Snapshot: Equatable { let changeCount: Int; let items: [Item] }
    struct Lease { let changeCount: Int; let id: UUID }
    protocol Driver {
        func snapshot() throws -> Snapshot
        func changeCount() -> Int
        func write(_ items: [Item], expectedChangeCount: Int, lazy: Bool) throws -> Lease
        func consumed(_ lease: Lease) -> Bool
        func release(_ lease: Lease)
    }
    struct Plan {
        let operation: String
        let scope: [String: String]
        let items: [Item]
        let receiptToken: String
        init(_ raw: Any?, key: String?) throws {
            guard let raw = raw as? [String: Any], let operation = raw["operation"] as? String,
                  ["copy", "cut", "paste"].contains(operation),
                  key == ["copy": "Meta+c", "cut": "Meta+x", "paste": "Meta+v"][operation],
                  let scope = raw["scope"] as? [String: String],
                  let receiptToken = raw["receiptToken"] as? String, UUID(uuidString: receiptToken) != nil,
                  Set(scope.keys) == ["profileId", "ownerId", "accountScope", "sessionId", "turnId", "tabId", "documentId", "node"],
                  scope.values.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 && !$0.contains("\0") }) else {
                throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "A native clipboard shortcut requires its exact signed-in owner, profile, turn, document and focused page node.")
            }
            self.operation = operation; self.scope = scope; self.receiptToken = receiptToken
            if operation == "paste" { items = try SafariNativeClipboard.decode(raw["items"]) }
            else {
                guard raw["items"] == nil else { throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Copy and cut cannot import OS clipboard contents or accept supplied items.") }
                items = []
            }
        }
    }

    static let maximumBytes = 8 * 1024 * 1024
    static let maximumPreservedBytes = 32 * 1024 * 1024
    private static let mappings: [String: String] = ["text/plain": NSPasteboard.PasteboardType.string.rawValue,
        "text/html": NSPasteboard.PasteboardType.html.rawValue, "text/rtf": NSPasteboard.PasteboardType.rtf.rawValue,
        "image/png": NSPasteboard.PasteboardType.png.rawValue, "image/tiff": NSPasteboard.PasteboardType.tiff.rawValue,
        "image/jpeg": "public.jpeg", "application/pdf": NSPasteboard.PasteboardType.pdf.rawValue]
    private let driver: Driver
    private let receiptLock = NSLock()
    private var activeReceipt: (token: String, scope: [String: String], keyPosted: Bool, received: Bool, generation: Int?)?
    private struct Recovery {
        let original: Snapshot
        var owned: Int
        let lease: Lease?
        let restoreAllowed: Bool
        var awaitingCopyReceipt: Bool
        let copyCandidate: Int?
        init(original: Snapshot, owned: Int, lease: Lease?, restoreAllowed: Bool,
             awaitingCopyReceipt: Bool = false, copyCandidate: Int? = nil) {
            self.original = original; self.owned = owned; self.lease = lease; self.restoreAllowed = restoreAllowed
            self.awaitingCopyReceipt = awaitingCopyReceipt; self.copyCandidate = copyCandidate
        }
    }
    private var recovery: Recovery?
    private let recoveryQueue = DispatchQueue(label: "dev.jamie.chatgpt-safari.clipboard-recovery")
    private var running = false
    private var lastRestoration = "not-needed"
    init(driver: Driver = NativeDriver()) { self.driver = driver }

    func acknowledge(_ input: [String: Any]) {
        receiptLock.lock()
        guard let current = activeReceipt, current.keyPosted, !current.received,
              current.token == input["token"] as? String, current.scope == input["scope"] as? [String: String] else { receiptLock.unlock(); return }
        receiptLock.unlock()
        // Observe only the generation, never clipboard contents. NSPasteboard
        // has no public writer identity/CAS: this is a bound observation for
        // later comparison, not proof of a cross-process writer's identity.
        let generation = driver.changeCount()
        receiptLock.lock()
        guard activeReceipt?.token == current.token, activeReceipt?.received == false else { receiptLock.unlock(); return }
        activeReceipt?.generation = generation; activeReceipt?.received = true
        let mayRecover = !running && recovery != nil
        receiptLock.unlock()
        if mayRecover { recoveryQueue.async { self.recoverIfSafe() } }
    }

    private func receiptReceived() -> Bool {
        receiptLock.lock(); defer { receiptLock.unlock() }; return activeReceipt?.received == true
    }
    private func receiptGeneration() -> Int? {
        receiptLock.lock(); defer { receiptLock.unlock() }; return activeReceipt?.received == true ? activeReceipt?.generation : nil
    }

    private func recoverIfSafe() {
        receiptLock.lock()
        guard !running, var pending = recovery else { receiptLock.unlock(); return }
        // Block a new bridge operation until cleanup finishes on this queue.
        running = true
        let trustedReceipt = activeReceipt?.received == true, generation = activeReceipt?.generation
        let received = trustedReceipt || pending.restoreAllowed
        receiptLock.unlock()
        var finished = false, restoration = "awaiting-trusted-page-receipt"
        if pending.awaitingCopyReceipt, trustedReceipt, let generation {
            if generation == pending.original.changeCount {
                // The trusted event did not establish a new copy publication.
                // Keep the prior bytes until a later generation is observed,
                // but never attribute that unknown writer to this shortcut.
                restoration = "awaiting-native-copy-publication"
                if driver.changeCount() != generation { finished = true; restoration = "newer-change-preserved" }
            } else if let candidate = pending.copyCandidate, candidate != generation {
                finished = true; restoration = "newer-change-preserved"
            } else {
                pending.owned = generation; pending.awaitingCopyReceipt = false
            }
        }
        if !pending.awaitingCopyReceipt, !finished {
            finished = driver.changeCount() != pending.owned
            restoration = finished ? "newer-change-preserved" : received ? "unconfirmed" : "awaiting-trusted-page-receipt"
        }
        if !pending.awaitingCopyReceipt && received && !finished {
            do {
                let restored = try driver.write(pending.original.items, expectedChangeCount: pending.owned, lazy: false)
                pending.owned = restored.changeCount
                defer { driver.release(restored) }
                let verified = try driver.snapshot()
                if verified.changeCount != restored.changeCount { finished = true; restoration = "newer-change-preserved" }
                else if verified.items == pending.original.items { finished = true; restoration = "restored" }
            }
            catch let failure as Failure {
                if let owned = failure.ownedChangeCount { pending.owned = owned }
                if driver.changeCount() != pending.owned { finished = true; restoration = "newer-change-preserved" }
            }
            catch {}
        }
        if finished, let lease = pending.lease { driver.release(lease) }
        receiptLock.lock()
        if finished { recovery = nil; activeReceipt = nil } else { recovery = pending }
        lastRestoration = restoration
        running = false
        receiptLock.unlock()
    }

    func recoveryStatus() -> [String: Any] {
        // Status can release a superseded generation or finish an already
        // acknowledged restoration. It never reads clipboard bytes into logs.
        recoverIfSafe()
        receiptLock.lock(); defer { receiptLock.unlock() }
        return ["pending": recovery != nil, "memoryOnlyPriorHeld": recovery != nil,
                "trustedReceiptObserved": activeReceipt?.received == true, "restoration": lastRestoration]
    }

    static func decode(_ raw: Any?) throws -> [Item] {
        guard let items = raw as? [[String: Any]], !items.isEmpty, items.count <= 32 else {
            throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Native paste requires 1–32 explicit session clipboard items.")
        }
        var total = 0
        return try items.map { item in
            guard let entries = item["entries"] as? [[String: Any]], !entries.isEmpty, entries.count <= mappings.count else {
                throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Every native paste item needs distinct supported MIME entries.")
            }
            var seen = Set<String>()
            let flavors = try entries.map { entry -> Flavor in
                guard let mime = entry["mime_type"] as? String, let type = mappings[mime], seen.insert(type).inserted,
                      (entry["text"] is String) != (entry["base64"] is String) else {
                    throw Failure(code: "NATIVE_CLIPBOARD_MIME_UNSUPPORTED", message: "Native paste supports text/plain, text/html, text/rtf, PNG, TIFF, JPEG and PDF only. File URLs, URI lists and unknown binary types are not pasted or silently downgraded.")
                }
                let data: Data
                if let text = entry["text"] as? String {
                    guard mime.hasPrefix("text/"), !text.contains("\0"), let encoded = text.data(using: .utf8) else {
                        throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Text clipboard entries require valid non-null UTF-8 text and a text MIME type.")
                    }
                    data = encoded
                } else {
                    guard let encoded = entry["base64"] as? String, encoded.utf8.count <= maximumBytes * 4 / 3 + 4,
                          let decoded = Data(base64Encoded: encoded), decoded.base64EncodedString() == encoded else {
                        throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Binary clipboard entries require bounded canonical base64.")
                    }
                    data = decoded
                    guard !mime.hasPrefix("text/") else { throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Text clipboard MIME entries must use text, not binary base64.") }
                    let signatures: [String: [[UInt8]]] = ["image/png": [[137,80,78,71,13,10,26,10]], "image/jpeg": [[255,216,255]],
                        "image/tiff": [[73,73,42,0], [77,77,0,42]], "application/pdf": [[37,80,68,70,45]]]
                    guard signatures[mime]?.contains(where: { data.starts(with: $0) }) == true else {
                        throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "The binary clipboard payload does not match its declared supported MIME signature.")
                    }
                    if mime.hasPrefix("image/") {
                        guard let image = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetStatus(image) == .statusComplete,
                              (1...256).contains(CGImageSourceGetCount(image)) else {
                            throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "The image clipboard payload is incomplete or exceeds bounded native image dimensions.")
                        }
                        var pixels: Double = 0
                        for index in 0..<CGImageSourceGetCount(image) {
                            guard CGImageSourceGetStatusAtIndex(image, index) == .statusComplete,
                                  let properties = CGImageSourceCopyPropertiesAtIndex(image, index, nil) as? [CFString: Any],
                                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                                  let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                                  width.intValue > 0, height.intValue > 0, width.intValue <= 32768, height.intValue <= 32768 else {
                                throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "Every native image frame must be complete and within bounded dimensions.")
                            }
                            pixels += width.doubleValue * height.doubleValue
                            guard pixels <= 64_000_000 else { throw Failure(code: "INVALID_NATIVE_CLIPBOARD", message: "The native image clipboard exceeds the total 64-megapixel frame limit.") }
                        }
                    }
                }
                total += data.count
                guard total <= maximumBytes else { throw Failure(code: "NATIVE_CLIPBOARD_TOO_LARGE", message: "A native session paste is limited to 8 MiB.") }
                return Flavor(type: type, data: data)
            }
            return Item(flavors: flavors)
        }
    }

    static func encode(_ items: [Item]) throws -> ([[String: Any]], [String]) {
        let byType = Dictionary(uniqueKeysWithValues: mappings.map { ($0.value, $0.key) })
        var total = 0, omitted = Set<String>()
        let result: [[String: Any]] = try items.compactMap { item in
            var entries: [[String: Any]] = []
            for flavor in item.flavors {
                guard let mime = byType[flavor.type] else { omitted.insert(flavor.type); continue }
                total += flavor.data.count
                guard total <= maximumBytes else { throw Failure(code: "NATIVE_CLIPBOARD_TOO_LARGE", message: "The copied page selection exceeds the 8 MiB session clipboard limit.") }
                if mime.hasPrefix("text/") {
                    guard let text = String(data: flavor.data, encoding: .utf8), !text.contains("\0") else {
                        throw Failure(code: "NATIVE_CLIPBOARD_ENCODING_UNSUPPORTED", message: "Safari returned a text clipboard flavor without a valid UTF-8 representation.")
                    }
                    entries.append(["mime_type": mime, "text": text])
                } else { entries.append(["mime_type": mime, "base64": flavor.data.base64EncodedString()]) }
            }
            return entries.isEmpty ? nil : ["entries": entries, "presentation_style": "unspecified"]
        }
        guard !result.isEmpty else { throw Failure(code: "NATIVE_CLIPBOARD_MIME_UNSUPPORTED", message: "Safari did not produce a supported page clipboard MIME flavor. OS file URLs and private native formats were not imported.") }
        guard try JSONSerialization.data(withJSONObject: result).count <= maximumBytes else {
            throw Failure(code: "NATIVE_CLIPBOARD_TOO_LARGE", message: "The copied MIME representations exceed the bounded session transport size.")
        }
        return (result, omitted.sorted())
    }

    /// validate and sendKey are the native input engine's exact focused-page
    /// guards and real Cmd+C/X/V. Cleanup never needs renewed page authority.
    func perform(_ plan: Plan, validate: () throws -> Void, sendKey: (_ posted: () -> Void) throws -> Void,
                 pause: (TimeInterval) -> Void = Thread.sleep(forTimeInterval:)) throws -> [String: Any] {
        recoverIfSafe()
        receiptLock.lock()
        guard !running, recovery == nil else { receiptLock.unlock(); throw Failure(code: "CLIPBOARD_RECOVERY_PENDING", message: "A previous native clipboard shortcut still has memory-only recovery pending. Its exact source receipt and observed generation must establish safe cleanup; unknown writers are not imported or overwritten. Do not replay input or restart this app while clipboard status is pending.") }
        running = true; activeReceipt = (plan.receiptToken, plan.scope, false, false, nil)
        receiptLock.unlock()
        defer {
            receiptLock.lock(); running = false
            if recovery == nil { activeReceipt = nil }
            let pending = recovery != nil; receiptLock.unlock()
            if pending { recoveryQueue.async { self.recoverIfSafe() } }
        }
        try validate()
        let original = try driver.snapshot()
        try validate()
        var owned = original.changeCount, lease: Lease?, mutated = false, posted = false
        var result: [String: Any] = [:], pending: Error?
        do {
            if plan.operation == "paste" {
                let value = try driver.write(plan.items, expectedChangeCount: owned, lazy: true)
                lease = value; owned = value.changeCount; mutated = true
            }
            try validate()
            guard driver.changeCount() == owned else { throw Failure(code: "CLIPBOARD_CHANGED", message: "The user clipboard changed before the native shortcut. Newer contents were preserved.") }
            try sendKey {
                // Called immediately after the native key-down is posted. An
                // observer receipt before that point cannot acknowledge it.
                receiptLock.lock(); activeReceipt?.keyPosted = true; receiptLock.unlock()
                posted = true
            }
            guard posted else { throw Failure(code: "NATIVE_CLIPBOARD_FAILED", message: "The native keyboard driver did not confirm posting its shortcut.") }
            let deadline = Date().addingTimeInterval(2)
            if plan.operation == "paste" {
                while !receiptReceived(), Date() < deadline {
                    try validate()
                    guard driver.changeCount() == owned else { throw Failure(code: "CLIPBOARD_CHANGED", message: "The clipboard changed during native paste. Newer contents were preserved; input was not repeated.") }
                    pause(0.025)
                }
                guard receiptReceived() else { throw Failure(code: "NATIVE_CLIPBOARD_RECEIPT_MISSING", message: "The real paste shortcut was delivered without the exact trusted source-node paste receipt. Original private clipboard contents were not restored into a possibly pending paste.") }
                try validate()
                result["nativeDataRead"] = lease.map { driver.consumed($0) } ?? false
                result["trustedPageReceipt"] = true
            } else {
                while !receiptReceived() || driver.changeCount() == original.changeCount {
                    if Date() >= deadline { break }
                    try validate(); pause(0.025)
                }
                guard receiptReceived() else { throw Failure(code: "NATIVE_CLIPBOARD_RECEIPT_MISSING", message: "The real copy/cut shortcut lacks its exact trusted source-node event receipt. No unrelated clipboard generation was imported.") }
                guard let copiedGeneration = receiptGeneration(), copiedGeneration != original.changeCount else { throw Failure(code: "NATIVE_COPY_UNCONFIRMED", message: "Safari did not establish a new clipboard generation at its trusted copy/cut receipt. No existing OS clipboard contents were imported.") }
                owned = copiedGeneration; mutated = true
                guard driver.changeCount() == owned else { throw Failure(code: "CLIPBOARD_CHANGED", message: "A newer clipboard generation arrived after the trusted copy receipt. It was not imported or overwritten.") }
                try validate()
                let copied = try driver.snapshot()
                guard copied.changeCount == owned else { throw Failure(code: "CLIPBOARD_CHANGED", message: "A newer clipboard generation arrived while reading the native copy result. It was preserved.") }
                let (items, omitted) = try Self.encode(copied.items)
                result["items"] = items; result["nativePrivateTypesOmitted"] = omitted
            }
        } catch let failure as Failure { if let count = failure.ownedChangeCount { owned = count; mutated = true }; pending = failure }
        catch { pending = error }
        var restoration = "unchanged"
        if plan.operation != "paste", posted, !mutated {
            let observed = driver.changeCount()
            receiptLock.lock(); recovery = Recovery(original: original, owned: original.changeCount, lease: nil, restoreAllowed: false,
                awaitingCopyReceipt: true, copyCandidate: observed == original.changeCount ? nil : observed)
            lastRestoration = "awaiting-trusted-page-receipt"; receiptLock.unlock()
            throw Failure(code: "CLIPBOARD_RECOVERY_PENDING", message: "Native copy/cut delivery is uncertain. Its prior clipboard is retained only in memory, including when publication has not happened yet. No unobserved generation was imported or restored. A late exact trusted receipt can establish generation-checked cleanup; newer generations are preserved. Do not replay input or restart the app while clipboard status is pending.")
        }
        if plan.operation == "paste", posted, !receiptReceived(), driver.changeCount() == owned {
            receiptLock.lock(); recovery = Recovery(original: original, owned: owned, lease: lease, restoreAllowed: false)
            lastRestoration = "awaiting-trusted-page-receipt"; receiptLock.unlock()
            throw Failure(code: "CLIPBOARD_RECOVERY_PENDING", message: "Native paste delivery is uncertain; the exact trusted page-event receipt is missing. The original private clipboard is retained only in memory and has NOT been restored into the pending paste. A late source-bound receipt or newer user clipboard change resolves cleanup. Do not replay the shortcut.")
        }
        if mutated {
            if driver.changeCount() != owned { restoration = "newer-change-preserved" }
            else {
                do {
                    let restored = try driver.write(original.items, expectedChangeCount: owned, lazy: false)
                    owned = restored.changeCount
                    defer { driver.release(restored) }
                    let verified = try driver.snapshot()
                    if verified.changeCount != restored.changeCount { restoration = "newer-change-preserved" }
                    else if verified.items == original.items { restoration = "restored" }
                    else { restoration = "unconfirmed" }
                } catch let failure as Failure {
                    if let count = failure.ownedChangeCount { owned = count }
                    restoration = driver.changeCount() != owned ? "newer-change-preserved" : "unconfirmed"
                }
                catch { restoration = "unconfirmed" }
            }
        }
        if restoration == "unconfirmed" {
            receiptLock.lock(); recovery = Recovery(original: original, owned: owned, lease: lease, restoreAllowed: true)
            lastRestoration = restoration; receiptLock.unlock()
        } else {
            if let lease { driver.release(lease) }
            receiptLock.lock(); lastRestoration = restoration; receiptLock.unlock()
        }
        if let pending {
            let failure = pending as? Failure
            throw Failure(code: failure?.code ?? "NATIVE_CLIPBOARD_FAILED", message: (failure?.message ?? "The native clipboard operation stopped.")
                + " Clipboard restoration: \(restoration). Native shortcut delivered: \(posted). Do not replay a possibly delivered copy, cut, or paste.")
        }
        guard restoration != "unconfirmed" else { throw Failure(code: "CLIPBOARD_RECOVERY_PENDING", message: "The native shortcut was delivered, but exact clipboard restoration could not be verified. The prior clipboard remains only in memory for generation-checked recovery. Do not restart this app or replay the input while clipboard status is pending.") }
        result["operation"] = plan.operation; result["nativeKeyDelivered"] = posted; result["clipboardRestoration"] = restoration
        result["trustedPageReceipt"] = receiptReceived()
        return result
    }

    final class NativeDriver: Driver {
        private final class Provider: NSObject, NSPasteboardItemDataProvider {
            let values: [NSPasteboard.PasteboardType: Data]
            private let lock = NSLock()
            private var served = false
            init(_ item: Item) { values = Dictionary(uniqueKeysWithValues: item.flavors.map { (NSPasteboard.PasteboardType($0.type), $0.data) }) }
            func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
                guard let data = values[type], item.setData(data, forType: type) else { return }
                lock.lock(); served = true; lock.unlock()
            }
            var consumed: Bool { lock.lock(); defer { lock.unlock() }; return served }
            func resetConsumption() { lock.lock(); served = false; lock.unlock() }
        }
        private let pasteboard: NSPasteboard
        private var providers: [UUID: [Provider]] = [:]
        init(pasteboard: NSPasteboard = .general) { self.pasteboard = pasteboard }
        private func main<T>(_ body: () throws -> T) rethrows -> T { Thread.isMainThread ? try body() : try DispatchQueue.main.sync(execute: body) }
        func changeCount() -> Int { main { pasteboard.changeCount } }
        func snapshot() throws -> Snapshot {
            try main {
                if #available(macOS 15.4, *), pasteboard.accessBehavior == .alwaysDeny {
                    throw Failure(code: "CLIPBOARD_ACCESS_DENIED", message: "macOS denied this app clipboard access. Allow ChatGPT for Safari clipboard access before using the transient native bridge.")
                }
                let count = pasteboard.changeCount
                guard let raw = pasteboard.pasteboardItems, raw.count <= 32,
                      !raw.isEmpty || pasteboard.types?.isEmpty == true else {
                    throw Failure(code: "CLIPBOARD_PRESERVATION_FAILED", message: "The full prior user clipboard could not be read. It was not overwritten.")
                }
                var total = 0
                let items = try raw.map { item -> Item in
                    guard item.types.count <= 128 else { throw Failure(code: "CLIPBOARD_PRESERVATION_FAILED", message: "The prior clipboard has too many types to preserve safely. It was not overwritten.") }
                    return Item(flavors: try item.types.map { type in
                        guard type.rawValue.utf8.count <= 512 else { throw Failure(code: "CLIPBOARD_PRESERVATION_FAILED", message: "A prior clipboard type identifier exceeds the preservation bounds. It was not overwritten.") }
                        guard let data = item.data(forType: type) else { throw Failure(code: "CLIPBOARD_PRESERVATION_FAILED", message: "A prior clipboard type could not be fully preserved. It was not overwritten.") }
                        total += data.count
                        guard total <= maximumPreservedBytes else { throw Failure(code: "CLIPBOARD_PRESERVATION_FAILED", message: "The prior clipboard exceeds the 32 MiB preservation limit. It was not overwritten.") }
                        return Flavor(type: type.rawValue, data: data)
                    })
                }
                guard pasteboard.changeCount == count else { throw Failure(code: "CLIPBOARD_CHANGED", message: "The user clipboard changed during preservation. It was not overwritten.") }
                return Snapshot(changeCount: count, items: items)
            }
        }
        func write(_ items: [Item], expectedChangeCount: Int, lazy: Bool) throws -> Lease {
            try main {
                var heldProviders: [Provider] = []
                let native = try items.map { item -> NSPasteboardItem in
                    let result = NSPasteboardItem()
                    if lazy {
                        let provider = Provider(item)
                        guard result.setDataProvider(provider, forTypes: item.flavors.map { NSPasteboard.PasteboardType($0.type) }) else { throw Failure(code: "CLIPBOARD_WRITE_FAILED", message: "The native clipboard provider could not be prepared.") }
                        heldProviders.append(provider)
                        return result
                    }
                    for flavor in item.flavors where !result.setData(flavor.data, forType: NSPasteboard.PasteboardType(flavor.type)) {
                        throw Failure(code: "CLIPBOARD_WRITE_FAILED", message: "A clipboard type could not be prepared for exact restoration.")
                    }
                    return result
                }
                guard pasteboard.changeCount == expectedChangeCount else { throw Failure(code: "CLIPBOARD_CHANGED", message: "A newer user clipboard generation was preserved without overwrite.") }
                let cleared = pasteboard.prepareForNewContents(with: [.currentHostOnly])
                guard pasteboard.changeCount == cleared else { throw Failure(code: "CLIPBOARD_CHANGED", message: "A newer clipboard generation replaced the transient lease before publication.") }
                guard native.isEmpty || pasteboard.writeObjects(native) else { throw Failure(code: "CLIPBOARD_WRITE_FAILED", message: "The native clipboard could not publish all items.", ownedChangeCount: cleared) }
                let id = UUID(), lease = Lease(changeCount: pasteboard.changeCount, id: id)
                if lazy {
                    // Retain providers explicitly until the real paste read and
                    // restoration finish; pasteboard items own them as well.
                    providers[id] = heldProviders
                    heldProviders.forEach { $0.resetConsumption() }
                }
                return lease
            }
        }
        func consumed(_ lease: Lease) -> Bool { main { providers[lease.id]?.contains(where: \.consumed) == true } }
        func release(_ lease: Lease) { _ = main { providers.removeValue(forKey: lease.id) } }
    }
}
