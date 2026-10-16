import Foundation

let listener = NSXPCListener.service()
let delegate = BridgeListener()
listener.delegate = delegate
listener.resume()
