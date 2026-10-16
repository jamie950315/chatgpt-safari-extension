import Foundation

@main
struct SafariAutomationProtocol {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else { fatalError("Expected Python and fixture paths") }
        let service = SafariAutomation(driverURL: URL(fileURLWithPath: CommandLine.arguments[1]),
                                       driverArguments: [CommandLine.arguments[2]],
                                       requestTimeout: 0.8, startupTimeout: 3)
        func call(_ command: [String: Any]) -> [String: Any] {
            let semaphore = DispatchSemaphore(value: 0)
            var result: [String: Any] = [:]
            service.handle(command) { result = $0; semaphore.signal() }
            precondition(semaphore.wait(timeout: .now() + 5) == .success, "Protocol request hung")
            return result
        }
        func status() -> [String: Any] { call(["action": "status"])["result"] as! [String: Any] }
        func tool(_ name: String, _ arguments: [String: Any] = [:]) -> [String: Any] {
            call(["action": "tools/call", "name": name, "arguments": arguments])
        }
        precondition(status()["state"] as? String == "idle")
        precondition(status()["driverPID"] == nil, "Status must not start Safari")
        precondition(call(["action": "invalid"])["ok"] as? Bool == false)
        precondition(call(["action": "tools/call", "name": "echo", "arguments": "invalid"])["ok"] as? Bool == false)
        precondition(status()["state"] as? String == "idle")
        let listed = call(["action": "tools/list"])
        precondition(((listed["result"] as? [String: Any])?["tools"] as? [[String: Any]])?.first?["name"] as? String == "echo")
        let first = tool("echo", ["value": "persistent"])["result"] as! [String: Any]
        let firstContent = first["structuredContent"] as! [String: Any]
        precondition(firstContent["initialized"] as? Bool == true)
        let pid = firstContent["pid"] as! Int
        let sessionID = status()["sessionId"] as! String
        precondition(status()["scope"] as? String == "isolated_automation_session")
        precondition(status()["existingSafariTabsAccessible"] as? Bool == false)

        let group = DispatchGroup()
        let lock = NSLock()
        var responses: [String: [String: Any]] = [:]
        for (value, delay) in [("slow", 0.2), ("fast", 0.01)] {
            group.enter()
            service.handle(["action": "tools/call", "name": "echo", "arguments": ["value": value, "delay": delay]]) { response in
                lock.lock(); responses[value] = response; lock.unlock(); group.leave()
            }
        }
        precondition(group.wait(timeout: .now() + 4) == .success)
        for value in ["slow", "fast"] {
            let result = responses[value]!["result"] as! [String: Any]
            let content = result["structuredContent"] as! [String: Any]
            precondition(content["value"] as? String == value, "Responses must match their request IDs")
            precondition(content["pid"] as? Int == pid, "Calls must share the driver process")
        }
        let error = tool("tool_error")
        precondition((error["error"] as? [String: Any])?["code"] as? Int == -32099)
        precondition(((error["error"] as? [String: Any])?["data"] as? [String: Any])?["preserved"] as? Bool == true)
        precondition((tool("result_error")["result"] as? [String: Any])?["isError"] as? Bool == true)
        precondition(status()["state"] as? String == "ready", "Tool errors must not destroy the session")

        precondition(tool("hang")["ok"] as? Bool == false)
        precondition(status()["state"] as? String == "failed")
        precondition(tool("echo")["ok"] as? Bool == false, "Failed mutations must not restart or replay automatically")
        precondition(status()["sessionId"] as? String == sessionID)
        precondition(call(["action": "stop"])["ok"] as? Bool == true)
        precondition(status()["state"] as? String == "idle")
        precondition(tool("echo")["ok"] as? Bool == true)
        precondition(status()["sessionId"] as? String != sessionID)
        precondition(tool("crash")["ok"] as? Bool == false)
        precondition(status()["state"] as? String == "failed")
        _ = call(["action": "stop"])
        precondition(tool("malformed")["ok"] as? Bool == false)
        precondition(status()["state"] as? String == "failed")
        _ = call(["action": "stop"])
        service.close()
        print("Safari automation initialization, persistent sessions, correlated replies, native errors, timeout, crash, and explicit recovery passed.")
    }
}
