import Foundation
import CoreGraphics

@main
struct SafariLiveInputGuards {
    static func main() throws {
        let base: [String: Any] = [
            "action": "click", "expectedUrl": "https://example.com/current?mode=live#field",
            "windowBounds": ["left": 0, "top": 25, "width": 1200, "height": 900],
            "viewport": ["width": 1200, "height": 800], "point": ["x": 600, "y": 400]
        ]
        func request(_ changes: [String: Any] = [:]) throws -> SafariLiveInput.Request {
            try SafariLiveInput.Request(base.merging(changes, uniquingKeysWith: { _, rhs in rhs }))
        }
        func rejects(_ code: String, _ body: () throws -> Void) {
            do { try body(); preconditionFailure("Expected rejection: \(code)") }
            catch let failure as SafariLiveInput.Failure { precondition(failure.code == code, failure.code) }
            catch { preconditionFailure("Unexpected error: \(error)") }
        }

        _ = try request()
        rejects("INVALID_ARGUMENTS") { _ = try request(["expectedUrl": "file:///etc/passwd"]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["expectedUrl": "https://name:password@example.com"]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["viewport": ["width": 0, "height": 800]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["point": ["x": 1200, "y": 1]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["point": ["x": true, "y": 1]]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["point": ["x": Double.infinity, "y": 1]]) }
        rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": "Command+Q"]) }
        rejects("UNSUPPORTED_KEY") { _ = try request(["action": "key", "key": "Command+L"]) }
        for key in ["Enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "Space",
                    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"] {
            _ = try request(["action": "key", "key": key])
        }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "type", "text": ""]) }
        _ = try request(["action": "type", "text": "", "replaceAll": true])
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "type", "text": "clear", "replaceAll": NSNumber(value: 1)]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "type", "text": String(repeating: "a", count: 20_001)]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "scroll", "deltaY": Double.nan]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "scroll", "deltaY": 0]) }
        rejects("INVALID_ARGUMENTS") { _ = try request(["action": "scroll", "deltaX": 10_001]) }
        _ = try request(["action": "scroll", "deltaY": 300])

        let window = CGRect(x: -1300, y: 25, width: 1200, height: 900)
        let visible = CGRect(x: -1300, y: 125, width: 1200, height: 800)
        let mapped = try SafariLiveInput.mapPoint(CGPoint(x: 600, y: 400), viewport: CGSize(width: 1200, height: 800), scrollFrame: visible, windowFrame: window)
        precondition(mapped.point == CGPoint(x: -700, y: 525))
        precondition(mapped.scaleX == 1 && mapped.scaleY == 1)
        let zoomed = try SafariLiveInput.mapPoint(CGPoint(x: 400, y: 200), viewport: CGSize(width: 800, height: 1600.0 / 3), scrollFrame: visible, windowFrame: window)
        precondition(zoomed.point == CGPoint(x: -700, y: 425))
        precondition(abs(zoomed.scaleX - 1.5) < 0.0001)
        rejects("VIEWPORT_CHANGED") {
            _ = try SafariLiveInput.mapPoint(.zero, viewport: CGSize(width: 1200, height: 800),
                                            scrollFrame: CGRect(x: -1300, y: 125, width: 1200, height: 4000), windowFrame: window)
        }
        rejects("VIEWPORT_CHANGED") {
            _ = try SafariLiveInput.mapPoint(.zero, viewport: CGSize(width: 1200, height: 800),
                                            scrollFrame: CGRect(x: -1300, y: 125, width: 500, height: 800), windowFrame: window)
        }

        let unicode = String(repeating: "a", count: 19) + "🙂繁體中文" + String(repeating: "🎉", count: 35)
        let chunks = SafariLiveInput.unicodeChunks(unicode)
        precondition(chunks.flatMap { $0 } == Array(unicode.utf16))
        for chunk in chunks {
            precondition(!chunk.isEmpty && chunk.count <= 20)
            precondition(!(0xDC00...0xDFFF).contains(chunk.first!))
            precondition(!(0xD800...0xDBFF).contains(chunk.last!))
        }
        precondition(SafariLiveInput.unicodeChunks("").isEmpty)
        print("Safari live native argument guards, safe keys, viewport mapping, and Unicode event chunks passed. No input events were posted.")
    }
}
