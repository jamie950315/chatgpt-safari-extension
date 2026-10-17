import Foundation

private final class Scope {
    private let lock = NSLock()
    private var value = true
    var valid: Bool {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
}

private final class FakeCenter: SafariNotifications.Center {
    var observed = SafariNotifications.Settings(authorization: .authorized, alertsEnabled: true, notificationCenterEnabled: true)
    var settingsCalls = 0
    var permissionCalls = 0
    var notifications: [SafariNotifications.Notification] = []
    var removed: [String] = []
    var afterSettings: (() -> Void)?
    var afterPermission: (() -> Void)?
    var afterAdd: (() -> Void)?
    var permissionError: Error?
    var addError: Error?

    func settings(_ reply: @escaping (SafariNotifications.Settings) -> Void) {
        settingsCalls += 1; afterSettings?(); reply(observed)
    }
    func requestPermission(_ reply: @escaping (Error?) -> Void) {
        permissionCalls += 1
        if permissionError == nil {
            observed = .init(authorization: .authorized, alertsEnabled: true, notificationCenterEnabled: true)
        }
        afterPermission?()
        reply(permissionError)
    }
    func add(_ notification: SafariNotifications.Notification, reply: @escaping (Error?) -> Void) {
        notifications.append(notification); afterAdd?(); reply(addError)
    }
    func removeOwnedRequest(_ identifier: String) { removed.append(identifier) }
}

private final class Response {
    private let lock = NSLock()
    private var value: [String: Any]?
    func put(_ result: [String: Any]) { lock.lock(); value = result; lock.unlock() }
    func get() -> [String: Any]? { lock.lock(); defer { lock.unlock() }; return value }
}

@main struct SafariNotificationsChecks {
    static func main() throws {
        let base: [String: Any] = ["action": "notification", "profileId": "synthetic-profile"]
        let content: [String: Any] = ["title": "Synthetic Café", "message": "First line\n第二行"]
        func command(_ fields: [String: Any]) -> [String: Any] { base.merging(fields) { _, new in new } }
        for fields: [String: Any] in [["title": true, "message": "x"], ["title": " ", "message": "x"],
                                      ["title": String(repeating: "x", count: 201), "message": "x"],
                                      ["title": "x", "message": String(repeating: "x", count: 4001)],
                                      ["title": "x", "message": "\0"], ["operation": 1], ["operation": "unsupported"],
                                      ["operation": "status", "title": "x"], ["icon": "https://example.test/icon", "title": "x", "message": "x"]] {
            do { _ = try SafariNotifications.Request(command(fields)); preconditionFailure("Invalid notification arguments were accepted") }
            catch let failure as SafariNotifications.Failure { precondition(failure.code == "INVALID_ARGUMENTS") }
        }
        func call(_ center: FakeCenter, _ scope: Scope = Scope(), fields: [String: Any] = content) -> [String: Any] {
            let service = SafariNotifications(center: center), response = Response()
            service.handle(command(fields), isAuthorized: { scope.valid }, reply: { response.put($0) })
            let deadline = Date().addingTimeInterval(3)
            while response.get() == nil && Date() < deadline {
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
            }
            guard let result = response.get() else { preconditionFailure("Synthetic notification operation timed out") }
            return result
        }
        func code(_ response: [String: Any]) -> String? { (response["error"] as? [String: Any])?["code"] as? String }
        let accepted = FakeCenter(), result = call(accepted)
        let scheduled = result["result"] as! [String: Any]
        precondition(result["ok"] as? Bool == true && scheduled["status"] as? String == "scheduled")
        precondition(scheduled["id"] as? String == accepted.notifications.first?.identifier)
        precondition(accepted.notifications.count == 1 && accepted.notifications[0].title == content["title"] as? String)
        precondition(accepted.notifications[0].message == content["message"] as? String)
        precondition(accepted.permissionCalls == 0 && accepted.removed.isEmpty)

        let fresh = FakeCenter()
        fresh.observed = .init(authorization: .notDetermined, alertsEnabled: false, notificationCenterEnabled: false)
        precondition(code(call(fresh)) == "NOTIFICATION_PERMISSION_REQUIRED")
        precondition(fresh.permissionCalls == 0 && fresh.notifications.isEmpty)
        let status = call(fresh, fields: ["operation": "status"])["result"] as! [String: Any]
        precondition(status["authorization"] as? String == "not_determined" && status["permissionRequestAvailable"] as? Bool == true)
        let permission = call(fresh, fields: ["operation": "requestPermission"])["result"] as! [String: Any]
        precondition(fresh.permissionCalls == 1 && permission["granted"] as? Bool == true)
        precondition(permission["authorization"] as? String == "authorized" && fresh.notifications.isEmpty)
        let failedPermission = FakeCenter()
        failedPermission.observed = .init(authorization: .notDetermined, alertsEnabled: false, notificationCenterEnabled: false)
        failedPermission.permissionError = NSError(domain: "synthetic", code: 2)
        precondition(code(call(failedPermission, fields: ["operation": "requestPermission"])) == "NOTIFICATION_PERMISSION_REQUEST_FAILED")
        let changedDuringPermission = Scope(), abandonedPermission = FakeCenter()
        abandonedPermission.observed = .init(authorization: .notDetermined, alertsEnabled: false, notificationCenterEnabled: false)
        abandonedPermission.afterPermission = { changedDuringPermission.valid = false }
        precondition(code(call(abandonedPermission, changedDuringPermission, fields: ["operation": "requestPermission"])) == "STALE_NOTIFICATION_OWNER")
        precondition(abandonedPermission.notifications.isEmpty)

        let denied = FakeCenter()
        denied.observed = .init(authorization: .denied, alertsEnabled: false, notificationCenterEnabled: false)
        precondition(code(call(denied)) == "NOTIFICATION_PERMISSION_DENIED")
        let stillDenied = call(denied, fields: ["operation": "requestPermission"])["result"] as! [String: Any]
        precondition(stillDenied["granted"] as? Bool == false && denied.permissionCalls == 0)
        let disabled = FakeCenter()
        disabled.observed = .init(authorization: .authorized, alertsEnabled: false, notificationCenterEnabled: false)
        precondition(code(call(disabled)) == "NOTIFICATIONS_DISABLED" && disabled.notifications.isEmpty)
        let failed = FakeCenter()
        failed.addError = NSError(domain: "synthetic", code: 1)
        precondition(code(call(failed)) == "NOTIFICATION_SCHEDULE_FAILED" && failed.notifications.count == 1)

        let stale = Scope(); stale.valid = false
        let neverRead = FakeCenter()
        precondition(code(call(neverRead, stale)) == "STALE_NOTIFICATION_OWNER" && neverRead.settingsCalls == 0)
        let changedBeforeAdd = Scope(), guarded = FakeCenter()
        guarded.afterSettings = { changedBeforeAdd.valid = false }
        precondition(code(call(guarded, changedBeforeAdd)) == "STALE_NOTIFICATION_OWNER" && guarded.notifications.isEmpty)
        let changedAfterAdd = Scope(), cancelled = FakeCenter()
        cancelled.afterAdd = { changedAfterAdd.valid = false }
        let cancelledResult = call(cancelled, changedAfterAdd)
        precondition(code(cancelledResult) == "STALE_NOTIFICATION_OWNER")
        precondition(cancelled.notifications.count == 1 && cancelled.removed == [cancelled.notifications[0].identifier])
        let uncertainty = (cancelledResult["error"] as! [String: Any])["data"] as! [String: Any]
        precondition(uncertainty["doNotReplay"] as? Bool == true && uncertainty["mayHaveBeenPresented"] as? Bool == true)
        print("Safari notifications: synthetic public-center scheduling, permission/status, typed bounds, exact IDs, denied/disabled errors, and owner-epoch cancellation passed. No system permission prompt or notification was sent.")
    }
}
