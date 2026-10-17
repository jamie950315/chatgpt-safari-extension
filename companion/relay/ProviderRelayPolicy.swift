// Provider-only policy adapted from Jamie's Margina relay.
import Foundation
import Security

let providerRelayKeyParameter = "__chatgpt_key"
let providerRelayInlineParameter = "__chatgpt_inline"

enum ProviderRelayError: Error, LocalizedError {
    case invalidParent, invalidConversation, notRunning, invalidResource, missingSession,
         invalidSession, ambiguousSession, sessionUnconfirmed, moduleLimit, unsupportedRuntime,
         invalidBrowserSession, sessionChanged
    var errorDescription: String? {
        switch self {
        case .invalidParent: return "The sidebar parent must be this Safari extension's exact origin"
        case .invalidConversation: return "The conversation must be an allowed ChatGPT side-chat URL"
        case .notRunning: return "The ChatGPT provider relay is not running"
        case .invalidResource: return "The provider relay script resources are invalid"
        case .missingSession: return "No supported app-owned ChatGPT session was supplied"
        case .invalidSession: return "The supplied ChatGPT session is invalid"
        case .ambiguousSession: return "The supplied ChatGPT session is ambiguous"
        case .sessionUnconfirmed: return "The official ChatGPT session check did not confirm this login"
        case .moduleLimit: return "The provider page exceeds the inline-module memory limit"
        case .unsupportedRuntime: return "The ChatGPT page does not identify one supported module runtime"
        case .invalidBrowserSession: return "The ChatGPT session does not contain a supported browser account scope"
        case .sessionChanged: return "The ChatGPT session changed while the browser connection was being prepared"
        }
    }
}

func providerRelayRandomKey() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw ProviderRelayError.invalidResource
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
}

func providerRelayConstantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8), b = Array(rhs.utf8)
    guard a.count == b.count else { return false }
    var difference: UInt8 = 0
    for index in a.indices { difference |= a[index] ^ b[index] }
    return difference == 0
}

func providerRelayEscapeHTML(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
}

private func providerRelayJSONString(_ value: String) -> String {
    String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]), encoding: .utf8)!
        .replacingOccurrences(of: "<", with: "\\u003c")
}

struct ProviderRelayRequest {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data
}

enum ProviderRelayDiagnostics {
    static let maximumBytes = 8 * 1024
    static let counters: Set<String> = ["usedOrigin", "usedConnection", "connections", "contexts", "failures", "scriptErrors", "unhandledRejections", "connectMessages"]
    static let booleans: Set<String> = ["channelConnected", "readyPosted", "parentSourceMatched", "parentTokenMatched"]
    static let kinds: Set<String> = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "SecurityError", "DOMException", "UnhandledRejection", "ModuleLoadError", "UnknownError"]

    static func validate(_ value: Any) -> [String: Any]? {
        guard let input = value as? [String: Any], let state = input["state"] as? String,
              ["loading", "installed", "failed"].contains(state),
              Set(input.keys).isSubset(of: counters.union(booleans).union(["state", "parentOriginKind", "errors"])) else { return nil }
        var report: [String: Any] = ["state": state]
        for name in counters {
            if let value = input[name] {
                guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                      number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 1_000_000_000,
                      number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
                report[name] = number.intValue
            }
        }
        for name in booleans {
            if let value = input[name] {
                guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
                report[name] = number.boolValue
            }
        }
        if let value = input["parentOriginKind"] {
            guard let kind = value as? String, ["none", "expected", "opaque", "other"].contains(kind) else { return nil }
            report["parentOriginKind"] = kind
        }
        if let value = input["errors"] {
            guard let errors = value as? [[String: Any]], errors.count <= 4 else { return nil }
            var safeErrors: [[String: Any]] = []
            for error in errors {
                guard Set(error.keys) == ["kind", "frames"], let kind = error["kind"] as? String, kinds.contains(kind),
                      let frames = error["frames"] as? [String], frames.count <= 4 else { return nil }
                for frame in frames {
                    guard frame.range(of: #"^/(?:cdn/assets/(?:async/)?[A-Za-z0-9_.-]{1,180}\.js|__chatgpt/(?:browser|sidechat-host)\.js)(?::[0-9]{1,9}(?::[0-9]{1,9})?)?$"#, options: .regularExpression) != nil else { return nil }
                }
                safeErrors.append(["kind": kind, "frames": frames])
            }
            report["errors"] = safeErrors
        }
        return report
    }
}

