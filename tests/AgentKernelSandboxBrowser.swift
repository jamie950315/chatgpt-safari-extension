import AppKit
import WebKit

/// Exercises the packaged original worker in a real, nonvisible WebKit view.
/// It does not use user browser profiles, pages, or native input.
@main final class AgentKernelSandboxBrowser: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private var loaded = false
    private var failure: String?
    private var results: [[String: Any]] = []
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded = true }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failure = error.localizedDescription
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let value = message.body as? [String: Any] { results.append(value) }
    }
    private func wait(_ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(15)
        while !condition() && failure == nil && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        precondition(failure == nil, failure ?? "")
        precondition(condition(), "The original kernel did not reply")
    }
    static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let test = AgentKernelSandboxBrowser()
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let source = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
        let server = CompanionControlServer(descriptorDirectory: directory, kernelSource: source)
        try server.start()
        defer { server.stop() }
        test.wait { FileManager.default.fileExists(atPath: directory.appendingPathComponent("companion-control.json").path) }
        let url = URL(string: try server.kernelEntry(parentOrigin: "safari-web-extension://browser-test"))!
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(test, name: "result")
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: configuration)
        view.navigationDelegate = test
        view.load(URLRequest(url: url))
        test.wait { test.loaded }
        for (index, script) in [
            "if(typeof chrome!=='undefined'||typeof browser!=='undefined')throw new Error('Privileged browser global');globalThis.kernelProbe=2+2;",
            "if(globalThis.kernelProbe!==4)throw new Error('Worker context lost');let blocked=false;try{await fetch('/command')}catch{blocked=true}if(!blocked)throw new Error('Worker network was allowed');"
        ].enumerated() {
            let request: [String: Any] = ["id": "probe-\(index)", "type": "js-kernel:execute", "script": script]
            let data = try JSONSerialization.data(withJSONObject: request)
            let json = String(data: data, encoding: .utf8)!
            let code = """
            (()=>{const channel=new MessageChannel();channel.port1.onmessage=event=>{
            window.webkit.messageHandlers.result.postMessage({ok:event.data.ok,error:event.data.error?.name??null});channel.port1.close();
            };window.postMessage(\(json),'*',[channel.port2]);})()
            """
            view.evaluateJavaScript(code) { _, error in if let error { test.failure = error.localizedDescription } }
            test.wait { test.results.count == index + 1 }
            precondition(test.results[index]["ok"] as? Bool == true, "The original sandbox worker failed: \(test.results[index]["error"] ?? "unknown")")
        }
        view.stopLoading()
        configuration.userContentController.removeScriptMessageHandler(forName: "result")
        print("Original WebKit kernel: persistent evaluation, no extension globals, and blocked network passed")
    }
}
