import Foundation

@main
struct BridgeSmoke {
    static func main() throws {
        let service = BridgeService()
        func call(_ value: [String: Any]) throws -> [String: Any] {
            let ready = DispatchSemaphore(value: 0)
            var response: [String: Any] = [:]
            service.handle(try JSONSerialization.data(withJSONObject: value)) { data in
                response = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
                ready.signal()
            }
            guard ready.wait(timeout: .now() + 25) == .success else { fatalError("Native bridge timed out") }
            return response
        }
        let invalid = try call(["operation": "open", "application": "/bin/sh", "origin": "https://example.com"])
        precondition(invalid["ok"] as? Bool == false)
        let opened = try call(["operation": "open", "application": "com.openai.codexextension", "origin": "safari-web-extension://bridge-smoke/"])
        guard let id = opened["connectionId"] as? String else { fatalError("Native host open failed: \(opened)") }
        let sent = try call(["operation": "send", "connectionId": id, "message": ["jsonrpc": "2.0", "id": "native-smoke", "method": "codexRuntime/hello"]])
        precondition(sent["ok"] as? Bool == true)
        let received = try call(["operation": "poll", "connectionId": id])
        let messages = received["messages"] as? [[String: Any]]
        let result = messages?.first?["result"] as? [String: Any]
        precondition(messages?.first?["id"] as? String == "native-smoke")
        precondition(result?["nativeHostProtocolVersion"] as? Int == 2)
        let closed = try call(["operation": "close", "connectionId": id])
        precondition(closed["ok"] as? Bool == true)
        let stale = try call(["operation": "send", "connectionId": id, "message": [:]])
        precondition(stale["ok"] as? Bool == false)
        service.close()
        print("Native host framing, real OpenAI hello, invalid-host rejection, and close passed.")
    }
}
