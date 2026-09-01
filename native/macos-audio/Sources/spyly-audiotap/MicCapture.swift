import AVFoundation
import Foundation

/// Microphone capture.
///
/// It lives in the same helper as the system audio so that both tracks are
/// written the same way, Float32 mono at one sample rate, and so that recording
/// does not depend on whether the application window is open.
final class MicCapture {
    /// The engine is recreated: after a failed attempt with echo cancellation
    /// the same instance will not start again.
    private var engine = AVAudioEngine()
    /// A silent mixer: it keeps the graph alive for the sake of the echo cancellation node.
    private var silentMixer = AVAudioMixerNode()
    private var converter: AVAudioConverter?
    private let onSamples: (UnsafeBufferPointer<Float>) -> Void
    private let targetRate: Double

    init(targetRate: Double, onSamples: @escaping (UnsafeBufferPointer<Float>) -> Void) {
        self.targetRate = targetRate
        self.onSamples = onSamples
    }

    /// The microphone the system would pick on its own.
    static func defaultInputDevice() -> AudioDeviceID {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
        return id
    }

    /// The available input devices, for the drop-down in settings.
    static func inputDevices() -> [[String: Any]] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified)
        return session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    }

    /**
     * Starting the capture.
     *
     * Echo cancellation is tried first: the other side is audible through the
     * speakers, and the microphone records them along with your voice, so the
     * recording sounds echoed and the same phrases appear twice in the
     * transcript. Processing of our own does not cure that; a system node is
     * needed.
     *
     * But it does not work everywhere: it needs the same hardware on input and
     * output, and with an external microphone and separate speakers the engine
     * simply will not start. We then fall back to ordinary capture: echo is
     * unpleasant, whereas losing the recording entirely is unacceptable.
     */
    func start(deviceUID: String?, cancelEcho: Bool = false) throws {
        if cancelEcho {
            do {
                try startEngine(deviceUID: deviceUID, voiceProcessing: true)
                emit(["type": "echo", "cancelled": true])
                return
            } catch {
                // The application needs to know, not just the log: without this
                // node the other side is heard through the microphone, and the
                // person can only be told to put headphones on.
                emit([
                    "type": "echo",
                    "cancelled": false,
                    "message": "echo cancellation unavailable: \(error.localizedDescription)"
                ])
                teardown()
            }
        }
        try startEngine(deviceUID: deviceUID, voiceProcessing: false)
    }

    /// Start from a clean slate: the same engine will not come up a second time.
    private func teardown() {
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        try? engine.inputNode.setVoiceProcessingEnabled(false)
        engine = AVAudioEngine()
        silentMixer = AVAudioMixerNode()
        converter = nil
    }

    private func startEngine(deviceUID: String?, voiceProcessing: Bool) throws {
        let input = engine.inputNode

        /*
         * Choosing a particular microphone goes around AVAudioEngine, through
         * the underlying AudioUnit, or the engine always takes the default one.
         *
         * It has to happen before the cancellation node is switched on. The
         * other way round the node is already built around one device and being
         * moved to another throws it, and echo cancellation was quietly lost on
         * every recording — the application always names a device, even when it
         * is the default one anyway.
         *
         * And when it is the default one, we do not touch it at all: there is
         * nothing to change, and the untouched path is the one the cancellation
         * node is happiest with.
         */
        if let uid = deviceUID,
           let deviceID = MicCapture.deviceID(forUID: uid),
           deviceID != MicCapture.defaultInputDevice() {
            var id = deviceID
            if let unit = input.audioUnit {
                AudioUnitSetProperty(unit,
                                     kAudioOutputUnitProperty_CurrentDevice,
                                     kAudioUnitScope_Global,
                                     0,
                                     &id,
                                     UInt32(MemoryLayout<AudioDeviceID>.size))
            }
        }

        /*
         * The input format depends on whether the cancellation node is on, so it
         * is read only after switching.
         *
         * Only the input is switched. Switching the output as well used to look
         * like the careful thing to do — one node serves both directions — but
         * at this point the graph has no connections in it, and the output node
         * refuses with -10875, "no connection". The whole attempt then failed
         * and every recording quietly went without echo cancellation. Turning it
         * on at the input turns the shared node on for both ends anyway.
         */
        if voiceProcessing {
            try input.setVoiceProcessingEnabled(true)
        }

        let inFormat = input.outputFormat(forBus: 0)
        guard inFormat.sampleRate > 0 else { throw MicError.noInput }
        guard let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                            sampleRate: targetRate,
                                            channels: 1,
                                            interleaved: false),
              let conv = AVAudioConverter(from: inFormat, to: outFormat)
        else { throw MicError.converterFailed }
        converter = conv

        input.installTap(onBus: 0, bufferSize: 1024, format: inFormat) { [weak self] buffer, _ in
            guard let self, let conv = self.converter else { return }
            let ratio = outFormat.sampleRate / inFormat.sampleRate
            let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
            guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }
            var supplied = false
            var error: NSError?
            let status = conv.convert(to: out, error: &error) { _, statusOut in
                if supplied { statusOut.pointee = .noDataNow; return nil }
                supplied = true
                statusOut.pointee = .haveData
                return buffer
            }
            guard status != .error, out.frameLength > 0, let ch = out.floatChannelData else { return }
            self.onSamples(UnsafeBufferPointer(start: ch[0], count: Int(out.frameLength)))
        }

        // The cancellation node needs a working output: without one the engine
        // does not turn the graph and the microphone delivers flat silence. The
        // volume is zero, so nothing reaches the speakers and no feedback occurs.
        if voiceProcessing {
            engine.attach(silentMixer)
            silentMixer.outputVolume = 0
            engine.connect(input, to: silentMixer, format: inFormat)
            engine.connect(silentMixer, to: engine.mainMixerNode, format: nil)
        }

        engine.prepare()
        try engine.start()
    }

    private static func deviceID(forUID uid: String) -> AudioDeviceID? {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified)
        guard session.devices.contains(where: { $0.uniqueID == uid }) else { return nil }
        var addr = address(kAudioHardwarePropertyDevices)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size) == noErr
        else { return nil }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids) == noErr
        else { return nil }
        for id in ids where objectString(id, kAudioDevicePropertyDeviceUID) == uid { return id }
        return nil
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        if engine.isRunning { engine.stop() }
    }

    deinit { stop() }
}

enum MicError: CodedError {
    case noInput
    case converterFailed

    /// What the application matches on to pick its own wording.
    var reason: String {
        switch self {
        case .noInput: return "mic-unavailable"
        case .converterFailed: return "mic-converter-failed"
        }
    }

    var description: String {
        switch self {
        case .noInput: return "the microphone is unavailable or permission was not granted"
        case .converterFailed: return "could not create a converter for the microphone"
        }
    }
}
