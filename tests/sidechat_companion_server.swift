import Foundation
import AppKit

@main
struct CompanionServerSmoke {
    static func wait(_ condition: () -> Bool, timeout: TimeInterval = 5) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() && Date() < deadline {
            _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
        }
        precondition(condition(), "The companion test timed out")
    }
    static func main() throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let descriptor = directory.appendingPathComponent("companion-control.json")
        let server = CompanionControlServer(descriptorDirectory: directory)
        server.commandHandler = { command, reply in
            precondition(Thread.isMainThread)
            reply(["ok": true, "action": command["action"]!])
        }
        try server.start()
        wait({ FileManager.default.fileExists(atPath: descriptor.path) })
        let attributes = try FileManager.default.attributesOfItem(atPath: descriptor.path)
        precondition(attributes[.posixPermissions] as? Int == 0o600)
        let info = try JSONSerialization.jsonObject(with: Data(contentsOf: descriptor)) as! [String: Any]
        let port = info["port"] as! Int, token = info["token"] as! String
        precondition(Data(base64Encoded: token)?.count == 32)
        func call(token supplied: String, origin: String? = nil) -> (Int, [String: Any]) {
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/command")!)
            request.httpMethod = "POST"
            request.setValue("Bearer " + supplied, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
            request.httpBody = Data("{\"action\":\"status\"}".utf8)
            var finished = false, result: (Int, [String: Any])?
            URLSession.shared.dataTask(with: request) { data, response, error in
                precondition(error == nil, String(describing: error))
                result = ((response as! HTTPURLResponse).statusCode,
                          (try! JSONSerialization.jsonObject(with: data!)) as! [String: Any])
                finished = true
            }.resume()
            wait({ finished })
            return result!
        }
        precondition(call(token: token).0 == 200)
        precondition(call(token: "invalid").0 == 401)
        precondition(call(token: token, origin: "https://chatgpt.com").0 == 403)
        let duplicate = "POST /command HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}"
        guard case .reject(400, _) = server.parse(Data(duplicate.utf8)) else { fatalError("Duplicate length accepted") }
        guard case .reject(413, _) = server.parse(Data(repeating: 65, count: 2_000_000)) else { fatalError("Oversized body accepted") }
        let context: [String: Any] = ["instanceId": "test", "tabId": 5, "windowId": 7, "url": "https://example.com"]
        let validated = try SideChatCompanionController.validateContext(context)
        precondition(validated["tabId"] as? Int == 5)
        var invalid = context
        invalid["tabId"] = true
        do { _ = try SideChatCompanionController.validateContext(invalid); fatalError("Boolean tab identifier accepted") }
        catch {}
        invalid = context
        invalid["url"] = "file:///etc/passwd"
        do { _ = try SideChatCompanionController.validateContext(invalid); fatalError("File owner URL accepted") }
        catch {}
        let controller = SideChatCompanionController()
        var badOpen: [String: Any]?
        controller.handle(command: ["action": "open", "ownerToken": UUID().uuidString, "context": invalid]) { badOpen = $0 }
        precondition(badOpen?["ok"] as? Bool == false)
        var ownerState: [String: Any]?
        controller.handle(command: ["action": "status"]) { ownerState = $0["state"] as? [String: Any] }
        precondition(ownerState?["ownerToken"] == nil, "A rejected open changed the active owner")
        var closed: [String: Any]?
        controller.handle(command: ["action": "poll", "ownerToken": UUID().uuidString]) { closed = $0 }
        precondition(closed?["ok"] as? Bool == true && closed?["closed"] as? Bool == true)
        controller.handle(command: ["action": "close", "ownerToken": UUID().uuidString]) { closed = $0 }
        precondition(closed?["ok"] as? Bool == true)
        server.stop()
        wait({ !FileManager.default.fileExists(atPath: descriptor.path) })
        print("Side chat companion: authenticated loopback, framing, bounds, descriptor cleanup, and context validation passed")
    }
}
