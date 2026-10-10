import CoreGraphics
import Foundation

func fail(_ message: String) -> Never {
    fputs("window-id: \(message)\n", stderr)
    exit(2)
}

guard CommandLine.arguments.count == 2, let pid = Int32(CommandLine.arguments[1]) else {
    fail("usage: window-id.swift <BattleShip-process-id>")
}
let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    fail("could not enumerate on-screen windows")
}
let matches = windows.compactMap { window -> (UInt32, CGRect)? in
    guard let ownerPID = window[kCGWindowOwnerPID as String] as? Int32,
          ownerPID == pid,
          let name = window[kCGWindowName as String] as? String,
          name == "BattleShip (Metal)",
          let layer = window[kCGWindowLayer as String] as? Int,
          layer == 0,
          let number = window[kCGWindowNumber as String] as? UInt32,
          let boundsDictionary = window[kCGWindowBounds as String] as? [String: Any],
          let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
          bounds.width > 0,
          bounds.height > 0 else { return nil }
    return (number, bounds)
}
guard let selected = matches.max(by: { $0.1.width * $0.1.height < $1.1.width * $1.1.height }) else {
    exit(1)
}
let output: [String: Any] = [
    "windowId": selected.0,
    "bounds": [Int(selected.1.minX), Int(selected.1.minY), Int(selected.1.width), Int(selected.1.height)],
    "name": "BattleShip (Metal)",
    "layer": 0,
]
guard let data = try? JSONSerialization.data(withJSONObject: output),
      let json = String(data: data, encoding: .utf8) else {
    fail("could not encode selected window details")
}
print(json)