struct ProviderRelayPolicy {
    var key: String
    var bridgeNonce: String
    var bridgeToken: String
    let mainOrigin: URL
    var localOrigin = ""
    var parentExtensionOrigin = ""
    let hosts: Set<String> = ["chatgpt.com", "cdn.oaistatic.com", "persistent.oaistatic.com"]

    static func validParent(_ value: String) -> Bool {
        guard let parts = URLComponents(string: value), parts.scheme == "safari-web-extension",
              let host = parts.host, host.range(of: #"^[A-Za-z0-9-]{1,128}$"#, options: .regularExpression) != nil,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.path.isEmpty, parts.query == nil, parts.fragment == nil else { return false }
        return value == "safari-web-extension://" + host
    }

    static func validConversation(_ value: URL) -> Bool {
        guard let parts = URLComponents(url: value, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "chatgpt.com", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.fragment == nil else { return false }
        let path = parts.path
        guard path == "/" || path.range(of: #"^/c/[A-Za-z0-9_-]{1,128}$"#, options: .regularExpression) != nil else { return false }
        let allowed: Set<String> = ["messageId", "onboarding_conversation", "owner_user_id", "surface", "tab", "temporary-chat"]
        let query = parts.queryItems ?? []
        guard Set(query.map(\.name)).isSubset(of: allowed),
              Set(query.map(\.name)).count == query.count else { return false }
        return query.first(where: { $0.name == "surface" }).map { $0.value == "browser_side_chat" } ?? true
    }

    func authorized(_ request: ProviderRelayRequest) -> Bool {
        let query = URLComponents(string: localOrigin + request.target)?.queryItems ?? []
        let keys = query.filter { $0.name == providerRelayKeyParameter }
        guard keys.count <= 1 else { return false }
        if let header = request.headers["x-chatgpt-relay"], let query = keys.first?.value,
           !providerRelayConstantTimeEqual(header, query) { return false }
        return providerRelayConstantTimeEqual(request.headers["x-chatgpt-relay"] ?? keys.first?.value ?? "", key)
    }

    func upstreamURL(_ target: String) -> URL? {
        guard target.hasPrefix("/"), !target.hasPrefix("//"),
              var local = URLComponents(string: localOrigin + target), local.user == nil, local.password == nil,
              !(local.queryItems ?? []).contains(where: { $0.name == providerRelayInlineParameter }) else { return nil }
        local.queryItems = local.queryItems?.filter { $0.name != providerRelayKeyParameter }
        if local.queryItems?.isEmpty == true { local.queryItems = nil }
        let prefix = "/__chatgpt/upstream/"
        var upstream = URLComponents(url: mainOrigin, resolvingAgainstBaseURL: false)!
        if local.path.hasPrefix(prefix) {
            let remainder = String(local.path.dropFirst(prefix.count))
            guard let host = remainder.split(separator: "/", maxSplits: 1).first.map(String.init), hosts.contains(host),
                  local.percentEncodedPath.hasPrefix(prefix + host + "/") else { return nil }
            upstream = URLComponents(string: "https://\(host)")!
            upstream.percentEncodedPath = String(local.percentEncodedPath.dropFirst((prefix + host).count))
        } else {
            guard !local.path.hasPrefix("/__chatgpt/") else { return nil }
            upstream.percentEncodedPath = local.percentEncodedPath
        }
        upstream.percentEncodedQuery = local.percentEncodedQuery
        let forbidden = ["/auth", "/api/auth/signin", "/api/auth/signout", "/api/auth/callback", "/api/auth/csrf"]
        guard !forbidden.contains(where: { upstream.path == $0 || upstream.path.hasPrefix($0 + "/") }) else { return nil }
        return upstream.url
    }

    func localURL(_ value: String, relativeTo base: URL) -> String? {
        guard let upstream = URL(string: value, relativeTo: base)?.absoluteURL,
              upstream.user == nil, upstream.password == nil,
              var parts = URLComponents(url: upstream, resolvingAgainstBaseURL: false) else { return nil }
        let main = URLComponents(url: mainOrigin, resolvingAgainstBaseURL: false)!
        let isMain = parts.scheme == main.scheme && parts.host == main.host && parts.port == main.port
        guard isMain || (parts.scheme == "https" && parts.port == nil && hosts.contains(parts.host ?? "")) else { return nil }
        var path = parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
        if !isMain { path = "/__chatgpt/upstream/\(parts.host!)" + path }
        parts = URLComponents(string: localOrigin + path)!
        var query = URLComponents(url: upstream, resolvingAgainstBaseURL: false)?.queryItems ?? []
        query.removeAll { $0.name == providerRelayKeyParameter || $0.name == providerRelayInlineParameter }
        query.append(URLQueryItem(name: providerRelayKeyParameter, value: key))
        parts.queryItems = query
        parts.fragment = upstream.fragment
        return parts.string
    }

    func publicStatic(_ request: ProviderRelayRequest) -> Bool {
        guard request.method == "GET" || request.method == "HEAD",
              let parts = URLComponents(string: localOrigin + request.target), parts.query == nil else { return false }
        return Self.staticAssetPath(parts.percentEncodedPath)
    }

    static func staticAssetPath(_ path: String) -> Bool {
        path.range(of: #"^/cdn/assets/(?:[A-Za-z0-9_-]+[.-][A-Za-z0-9._-]+\.(?:js|css|woff2|woff|svg|png|webp|ico)|async/[A-Za-z0-9_-]+[.-][A-Za-z0-9._-]+\.js)$"#, options: .regularExpression) != nil
    }

    func rejection(for request: ProviderRelayRequest, enabled: Bool) -> (Int, String)? {
        guard request.headers["host"] == String(localOrigin.dropFirst("http://".count)) else { return (403, "Only this local provider hostname is accepted") }
        guard request.target.hasPrefix("/"), !request.target.hasPrefix("//"),
              let local = URLComponents(string: localOrigin + request.target), local.host == URL(string: localOrigin)?.host,
              local.fragment == nil else { return (400, "Invalid provider request URL") }
        guard request.headers["origin"] == nil || request.headers["origin"] == localOrigin else { return (403, "Requests from another origin are rejected") }
        guard ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].contains(request.method) else { return (405, "Unsupported provider operation") }
        guard authorized(request) || publicStatic(request) else { return (401, "The provider capability is invalid") }
        guard enabled else { return (503, "The provider session is unavailable") }
        if local.path == "/__chatgpt/diagnostics" {
            guard request.method == "POST" else { return (405, "Provider diagnostics accept POST only") }
            guard local.query == nil, request.headers["origin"] == localOrigin else { return (403, "Invalid provider diagnostic origin") }
            let type = request.headers["content-type"]?.lowercased().split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
            guard type == "application/json" else { return (415, "Provider diagnostics require JSON") }
            guard let count = Int(request.headers["content-length"] ?? "0"), count <= ProviderRelayDiagnostics.maximumBytes else { return (413, "The provider diagnostic report exceeds 8 KiB") }
            return nil
        }
        if ["/__chatgpt/browser.js", "/__chatgpt/sidechat-host.js"].contains(local.path) {
            return request.method == "GET" ? nil : (405, "Script resources accept GET only")
        }
        if (local.queryItems ?? []).contains(where: { $0.name == providerRelayInlineParameter }) {
            return request.method == "GET" ? nil : (405, "Inline modules accept GET only")
        }
        guard upstreamURL(request.target) != nil else { return (403, "This upstream route is not allowed") }
        guard request.headers["upgrade"] == nil else { return (501, "The provider relay does not support WebSocket") }
        return nil
    }

    func documentPolicy(_ original: String, nonce: String) -> String {
        let adapted: Set<String> = ["frame-ancestors", "report-uri", "report-to", "upgrade-insecure-requests", "block-all-mixed-content"]
        var directives = original.split(separator: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && !adapted.contains($0.split(separator: " ").first.map(String.init)?.lowercased() ?? "") }
        if directives.isEmpty { directives = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "object-src 'none'"] }
        let nonceValue = "'nonce-\(nonce)'"
        if let index = directives.firstIndex(where: { $0.hasPrefix("script-src ") }) {
            directives[index] = directives[index].replacingOccurrences(of: "'none'", with: "") + " " + nonceValue
        } else {
            let fallback = directives.first(where: { $0.hasPrefix("default-src ") }).map { String($0.dropFirst("default-src ".count)) } ?? "'self'"
            directives.append("script-src " + fallback.replacingOccurrences(of: "'none'", with: "") + " " + nonceValue)
        }
        if let index = directives.firstIndex(where: { $0.hasPrefix("script-src-elem ") }) {
            directives[index] = directives[index].replacingOccurrences(of: "'none'", with: "") + " " + nonceValue
        }
        // CSP checks every ancestor: the host HTTP(S) page is above our exact extension parent.
        directives.append("frame-ancestors http: https: " + parentExtensionOrigin)
        return directives.joined(separator: "; ")
    }

    func configuredBrowserShim(_ source: Data, runtimeURL: String) throws -> Data {
        guard let script = String(data: source, encoding: .utf8), script.components(separatedBy: "/*__CHATGPT_RELAY_BOOTSTRAP__*/").count == 2 else { throw ProviderRelayError.invalidResource }
        let bootstrap: [String: String] = ["providerOrigin": localOrigin, "parentExtensionOrigin": parentExtensionOrigin, "bridgeToken": bridgeToken, "key": key, "runtimeURL": runtimeURL, "upstreamOrigin": mainOrigin.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))]
        let encoded = String(data: try JSONSerialization.data(withJSONObject: bootstrap, options: [.withoutEscapingSlashes]), encoding: .utf8)!
        return Data(script.replacingOccurrences(of: "/*__CHATGPT_RELAY_BOOTSTRAP__*/", with: encoded).utf8)
    }

