import Foundation
import UserNotifications

/// Posts this containing app's notifications through the public macOS API.
/// The caller's authorization closure must bind the signed-in account epoch,
/// sidebar owner, and observed Safari profile. No browser credentials are used.
final class SafariNotifications {
    enum Authorization: String {
        case notDetermined = "not_determined"
        case denied, authorized, provisional, unknown

        var permitsScheduling: Bool { self == .authorized || self == .provisional }
    }

    struct Settings {
        let authorization: Authorization
        let alertsEnabled: Bool
        let notificationCenterEnabled: Bool

        var data: [String: Any] {
            ["authorization": authorization.rawValue, "alertsEnabled": alertsEnabled,
             "notificationCenterEnabled": notificationCenterEnabled,
             "permissionRequestAvailable": authorization == .notDetermined]
        }
    }

    struct Notification {
        let identifier: String
        let title: String
        let message: String
    }

    protocol Center {
        func settings(_ reply: @escaping (Settings) -> Void)
        func requestPermission(_ reply: @escaping (Error?) -> Void)
        func add(_ notification: Notification, reply: @escaping (Error?) -> Void)
        func removeOwnedRequest(_ identifier: String)
    }

    struct Failure: Error {
        let code: String
        let message: String
        var details: [String: Any] = [:]
    }

    struct Request {
        enum Operation: String { case create, status, requestPermission }
        let operation: Operation
        let title: String?
        let message: String?

