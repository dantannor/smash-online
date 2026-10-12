import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreAudio

@main
struct SCKAudio {
    static func main() async {
        guard CommandLine.arguments.count == 3, let pid = pid_t(CommandLine.arguments[1]) else {
            fputs("usage: sck-audio <process-pid> <sidecar-ws-url>\n", stderr)
            exit(2)
        }
        let url = URL(string: CommandLine.arguments[2])!
        do {
            _ = NSApplication.shared
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let target = content.applications.first(where: { $0.processID == pid }),
                  let display = content.displays.first else {
                throw AudioCaptureError.appNotFound(pid)
            }
            let filter = SCContentFilter(display: display, excludingApplications: content.applications.filter { $0.processID != pid }, exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48_000
            configuration.channelCount = 2
            let relay = PCMRelay(url: url)
            let stream = SCStream(filter: filter, configuration: configuration, delegate: relay)
            let sampleQueue = DispatchQueue(label: "smash.sck.audio")
            try stream.addStreamOutput(relay, type: .screen, sampleHandlerQueue: sampleQueue)
            try stream.addStreamOutput(relay, type: .audio, sampleHandlerQueue: sampleQueue)
            try await stream.startCapture()
            fputs("sck-audio: capturing pid=\(pid) (\(target.bundleIdentifier)) at 48kHz stereo\n", stderr)
            signal(SIGINT) { _ in exit(0) }
            signal(SIGTERM) { _ in exit(0) }
            dispatchMain()
        } catch {
            fputs("sck-audio: \(error)\n", stderr)
            exit(1)
        }
    }
}

final class PCMRelay: NSObject, SCStreamOutput, SCStreamDelegate {
    private let url: URL
    private let session = URLSession(configuration: .default)
    private var socket: URLSessionWebSocketTask?
    private let lock = NSLock()
    private var retry: DispatchSourceTimer?

    init(url: URL) {
        self.url = url
        super.init()
        connect()
    }

    private func connect() {
        let task = session.webSocketTask(with: url)
        lock.lock(); socket = task; lock.unlock()
        task.resume()
        receive(from: task)
    }

    private func receive(from task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            guard let self, let task else { return }
            switch result {
            case .success:
                self.receive(from: task)
            case .failure:
                self.reconnect()
            }
        }
    }

    private func reconnect() {
        lock.lock()
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        lock.unlock()
        guard retry == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 1)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.retry?.cancel()
            self.retry = nil
            self.connect()
        }
        retry = timer
        timer.resume()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferIsValid(sampleBuffer),
              let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee,
              streamDescription.mFormatID == kAudioFormatLinearPCM,
              streamDescription.mBitsPerChannel == 32,
              streamDescription.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              streamDescription.mChannelsPerFrame == 2 else { return }
        var requiredSize = 0
        var retainedBlock: CMBlockBuffer?
        let queryStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: &requiredSize, bufferListOut: nil,
            bufferListSize: 0, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlock
        )
        guard queryStatus == noErr, requiredSize > 0 else { return }
        let storage = UnsafeMutableRawPointer.allocate(byteCount: requiredSize, alignment: 16)
        defer { storage.deallocate() }
        let list = storage.assumingMemoryBound(to: AudioBufferList.self)
        let readStatus = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil, bufferListOut: list,
            bufferListSize: requiredSize, blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment),
            blockBufferOut: &retainedBlock
        )
        guard readStatus == noErr else { return }
        let frameCount = Int(CMSampleBufferGetNumSamples(sampleBuffer))
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        var bytes = Data(count: frameCount * 8)
        let copied = bytes.withUnsafeMutableBytes { raw -> Bool in
            let output = raw.bindMemory(to: Float.self)
            if buffers.count == 1, buffers[0].mNumberChannels == 2, buffers[0].mDataByteSize >= frameCount * 8, let source = buffers[0].mData {
                output.baseAddress!.update(from: source.assumingMemoryBound(to: Float.self), count: frameCount * 2)
                return true
            }
            if buffers.count == 2, buffers.allSatisfy({ $0.mNumberChannels == 1 && $0.mDataByteSize >= frameCount * 4 }), let left = buffers[0].mData, let right = buffers[1].mData {
                let leftSamples = left.assumingMemoryBound(to: Float.self)
                let rightSamples = right.assumingMemoryBound(to: Float.self)
                for frame in 0..<frameCount { output[frame * 2] = leftSamples[frame]; output[frame * 2 + 1] = rightSamples[frame] }
                return true
            }
            return false
        }
        guard copied else { return }
        lock.lock(); let task = socket; lock.unlock()
        task?.send(.data(bytes)) { [weak self] error in if error != nil { self?.reconnect() } }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { fputs("sck-audio: stream stopped: \(error)\n", stderr) }
}

enum AudioCaptureError: Error, CustomStringConvertible {
    case appNotFound(pid_t)
    case windowNotFound(pid_t)
    var description: String {
        switch self {
        case .appNotFound(let pid): return "no ScreenCaptureKit app entry for process \(pid)"
        case .windowNotFound(let pid): return "no ScreenCaptureKit window for process \(pid)"
        }
    }
}