    // Diagnostics retain only syntactically public asset paths, never an HTML/body/header excerpt.
    static func publicAssetPaths(in source: String) -> [String] {
        let normalized = source.replacingOccurrences(of: "\\/", with: "/")
        guard let pattern = try? NSRegularExpression(pattern: #"/cdn/assets/[A-Za-z0-9_.-]{1,180}\.js(?=[^A-Za-z0-9_./-]|$)"#) else { return [] }
        var values = Set<String>()
        for match in pattern.matches(in: normalized, range: NSRange(normalized.startIndex..., in: normalized)) {
            if let range = Range(match.range, in: normalized) { values.insert(String(normalized[range])) }
        }
        return Array(values.sorted().prefix(128))
    }

    func runtimeInventory(in html: String, httpLinkAssets: [String] = []) -> [String: Any] {
        let tags = try! NSRegularExpression(pattern: #"<(?:script|link)\b(?:\"[^\"]*\"|'[^']*'|[^'\">])*?>"#, options: [.caseInsensitive])
        let imports = try! NSRegularExpression(pattern: #"\bimport\s*(?:\(\s*)?(?:\"[^\"]*\"|'[^']*')"#)
        let fullRange = NSRange(html.startIndex..., in: html)
        var tagAssets = Set<String>(), importAssets = Set<String>()
        for match in tags.matches(in: html, range: fullRange) {
            if let range = Range(match.range, in: html) { tagAssets.formUnion(Self.publicAssetPaths(in: String(html[range]))) }
        }
        for match in imports.matches(in: html, range: fullRange) {
            if let range = Range(match.range, in: html) { importAssets.formUnion(Self.publicAssetPaths(in: String(html[range]))) }
        }
        let all = Set(Self.publicAssetPaths(in: html))
        let candidates = all.union(httpLinkAssets).filter { $0.range(of: #"^/cdn/assets/633146\.[a-f0-9]{10}\.js$"#, options: .regularExpression) != nil }
        return ["state": "inspected", "scriptLinkAssets": Array(tagAssets.sorted().prefix(128)),
                "inlineImportAssets": Array(importAssets.sorted().prefix(128)),
                "literalAssets": Array(all.subtracting(tagAssets).subtracting(importAssets).sorted().prefix(128)),
                "httpLinkAssets": Array(Set(httpLinkAssets).sorted().prefix(128)),
                "runtimeCandidates": Array(candidates.sorted()), "htmlBytes": html.utf8.count,
                "hasHead": html.range(of: "<head", options: .caseInsensitive) != nil]
    }

    func runtimeURL(in html: String, documentURL: URL) throws -> String {
        let tags = try NSRegularExpression(pattern: #"<(?:script|link)\b(?:\"[^\"]*\"|'[^']*'|[^'\">])*?>"#, options: [.caseInsensitive])
        let sources = try NSRegularExpression(pattern: #"\b(?:src|href)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s'\"=<>`]+))"#, options: [.caseInsensitive])
        var candidates = Set<String>()
        for tag in tags.matches(in: html, range: NSRange(html.startIndex..., in: html)) {
            guard let range = Range(tag.range, in: html) else { continue }
            let value = String(html[range])
            for attribute in sources.matches(in: value, range: NSRange(value.startIndex..., in: value)) {
                for index in 1...3 where attribute.range(at: index).location != NSNotFound {
                    guard let sourceRange = Range(attribute.range(at: index), in: value),
                          let url = URL(string: String(value[sourceRange]), relativeTo: documentURL)?.absoluteURL,
                          url.scheme == mainOrigin.scheme, url.host == mainOrigin.host, url.port == mainOrigin.port,
                          url.path.range(of: #"^/cdn/assets/633146\.[a-f0-9]{10}\.js$"#, options: .regularExpression) != nil,
                          url.query == nil, url.fragment == nil else { continue }
                    // The public contract always names the actual official URL, even in synthetic transport tests.
                    candidates.insert("https://chatgpt.com" + url.path)
                }
            }
        }
        guard candidates.count == 1, let result = candidates.first else { throw ProviderRelayError.unsupportedRuntime }
        return result
    }

    // Externalize unchanged inline source under the document's same path/query base.
    // Both static and dynamic imports can start only after the host adapter's TLA.
    func rewriteDocument(_ original: String, nonce: String, documentURL: URL,
                         registerInlineModule: (String, URL) throws -> String) throws -> String {
        let hostURL = localOrigin + "/__chatgpt/sidechat-host.js?\(providerRelayKeyParameter)=\(key)"
        let scripts = try NSRegularExpression(pattern: #"<script\b(?:\"[^\"]*\"|'[^']*'|[^'\">])*?>([\s\S]*?)</script\s*>"#, options: [.caseInsensitive])
        let attributes = try NSRegularExpression(pattern: #"([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s'\"=<>`]+))"#)
        let matches = scripts.matches(in: original, range: NSRange(original.startIndex..., in: original))
        var output = original
        for match in matches.reversed() {
            guard let tagRange = Range(match.range, in: original), let bodyRange = Range(match.range(at: 1), in: original) else { continue }
            let body = String(original[bodyRange])
            let opening = String(original[tagRange.lowerBound..<bodyRange.lowerBound])
            var values: [String: String] = [:]
            for attribute in attributes.matches(in: opening, range: NSRange(opening.startIndex..., in: opening)) {
                guard let nameRange = Range(attribute.range(at: 1), in: opening) else { continue }
                for index in 2...4 where attribute.range(at: index).location != NSNotFound {
                    if let range = Range(attribute.range(at: index), in: opening) { values[String(opening[nameRange]).lowercased()] = String(opening[range]); break }
                }
            }
            guard values["type"]?.lowercased() == "module" else { continue }
            let sourceURL: String
            if let source = values["src"] {
                let decoded = source.replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&quot;", with: "\"")
                guard let mapped = localURL(decoded, relativeTo: documentURL) else { throw ProviderRelayError.invalidResource }
                sourceURL = mapped
            } else { sourceURL = try registerInlineModule(body, documentURL) }
            // Only adapter bootstrap is ours; original module source and its dependency graph stay unchanged.
            let wrapper = "<script type=\"module\" nonce=\"\(providerRelayEscapeHTML(nonce))\">await import(\(providerRelayJSONString(hostURL))); await import(\(providerRelayJSONString(sourceURL)));</script>"
            guard let currentRange = Range(match.range, in: output) else { throw ProviderRelayError.invalidResource }
            output.replaceSubrange(currentRange, with: wrapper)
        }
        let runtime = try runtimeURL(in: original, documentURL: documentURL)
        let runtimeFile = URL(string: runtime)!.lastPathComponent
        let bootstrap = "<script nonce=\"\(nonce)\" src=\"/__chatgpt/browser.js?\(providerRelayKeyParameter)=\(key)&amp;__chatgpt_runtime=\(runtimeFile)\"></script><script type=\"module\" nonce=\"\(nonce)\" src=\"\(providerRelayEscapeHTML(hostURL))\"></script>"
        if let range = output.range(of: #"<head(?:\s[^>]*)?>"#, options: [.regularExpression, .caseInsensitive]) {
            output.insert(contentsOf: bootstrap, at: range.upperBound)
        } else { output = bootstrap + output }
        return output
    }
}

enum ProviderRelaySessionCookies {
    static let sessionResponseLimit = 512 * 1024
    static let families = ["__Secure-next-auth.session-token", "__Secure-authjs.session-token"]

    // Caller supplies only this app's own WK store after user authorization.
    // No browser store is read here; no credential is persisted or exposed to JS.
    static func select(_ cookies: [HTTPCookie], now: Date = Date()) throws -> [HTTPCookie] {
        var selected: [(String, Int?, HTTPCookie)] = []
        var bytes = 0
        for cookie in cookies {
            guard ["chatgpt.com", ".chatgpt.com"].contains(cookie.domain.lowercased()),
                  let family = families.first(where: { cookie.name == $0 || cookie.name.hasPrefix($0 + ".") }) else { continue }
            guard cookie.isSecure, cookie.isHTTPOnly, cookie.path == "/", !cookie.value.isEmpty, cookie.value.utf8.count <= 16_384 else { throw ProviderRelayError.invalidSession }
            if let expiry = cookie.expiresDate, expiry <= now { continue }
            var index: Int?
            if cookie.name != family {
                let suffix = String(cookie.name.dropFirst(family.count + 1))
                guard !suffix.isEmpty, suffix.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }), let value = Int(suffix), value < 8, String(value) == suffix else { throw ProviderRelayError.invalidSession }
                index = value
            }
            bytes += cookie.value.utf8.count; selected.append((family, index, cookie))
        }
        guard !selected.isEmpty else { throw ProviderRelayError.missingSession }
        guard selected.count <= 8, bytes <= 128 * 1024 else { throw ProviderRelayError.invalidSession }
        guard Set(selected.map { $0.0 }).count == 1, Set(selected.map { $0.2.name }).count == selected.count,
              Set(selected.map { $0.2.domain.lowercased() }).count == 1 else { throw ProviderRelayError.ambiguousSession }
        if selected.contains(where: { $0.1 == nil }) {
            guard selected.count == 1 else { throw ProviderRelayError.ambiguousSession }
            return [selected[0].2]
        }
        let ordered = selected.sorted { $0.1! < $1.1! }
        guard ordered.map({ $0.1! }) == Array(0..<ordered.count) else { throw ProviderRelayError.invalidSession }
        return ordered.map { $0.2 }
    }

    static func sessionPayload(status: Int, data: Data, now: Date = Date()) -> [String: Any]? {
        guard status == 200, data.count <= sessionResponseLimit,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let user = value["user"] as? [String: Any], let id = user["id"] as? String,
              validSessionString(id, maximumBytes: 256), let access = value["accessToken"] as? String,
              validSessionString(access, maximumBytes: 128 * 1024), let expires = value["expires"] as? String,
              expires.utf8.count <= 128 else { return nil }
        if let error = value["error"], !(error is NSNull) { return nil }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var expiry = formatter.date(from: expires)
        if expiry == nil { formatter.formatOptions = [.withInternetDateTime]; expiry = formatter.date(from: expires) }
        guard expiry.map({ $0 > now }) == true else { return nil }
        return value
    }

    static func validSessionResponse(status: Int, data: Data, now: Date = Date()) -> Bool {
        sessionPayload(status: status, data: data, now: now) != nil
    }

    // Original background ps(account, user.id) consumes only these account fields.
    // This result is native-only and must never enter provider HTTP/config/diagnostics.
    static func browserSession(from value: [String: Any]) -> [String: Any]? {
        guard let token = value["accessToken"] as? String, validSessionString(token, maximumBytes: 128 * 1024),
              let user = value["user"] as? [String: Any], let userID = user["id"] as? String,
              validSessionString(userID, maximumBytes: 256), let account = value["account"] as? [String: Any],
              let accountID = account["id"] as? String, validSessionString(accountID, maximumBytes: 256),
              let structure = account["structure"] as? String, ["personal", "workspace"].contains(structure) else { return nil }
        return ["accessToken": token, "account": ["id": accountID, "structure": structure], "user": ["id": userID]]
    }

    private static func validSessionString(_ value: String, maximumBytes: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= maximumBytes
            && value.rangeOfCharacter(from: .controlCharacters) == nil
    }
}

enum ProviderRelayMessages {
    static let values = [
        "requestTimeout": "The provider request timed out", "requestTooLarge": "The provider request is too large",
        "invalidRequest": "Invalid provider HTTP request", "invalidHeader": "Invalid HTTP header",
        "duplicateHeader": "Duplicate or invalid HTTP header", "unsupportedUpload": "Chunked uploads are not supported",
        "invalidLength": "Invalid or oversized request body", "uploadBusy": "The provider upload limit is busy",
        "headersTooLarge": "Provider request headers are too large", "relayStatusTitle": "ChatGPT provider relay",
        "chatUnavailable": "ChatGPT could not be displayed", "noAutomaticAction": "Reopen the Safari sidebar to reconnect.",
        "sessionInvalidReopen": "The provider capability is invalid", "upstreamNotAllowed": "This upstream route is not allowed",
        "websocketUnavailable": "The provider relay does not support WebSocket", "browserVerification": "ChatGPT requires browser verification. Complete it on the official page.",
        "staticResponseRejected": "The static resource returned unexpected content or a redirect", "redirectRejected": "The upstream redirect reached an unapproved destination",
        "responseTooLarge": "The provider response is too large", "upstreamFailed": "The upstream request failed or was interrupted",
        "invalidUTF8": "The provider page is not valid UTF-8",
    ]
    static func text(_ key: String) -> String { values[key] ?? "The provider request failed" }
}
