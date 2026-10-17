//
//  SafariWebExtensionHandler.swift
//  ChatGPT for Safari Extension
//
//

import SafariServices

@objc(SafariNativeBridge)
protocol SafariNativeBridge {
    func handle(_ request: Data, withReply reply: @escaping (Data) -> Void)
}

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let connectionLock = NSLock()
    private static var activeConnection: NSXPCConnection?

    private static func connection() -> NSXPCConnection {
        connectionLock.lock()
        defer { connectionLock.unlock() }
        if let activeConnection { return activeConnection }
        let connection = NSXPCConnection(serviceName: "dev.jamie.chatgpt-safari.Bridge")
        connection.remoteObjectInterface = NSXPCInterface(with: SafariNativeBridge.self)
        connection.invalidationHandler = { [weak connection] in
            connectionLock.lock()
            if activeConnection === connection { activeConnection = nil }
            connectionLock.unlock()
        }
        activeConnection = connection
        connection.resume()
        return connection
    }

    func beginRequest(with context: NSExtensionContext) {
        let complete: ([String: Any]) -> Void = { message in
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: message]
            context.completeRequest(returningItems: [response], completionHandler: nil)
        }
        guard let item = context.inputItems.first as? NSExtensionItem,
              var message = item.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            complete(["ok": false, "error": ["code": "INVALID_REQUEST", "message": "Expected a native transport request."]])
            return
        }
        message.removeValue(forKey: "_nativeSafariProfile")
        message.removeValue(forKey: "_nativeSafariProfileObserved")
        if #available(macOS 14.0, *) {
            let profile = item.userInfo?[SFExtensionProfileKey]
            if profile == nil { message["_nativeSafariProfileObserved"] = true }
            else if let uuid = profile as? UUID {
                message["_nativeSafariProfile"] = uuid.uuidString
                message["_nativeSafariProfileObserved"] = true
            } else if let value = profile as? String, let uuid = UUID(uuidString: value) {
                message["_nativeSafariProfile"] = uuid.uuidString
                message["_nativeSafariProfileObserved"] = true
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: message) else {
            complete(["ok": false, "error": ["code": "INVALID_REQUEST", "message": "Expected a serializable native transport request."]]); return
        }
        let proxy = Self.connection().remoteObjectProxyWithErrorHandler { error in
            complete(["ok": false, "error": ["code": "BRIDGE_UNAVAILABLE", "message": error.localizedDescription]])
        } as? SafariNativeBridge
        proxy?.handle(data) { data in
            guard let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                complete(["ok": false, "error": ["code": "INVALID_BRIDGE_REPLY", "message": "The native bridge returned invalid JSON."]])
                return
            }
            complete(value)
        }
    }

}