        init(_ command: [String: Any]) throws {
            guard command["action"] as? String == "notification",
                  let profile = command["profileId"] as? String, !profile.isEmpty,
                  command.keys.allSatisfy({ ["action", "profileId", "operation", "title", "message"].contains($0) }),
                  let operation = Operation(rawValue: command["operation"] as? String ?? (command["operation"] == nil ? "create" : "")) else {
                throw Failure(code: "INVALID_ARGUMENTS", message: "Expected an owner-bound notification create, status, or requestPermission operation.")
            }
            self.operation = operation
            if operation == .create {
                guard let title = command["title"] as? String,
                      let message = command["message"] as? String,
                      !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      title.utf16.count <= 200, message.utf16.count <= 4_000,
                      !title.contains("\0"), !message.contains("\0") else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "A notification needs a nonempty title of at most 200 UTF-16 units and a message of at most 4000 UTF-16 units, without null characters.")
                }
                self.title = title; self.message = message
            } else {
                guard command["title"] == nil, command["message"] == nil else {
                    throw Failure(code: "INVALID_ARGUMENTS", message: "Notification permission operations do not accept notification content.")
                }
                title = nil; message = nil
            }
        }
    }

    private final class NativeCenter: Center {
        private var center: UNUserNotificationCenter { .current() }

        func settings(_ reply: @escaping (Settings) -> Void) {
            center.getNotificationSettings { settings in
                let authorization: Authorization
                switch settings.authorizationStatus {
                case .notDetermined: authorization = .notDetermined
                case .denied: authorization = .denied
                case .authorized: authorization = .authorized
                case .provisional: authorization = .provisional
                @unknown default: authorization = .unknown
                }
                reply(Settings(authorization: authorization, alertsEnabled: settings.alertSetting == .enabled,
                               notificationCenterEnabled: settings.notificationCenterSetting == .enabled))
            }
        }

        func requestPermission(_ reply: @escaping (Error?) -> Void) {
            // Notifications use the app icon and plain text only. Do not request
            // badge, sound, critical-alert, attachment, or remote permissions.
            center.requestAuthorization(options: [.alert]) { _, error in reply(error) }
        }

        func add(_ notification: Notification, reply: @escaping (Error?) -> Void) {
            let content = UNMutableNotificationContent()
            content.title = notification.title
            content.body = notification.message
            let request = UNNotificationRequest(identifier: notification.identifier, content: content, trigger: nil)
            center.add(request, withCompletionHandler: reply)
        }

        func removeOwnedRequest(_ identifier: String) {
            center.removePendingNotificationRequests(withIdentifiers: [identifier])
            center.removeDeliveredNotifications(withIdentifiers: [identifier])
        }
    }

    private let center: Center
    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.notifications")

    init(center: Center? = nil) { self.center = center ?? NativeCenter() }

    func handle(_ command: [String: Any], isAuthorized: @escaping () -> Bool,
                reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            let authorized = { self.onMain(isAuthorized) }
            let request: Request
            do {
                request = try Request(command)
                try requireAuthorization(authorized)
            } catch { reply(Self.failure(error)); return }
            center.settings { settings in
                self.queue.async {
                    do { try self.requireAuthorization(authorized) }
                    catch { reply(Self.failure(error)); return }
                    switch request.operation {
                    case .status: reply(["ok": true, "result": settings.data])
                    case .requestPermission:
                        self.requestPermission(settings, authorized: authorized, reply: reply)
                    case .create:
                        self.schedule(request, settings: settings, authorized: authorized, reply: reply)
                    }
                }
            }
        }
    }

    private func requestPermission(_ settings: Settings, authorized: @escaping () -> Bool,
                                   reply: @escaping ([String: Any]) -> Void) {
        guard settings.authorization == .notDetermined else {
            reply(["ok": true, "result": settings.data.merging(["granted": settings.authorization.permitsScheduling]) { _, new in new }])
            return
        }
        do { try requireAuthorization(authorized) }
        catch { reply(Self.failure(error)); return }
        center.requestPermission { error in
            self.queue.async {
                do {
                    try self.requireAuthorization(authorized)
                    guard error == nil else {
                        throw Failure(code: "NOTIFICATION_PERMISSION_REQUEST_FAILED", message: "macOS could not complete the notification permission request.")
                    }
                } catch { reply(Self.failure(error)); return }
                self.center.settings { observed in
                    self.queue.async {
                        do { try self.requireAuthorization(authorized) }
                        catch { reply(Self.failure(error)); return }
                        reply(["ok": true, "result": observed.data.merging(["granted": observed.authorization.permitsScheduling]) { _, new in new }])
                    }
                }
            }
        }
    }

    private func schedule(_ request: Request, settings: Settings, authorized: @escaping () -> Bool,
                          reply: @escaping ([String: Any]) -> Void) {
        do {
            switch settings.authorization {
            case .notDetermined:
                throw Failure(code: "NOTIFICATION_PERMISSION_REQUIRED", message: "Open the extension's Native bridge diagnostics and choose Enable notifications before sending a notification.", details: settings.data)
            case .denied:
                throw Failure(code: "NOTIFICATION_PERMISSION_DENIED", message: "Allow ChatGPT for Safari notifications in System Settings > Notifications before sending a notification.", details: settings.data)
            case .unknown:
                throw Failure(code: "NOTIFICATION_AUTHORIZATION_UNAVAILABLE", message: "macOS did not expose a supported notification authorization state.", details: settings.data)
            case .authorized, .provisional: break
            }
            guard settings.alertsEnabled || settings.notificationCenterEnabled else {
                throw Failure(code: "NOTIFICATIONS_DISABLED", message: "Enable alerts or Notification Center for ChatGPT for Safari in System Settings > Notifications.", details: settings.data)
            }
            try requireAuthorization(authorized)
        } catch { reply(Self.failure(error)); return }
        let notification = Notification(identifier: "chatgpt-safari-" + UUID().uuidString,
                                        title: request.title!, message: request.message!)
        center.add(notification) { error in
            self.queue.async {
                guard authorized() else {
                    self.center.removeOwnedRequest(notification.identifier)
                    reply(Self.failure(Failure(code: "STALE_NOTIFICATION_OWNER", message: "The sidebar owner or signed-in account changed while scheduling the notification. The app requested cancellation of its own notification; do not repeat it.",
                                               details: ["doNotReplay": true, "mayHaveBeenPresented": true, "ownedRequestCancellationRequested": true])))
                    return
                }
                guard error == nil else {
                    reply(Self.failure(Failure(code: "NOTIFICATION_SCHEDULE_FAILED", message: "macOS did not confirm scheduling the notification. The request was not retried; do not repeat a possibly completed notification.", details: ["doNotReplay": true])))
                    return
                }
                // add's successful completion is the system's scheduling ACK,
                // not evidence that a banner was displayed or read by the user.
                reply(["ok": true, "result": ["id": notification.identifier, "status": "scheduled",
                                               "authorization": settings.authorization.rawValue]])
            }
        }
    }

    private func requireAuthorization(_ authorized: () -> Bool) throws {
        guard authorized() else {
            throw Failure(code: "STALE_NOTIFICATION_OWNER", message: "The notification no longer belongs to the signed-in sidebar owner and Safari profile.")
        }
    }

    private static func failure(_ error: Error) -> [String: Any] {
        let failure = error as? Failure ?? Failure(code: "NOTIFICATION_FAILED", message: "The macOS notification operation failed.")
        var data: [String: Any] = ["code": failure.code, "message": failure.message]
        if !failure.details.isEmpty { data["data"] = failure.details }
        return ["ok": false, "error": data]
    }

    private func onMain<T>(_ body: () -> T) -> T {
        Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
    }
}
