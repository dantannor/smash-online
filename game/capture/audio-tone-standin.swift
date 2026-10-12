import AppKit
import AVFoundation
import Foundation

@main
struct AudioToneStandin {
    static func main() {
        if let pidFile = ProcessInfo.processInfo.environment["SMASH_AUDIO_PID_FILE"] {
            try? String(getpid()).write(toFile: pidFile, atomically: true, encoding: .utf8)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.regular)
        let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 320, height: 120), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Smash Audio Tone Stand-in"
        window.makeKeyAndOrderFront(nil)
        app.activate(ignoringOtherApps: true)
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)!
        buffer.frameLength = 48_000
        let channels = buffer.floatChannelData!
        for frame in 0..<Int(buffer.frameLength) {
            let value = sin(2 * Double.pi * 440 * Double(frame) / 48_000) * 0.03
            channels[0][frame] = Float(value)
            channels[1][frame] = Float(value)
        }
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()
            fputs("tone stand-in pid=\(getpid()) running=\(engine.isRunning) playing=\(player.isPlaying) rate=\(engine.outputNode.outputFormat(forBus: 0).sampleRate)\n", stderr)
            app.run()
        } catch {
            fputs("audio tone stand-in: \(error)\n", stderr)
            exit(1)
        }
    }
}
