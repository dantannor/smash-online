import AppKit
import Foundation
import ScreenCaptureKit

@main
struct SCKCapture {
    static func main() async {
        do {
            guard CommandLine.arguments.count == 3,
                  let pid = Int32(CommandLine.arguments[1]) else {
                throw CaptureError.usage
            }
            let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
            _ = NSApplication.shared
            let shareable = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
            let matches = shareable.windows.filter {
                $0.owningApplication?.processID == pid && $0.title == "BattleShip (Metal)"
            }
            guard let window = matches.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
                throw CaptureError.noMatchingWindow(pid)
            }

            let filter = SCContentFilter(desktopIndependentWindow: window)
            let configuration = SCStreamConfiguration()
            configuration.width = max(1, Int(window.frame.width.rounded()))
            configuration.height = max(1, Int(window.frame.height.rounded()))
            configuration.showsCursor = false
            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
            let representation = NSBitmapImageRep(cgImage: image)
            guard let png = representation.representation(using: .png, properties: [:]) else {
                throw CaptureError.pngEncoding
            }
            try png.write(to: outputURL, options: .atomic)
            print("{\"windowId\":\(window.windowID),\"title\":\"BattleShip (Metal)\",\"path\":\"\(outputURL.path)\"}")
        } catch {
            fputs("sck-capture: \(error)\n", stderr)
            exit(1)
        }
    }
}

enum CaptureError: Error, CustomStringConvertible {
    case usage
    case noMatchingWindow(Int32)
    case pngEncoding

    var description: String {
        switch self {
        case .usage:
            return "usage: sck-capture <BattleShip-pid> <output.png>"
        case .noMatchingWindow(let pid):
            return "no BattleShip (Metal) window found for process \(pid)"
        case .pngEncoding:
            return "could not encode captured window as PNG"
        }
    }
}
