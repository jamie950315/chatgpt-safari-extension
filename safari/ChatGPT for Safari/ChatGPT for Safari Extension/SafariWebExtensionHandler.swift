//
//  SafariWebExtensionHandler.swift
//  ChatGPT for Safari Extension
//
//

import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: [
            "ok": false,
            "error": [
                "code": "SAFARI_NATIVE_HOST_NOT_PORTED",
                "message": "The Chrome native host is not available in this Safari conversion."
            ]
        ]]

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

}
