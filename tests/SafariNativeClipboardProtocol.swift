import Foundation

@main struct SafariNativeClipboardChecks {
    final class Driver: SafariNativeClipboard.Driver {
        var current = SafariNativeClipboard.Snapshot(changeCount: 1, items: [
            .init(flavors: [.init(type: "private.first", data: Data([0,1,2])), .init(type: "private.second", data: Data("Prior private data".utf8))]),
            .init(flavors: [.init(type: "public.file-url", data: Data("file:///never-read-this-file".utf8))])])
        var writes: [[SafariNativeClipboard.Item]] = [], consumedValue = false, reads = 0, denyRead = false, failWrite = false
        var released: [UUID] = [], failRestoration = false
        func snapshot() throws -> SafariNativeClipboard.Snapshot {
            reads += 1
            if denyRead { throw SafariNativeClipboard.Failure(code: "CLIPBOARD_PRESERVATION_FAILED", message: "Prior data unavailable") }
            return current
        }
        func changeCount() -> Int { current.changeCount }
        func write(_ items: [SafariNativeClipboard.Item], expectedChangeCount: Int, lazy: Bool) throws -> SafariNativeClipboard.Lease {
            guard current.changeCount == expectedChangeCount else { throw SafariNativeClipboard.Failure(code: "CLIPBOARD_CHANGED", message: "Newer data retained") }
            current = .init(changeCount: current.changeCount + 1, items: items); writes.append(items)
            if failWrite || failRestoration && writes.count > 1 { failWrite = false; throw SafariNativeClipboard.Failure(code: "CLIPBOARD_WRITE_FAILED", message: "Failed after clearing", ownedChangeCount: current.changeCount) }
            return .init(changeCount: current.changeCount, id: UUID())
        }
        func consumed(_ lease: SafariNativeClipboard.Lease) -> Bool { consumedValue }
        func release(_ lease: SafariNativeClipboard.Lease) { released.append(lease.id) }
        func replaceByUser() { current = .init(changeCount: current.changeCount + 1, items: [.init(flavors: [.init(type: "new.user.data", data: Data([9]))])]) }
    }
    static func main() throws {
        let scope = ["profileId": "profile", "ownerId": "owner", "accountScope": "account", "sessionId": "session", "turnId": "turn", "tabId": "12", "documentId": "doc", "node": "node"]
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPz8AAAAASUVORK5CYII="
        let rich: [[String: Any]] = [["entries": [["mime_type": "text/plain", "text": "Plain"], ["mime_type": "text/html", "text": "<b>Rich</b>"]]],
                                    ["entries": [["mime_type": "image/png", "base64": png]]]]
        func plan(_ operation: String = "paste", items: [[String: Any]]? = nil) throws -> SafariNativeClipboard.Plan {
            var raw: [String: Any] = ["operation": operation, "scope": scope, "receiptToken": UUID().uuidString]
            if operation == "paste" { raw["items"] = items ?? rich }
            return try .init(raw, key: ["copy": "Meta+c", "cut": "Meta+x", "paste": "Meta+v"][operation])
        }
        func rejects(_ code: String, _ body: () throws -> Void) {
            do { try body(); preconditionFailure("Expected \(code)") }
            catch let failure as SafariNativeClipboard.Failure { precondition(failure.code == code, failure.code) }
            catch { preconditionFailure("Unexpected error \(error)") }
        }
        let native = Driver(), bridge = SafariNativeClipboard(driver: native), prior = native.current.items
        var keys = 0
        let paste = try plan()
        func receipt(_ engine: SafariNativeClipboard, _ value: SafariNativeClipboard.Plan) { engine.acknowledge(["token": value.receiptToken, "scope": value.scope]) }
        func settled(_ engine: SafariNativeClipboard) -> [String: Any] {
            for _ in 0..<200 { let value = engine.recoveryStatus(); if value["pending"] as? Bool != true { return value }; Thread.sleep(forTimeInterval: 0.005) }
            return engine.recoveryStatus()
        }
        let result = try bridge.perform(paste, validate: {}, sendKey: { posted in keys += 1; posted(); native.consumedValue = true; receipt(bridge, paste) }, pause: { _ in })
        precondition(keys == 1 && native.writes.count == 2 && native.current.items == prior)
        precondition(result["nativeKeyDelivered"] as? Bool == true && result["trustedPageReceipt"] as? Bool == true && result["nativeDataRead"] as? Bool == true && result["clipboardRestoration"] as? String == "restored")
        let restored = native.current.items
        precondition(restored[0].flavors.map(\.type) == ["private.first", "private.second"] && restored[1].flavors[0].data == prior[1].flavors[0].data)
        for op in ["copy", "cut"] {
            let copied = Driver(), original = copied.current.items, engine = SafariNativeClipboard(driver: copied)
            let value = try plan(op)
            let output = try engine.perform(value, validate: {}, sendKey: { posted in
                posted(); copied.current = .init(changeCount: copied.current.changeCount + 1, items: try SafariNativeClipboard.decode(rich))
                receipt(engine, value)
            }, pause: { _ in })
            precondition(copied.current.items == original && output["clipboardRestoration"] as? String == "restored")
            let returned = output["items"] as! [[String: Any]]
            precondition((returned[0]["entries"] as! [[String: Any]])[1]["text"] as? String == "<b>Rich</b>")
            precondition((returned[1]["entries"] as! [[String: Any]])[0]["base64"] as? String == png)
        }
        let denied = Driver(); denied.denyRead = true
        rejects("CLIPBOARD_PRESERVATION_FAILED") { _ = try SafariNativeClipboard(driver: denied).perform(plan(), validate: {}, sendKey: { _ in preconditionFailure("Denied preservation posted input") }) }
        precondition(denied.writes.isEmpty)
        let changed = Driver(); changed.consumedValue = true
        let changedEngine = SafariNativeClipboard(driver: changed), changedPlan = try plan()
        let superseded = try changedEngine.perform(changedPlan, validate: {}, sendKey: { posted in posted(); changed.replaceByUser(); receipt(changedEngine, changedPlan) }, pause: { _ in })
        precondition(superseded["clipboardRestoration"] as? String == "newer-change-preserved" && changed.writes.count == 1 && changed.current.items[0].flavors[0].type == "new.user.data")
        let stopped = Driver(); var validations = 0
        rejects("STOPPED") { _ = try SafariNativeClipboard(driver: stopped).perform(plan(), validate: { validations += 1; if validations > 2 { throw SafariNativeClipboard.Failure(code: "STOPPED", message: "Owner changed") } }, sendKey: { _ in preconditionFailure("A changed owner posted a key") }) }
        precondition(stopped.current.items == prior && stopped.writes.count == 2)
        let partial = Driver(); partial.failWrite = true
        rejects("CLIPBOARD_WRITE_FAILED") { _ = try SafariNativeClipboard(driver: partial).perform(plan(), validate: {}, sendKey: { _ in preconditionFailure("Failed publication posted a key") }) }
        precondition(partial.current.items == prior && partial.writes.count == 2)
        let uncertain = Driver(), uncertainEngine = SafariNativeClipboard(driver: uncertain), uncertainPlan = try plan()
        rejects("CLIPBOARD_RECOVERY_PENDING") {
            _ = try uncertainEngine.perform(uncertainPlan, validate: {}, sendKey: { posted in
                // A provider read or a receipt before key posting cannot prove
                // the source page received the delivered native shortcut.
                receipt(uncertainEngine, uncertainPlan); posted(); uncertain.consumedValue = true
            }, pause: { _ in Thread.sleep(forTimeInterval: 0.01) })
        }
        precondition(uncertain.writes.count == 1 && uncertain.current.items != prior)
        precondition(uncertainEngine.recoveryStatus()["memoryOnlyPriorHeld"] as? Bool == true)
        uncertainEngine.acknowledge(["token": UUID().uuidString, "scope": scope])
        uncertainEngine.acknowledge(["token": uncertainPlan.receiptToken, "scope": scope.merging(["node": "other"]) { _, n in n }])
        precondition(uncertain.writes.count == 1, "Unrelated receipt restored private clipboard data into a pending paste")
        receipt(uncertainEngine, uncertainPlan)
        precondition(settled(uncertainEngine)["pending"] as? Bool == false && uncertain.current.items == prior)
        precondition(uncertain.writes.count == 2, "Late receipt must restore once without repeating native input")
        let replaced = Driver(), replacedEngine = SafariNativeClipboard(driver: replaced), replacedPlan = try plan()
        rejects("CLIPBOARD_RECOVERY_PENDING") {
            _ = try replacedEngine.perform(replacedPlan, validate: {}, sendKey: { posted in posted() }, pause: { _ in Thread.sleep(forTimeInterval: 0.01) })
        }
        replaced.replaceByUser()
        precondition(settled(replacedEngine)["restoration"] as? String == "newer-change-preserved")
        receipt(replacedEngine, replacedPlan)
        precondition(replaced.writes.count == 1 && replaced.current.items[0].flavors[0].type == "new.user.data")
        let restoreFailure = Driver(), recoveryEngine = SafariNativeClipboard(driver: restoreFailure), recoveryPlan = try plan()
        restoreFailure.failRestoration = true
        rejects("CLIPBOARD_RECOVERY_PENDING") {
            _ = try recoveryEngine.perform(recoveryPlan, validate: {}, sendKey: { posted in posted(); receipt(recoveryEngine, recoveryPlan) }, pause: { _ in })
        }
        precondition(recoveryEngine.recoveryStatus()["memoryOnlyPriorHeld"] as? Bool == true)
        restoreFailure.failRestoration = false
        precondition(settled(recoveryEngine)["pending"] as? Bool == false && restoreFailure.current.items == prior)
        let statusData = try JSONSerialization.data(withJSONObject: recoveryEngine.recoveryStatus())
        precondition(!String(decoding: statusData, as: UTF8.self).contains("Prior private"))
        for operation in ["copy", "cut"] {
            let delayed = Driver(), delayedEngine = SafariNativeClipboard(driver: delayed), delayedPlan = try plan(operation)
            var delivered = 0
            rejects("CLIPBOARD_RECOVERY_PENDING") {
                _ = try delayedEngine.perform(delayedPlan, validate: {}, sendKey: { posted in delivered += 1; posted() }, pause: { _ in Thread.sleep(forTimeInterval: 0.01) })
            }
            precondition(delayedEngine.recoveryStatus()["memoryOnlyPriorHeld"] as? Bool == true)
            precondition(delayed.current.items == prior && delayed.writes.isEmpty && delayed.reads == 1)
            // Publication can occur after the operation timeout. A status read
            // before its trusted receipt must not discard the saved prior.
            delayed.current = .init(changeCount: delayed.current.changeCount + 1, items: try SafariNativeClipboard.decode(rich))
            precondition(delayedEngine.recoveryStatus()["pending"] as? Bool == true && delayed.writes.isEmpty)
            receipt(delayedEngine, delayedPlan)
            precondition(settled(delayedEngine)["pending"] as? Bool == false && delayed.current.items == prior && delivered == 1)
        }
        let noCopyReceipt = Driver(), noCopyEngine = SafariNativeClipboard(driver: noCopyReceipt), noCopyPlan = try plan("copy")
        rejects("CLIPBOARD_RECOVERY_PENDING") {
            _ = try noCopyEngine.perform(noCopyPlan, validate: {}, sendKey: { posted in
                posted(); noCopyReceipt.current = .init(changeCount: noCopyReceipt.current.changeCount + 1, items: try SafariNativeClipboard.decode(rich))
            }, pause: { _ in Thread.sleep(forTimeInterval: 0.01) })
        }
        precondition(noCopyReceipt.reads == 1 && noCopyReceipt.writes.isEmpty, "An unobserved copy generation must not be imported or overwritten")
        precondition(noCopyEngine.recoveryStatus()["memoryOnlyPriorHeld"] as? Bool == true)
        noCopyEngine.acknowledge(["token": UUID().uuidString, "scope": scope])
        precondition(noCopyEngine.recoveryStatus()["pending"] as? Bool == true && noCopyReceipt.writes.isEmpty)
        // A different generation after the observed but unacknowledged copy is
        // not attributed to Safari, even when its delayed receipt then arrives.
        noCopyReceipt.replaceByUser(); receipt(noCopyEngine, noCopyPlan)
        precondition(settled(noCopyEngine)["restoration"] as? String == "newer-change-preserved")
        precondition(noCopyReceipt.writes.isEmpty && noCopyReceipt.reads == 1 && noCopyReceipt.current.items[0].flavors[0].type == "new.user.data")
        let supersededCopy = Driver(), supersededCopyEngine = SafariNativeClipboard(driver: supersededCopy), supersededCopyPlan = try plan("copy")
        rejects("CLIPBOARD_CHANGED") {
            _ = try supersededCopyEngine.perform(supersededCopyPlan, validate: {}, sendKey: { posted in
                posted(); supersededCopy.current = .init(changeCount: supersededCopy.current.changeCount + 1, items: try SafariNativeClipboard.decode(rich))
                receipt(supersededCopyEngine, supersededCopyPlan); supersededCopy.replaceByUser()
            }, pause: { _ in })
        }
        precondition(supersededCopy.reads == 1 && supersededCopy.writes.isEmpty && supersededCopy.current.items[0].flavors[0].type == "new.user.data")
        for item: [String: Any] in [
            ["mime_type": "text/uri-list", "text": "file:///not-read"], ["mime_type": "application/octet-stream", "base64": "AA=="],
            ["mime_type": "text/plain", "base64": "QQ=="], ["mime_type": "image/png", "base64": "aW52YWxpZA=="],
            ["mime_type": "image/png", "base64": "iVBORw0KGgo="], ["mime_type": "text/html", "text": "bad\0text"]] {
            do { _ = try plan(items: [["entries": [item]]]); preconditionFailure("Unsupported or malformed MIME was accepted") } catch {}
        }
        rejects("INVALID_NATIVE_CLIPBOARD") { _ = try SafariNativeClipboard.Plan(["operation": "copy", "scope": scope], key: "Meta+v") }
        print("Native clipboard: bounded HTML/PNG decoding, exact multi-item/type/data preservation, native copy/cut capture, trusted source receipt gate, late-receipt recovery, unacknowledged paste/copy/cut preservation, delayed copy/cut publication recovery, receipt-bound copy generation, owner cancellation, exact restoration recovery, newer-user-change preservation, unsupported MIME rejection passed. No real OS clipboard or keyboard was accessed.")
    }
}
