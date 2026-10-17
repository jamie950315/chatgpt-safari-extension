import Foundation

@main struct Test {
    static func main() {
        var writes = 0, cancelled: [String] = [], authorization: (() -> Bool)?
        let broker = SafariLiveBroker(download: { _, _, allowed, reply in
                precondition(allowed()); writes += 1; reply(["ok": true, "result": [:]])
            },
            cancelDownload: { cancelled.append($0) }, organize: { _, allowed, reply in
                authorization = allowed
                precondition(allowed())
                reply(["ok": true, "result": [:]])
            }, input: { _, reply in reply(["ok": true, "result": [:]]) })
        let profile = UUID().uuidString, session = UUID().uuidString
        var request: [String: Any] = [:]
        func poll() {
            broker.handle(["action": "livePoll", "profileId": profile, "sessionId": session]) {
                if let current = ($0["requests"] as? [[String: Any]])?.first { request = current }
            }
        }
        func run(_ action: String, _ args: [String: Any]) {
            broker.handle(["action": "live", "agentOwner": "owner", "command": ["action": action,
                "arguments": args.merging(["handle": "live:\(profile):12"]) { current, _ in current }]]) { _ in }
            poll()
        }
        func native(_ action: String, input: [String: Any], expectOK: Bool) {
            broker.handle(["action": action, "id": request["id"] ?? "missing", "profileId": profile,
                           "sessionId": session, "input": input]) { precondition($0["ok"] as? Bool == expectOK) }
        }
        poll()
        run("read_page", [:])
        native("liveDownload", input: ["action": "begin", "filename": "forbidden.txt"], expectOK: false)
        native("liveOrganize", input: ["action": "createGroup"], expectOK: false)
        broker.cancelAgent(owner: "owner")
        precondition(writes == 0)

        run("download_link", [:])
        native("liveDownload", input: ["action": "begin", "filename": "allowed.txt"], expectOK: true)
        precondition(writes == 1)
        let downloadID = request["id"] as! String
        broker.cancelAgent(owner: "owner")
        precondition(cancelled.contains(downloadID))
        native("liveDownload", input: ["action": "append"], expectOK: false)
        precondition(writes == 1, "Cancelled downloads cannot append another chunk")

        run("organize", ["operation": "inspect", "expectedUrl": "https://example.com/"])
        native("liveOrganize", input: ["action": "createGroup", "expectedUrl": "https://example.com/"], expectOK: false)
        native("liveOrganize", input: ["action": "inspect", "expectedUrl": "https://different.example/"], expectOK: false)
        native("liveOrganize", input: ["action": "inspect", "expectedUrl": "https://example.com/"], expectOK: true)
        precondition(authorization?() == true)
        broker.cancelAgent(owner: "owner")
        precondition(authorization?() == false, "An in-flight native helper must observe owner cancellation")
        native("liveOrganize", input: ["action": "inspect", "expectedUrl": "https://example.com/"], expectOK: false)
        broker.close()
        print("Live native download and organization scope/cancellation checks passed")
    }
}
