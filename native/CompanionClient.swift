import AppKit
import Foundation
import Security

/// The extension's signed XPC service is the sole native-messaging entry point.
final class CompanionClient {
    private let queue = DispatchQueue(label: "dev.jamie.chatgpt-safari.companion-client")
    private let descriptor = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/ChatGPT Safari/companion-control.json")

    private func appURL() throws -> URL {
        var location = Bundle.main.bundleURL
        while location.path != "/" {
            if location.pathExtension == "app" { return location }
            location.deleteLastPathComponent()
        }
        throw NSError(domain: "SafariCompanion", code: 1, userInfo: [NSLocalizedDescriptionKey: "The native bridge is not embedded in the Safari app."])
    }

    private func endpoint() throws -> (URL, String) {
        let attributes = try FileManager.default.attributesOfItem(atPath: descriptor.path)
        guard (attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              let value = try JSONSerialization.jsonObject(with: Data(contentsOf: descriptor)) as? [String: Any],
              let port = value["port"] as? Int, (1...65535).contains(port),
              let token = value["token"] as? String, token.count >= 32, token.count <= 128,
              let pid = value["pid"] as? Int32 else {
            throw NSError(domain: "SafariCompanion", code: 2, userInfo: [NSLocalizedDescriptionKey: "The Safari companion's private connection descriptor is invalid."])
        }
        var code: SecCode?
        var requirement: SecRequirement?
        let rule = "anchor apple generic and identifier \"dev.jamie.chatgpt-safari\" and certificate leaf[subject.OU] = \"N3JN8G9YWK\""
        guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess,
              SecRequirementCreateWithString(rule as CFString, [], &requirement) == errSecSuccess,
              let code, let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
            throw NSError(domain: "SafariCompanion", code: 3, userInfo: [NSLocalizedDescriptionKey: "The Safari companion is not running with the expected signing identity."])
        }
        return (URL(string: "http://127.0.0.1:\(port)/command")!, token)
    }

    func handle(_ command: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        queue.async { [self] in
            if let connection = try? endpoint() {
                send(command, to: connection, reply: reply)
                return
            }
            let action = command["action"] as? String
            if action != "open" && action != "automation" && action != "live" {
                let running = !NSRunningApplication.runningApplications(withBundleIdentifier: "dev.jamie.chatgpt-safari").isEmpty
                if action == "close" && !running { reply(["ok": true]); return }
                reply(["ok": false, "error": ["code": running ? "COMPANION_UNAVAILABLE" : "COMPANION_NOT_RUNNING",
                    "message": running ? "The Safari companion control service is unavailable." : "The Safari companion was closed."]])
                return
            }
            do {
                let application = try appURL()
                DispatchQueue.main.async {
                    let config = NSWorkspace.OpenConfiguration()
                    // Service startup does not request activation. The sidecar
                    // manages its own key-capable panel.
                    config.activates = false
                    NSWorkspace.shared.open([URL(string: "chatgpt-safari://service")!], withApplicationAt: application, configuration: config) { _, error in
                        if let error {
                            reply(["ok": false, "error": ["code": "COMPANION_LAUNCH_FAILED", "message": error.localizedDescription]])
                            return
                        }
                        self.awaitEndpoint(command, deadline: Date().addingTimeInterval(8), reply: reply)
                    }
                }
            } catch {
                reply(["ok": false, "error": ["code": "COMPANION_UNAVAILABLE", "message": error.localizedDescription]])
            }
        }
    }

    private func awaitEndpoint(_ command: [String: Any], deadline: Date, reply: @escaping ([String: Any]) -> Void) {
        queue.asyncAfter(deadline: .now() + 0.1) { [self] in
            if let connection = try? endpoint() { send(command, to: connection, reply: reply) }
            else if Date() < deadline { awaitEndpoint(command, deadline: deadline, reply: reply) }
            else { reply(["ok": false, "error": ["code": "COMPANION_START_TIMEOUT", "message": "The Safari companion did not start its private control service."]]) }
        }
    }

    private func send(_ command: [String: Any], to connection: (URL, String), reply: @escaping ([String: Any]) -> Void) {
        do {
            var request = URLRequest(url: connection.0)
            request.httpMethod = "POST"
            request.setValue("Bearer \(connection.1)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: command)
            request.timeoutInterval = ["automation", "live"].contains(command["action"] as? String ?? "") ? 130 : 25
            let config = URLSessionConfiguration.ephemeral
            config.connectionProxyDictionary = [:]
            let session = URLSession(configuration: config)
            session.dataTask(with: request) { data, response, error in
                defer { session.finishTasksAndInvalidate() }
                if let error {
                    reply(["ok": false, "error": ["code": "COMPANION_REQUEST_FAILED", "message": error.localizedDescription]])
                } else if (response as? HTTPURLResponse)?.statusCode != 200 {
                    reply(["ok": false, "error": ["code": "COMPANION_REQUEST_REJECTED", "message": "The Safari companion rejected the authenticated command."]])
                } else if let data, let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    reply(result)
                } else {
                    reply(["ok": false, "error": ["code": "INVALID_COMPANION_REPLY", "message": "The Safari companion returned invalid JSON."]])
                }
            }.resume()
        } catch {
            reply(["ok": false, "error": ["code": "INVALID_COMPANION_COMMAND", "message": error.localizedDescription]])
        }
    }
}
