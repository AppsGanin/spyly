import AVFoundation
import Foundation

/// Захват микрофона.
///
/// Живёт в том же хелпере, что и системный звук, чтобы обе дорожки писались
/// одинаково — Float32 моно на одной частоте — и запись не зависела от того,
/// открыто ли окно приложения.
final class MicCapture {
    /// Движок пересоздаётся: после неудачной попытки с подавлением эха тот же
    /// экземпляр больше не запускается.
    private var engine = AVAudioEngine()
    /// Немой микшер: держит граф живым ради узла подавления эха.
    private var silentMixer = AVAudioMixerNode()
    private var converter: AVAudioConverter?
    private let onSamples: (UnsafeBufferPointer<Float>) -> Void
    private let targetRate: Double

    init(targetRate: Double, onSamples: @escaping (UnsafeBufferPointer<Float>) -> Void) {
        self.targetRate = targetRate
        self.onSamples = onSamples
    }

    /// Доступные устройства ввода — для выпадающего списка в настройках.
    static func inputDevices() -> [[String: Any]] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified)
        return session.devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }
    }

    /**
     * Запуск захвата.
     *
     * Сначала пробуем с подавлением эха: собеседника слышно из динамиков, и
     * микрофон записывает его вместе с вашим голосом — запись звучит с эхом,
     * а в расшифровке одни и те же фразы появляются дважды. Своей обработкой
     * это не лечится, нужен системный узел.
     *
     * Но он работает не везде: ему нужен один и тот же аппарат на вход и
     * выход, и на внешнем микрофоне с отдельными колонками движок просто не
     * запускается. Тогда откатываемся на обычный захват — эхо неприятно, а вот
     * потерять запись целиком недопустимо.
     */
    func start(deviceUID: String?, cancelEcho: Bool = true) throws {
        if cancelEcho {
            do {
                try startEngine(deviceUID: deviceUID, voiceProcessing: true)
                emit(["type": "info", "message": "подавление эха включено"])
                return
            } catch {
                emit([
                    "type": "info",
                    "message": "подавление эха недоступно, пишем как есть: \(error.localizedDescription)"
                ])
                teardown()
            }
        }
        try startEngine(deviceUID: deviceUID, voiceProcessing: false)
    }

    /// Начать с чистого листа: повторно тот же движок уже не поднимется.
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

        // Порядок важен: формат входа зависит от того, включён ли узел
        // подавления, поэтому читаем его только после переключения.
        if voiceProcessing {
            // Узел один на вход и выход: включать надо оба конца, иначе движок
            // не инициализирует выходной узел и падает с -10875.
            try input.setVoiceProcessingEnabled(true)
            try engine.outputNode.setVoiceProcessingEnabled(true)
        }

        // Выбор конкретного микрофона идёт мимо AVAudioEngine — через нижележащий
        // AudioUnit, иначе движок всегда возьмёт устройство по умолчанию.
        if let uid = deviceUID, let deviceID = MicCapture.deviceID(forUID: uid) {
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

        // Узлу подавления нужен работающий выход: без него движок не крутит
        // граф и с микрофона приходит ровная тишина. Громкость нулевая, так
        // что в динамики ничего не попадает и обратной связи не возникает.
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

enum MicError: Error, CustomStringConvertible {
    case noInput
    case converterFailed
    var description: String {
        switch self {
        case .noInput: return "микрофон недоступен или не выдано разрешение"
        case .converterFailed: return "не удалось создать конвертер для микрофона"
        }
    }
}
