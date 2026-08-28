import AVFoundation
import CoreAudio
import Foundation

enum TapError: Error, CustomStringConvertible {
    case noOutputDevice
    case tapFailed(OSStatus)
    case noTapUID
    case aggregateFailed(OSStatus)
    case formatFailed(OSStatus)
    case ioProcFailed(OSStatus)
    case startFailed(OSStatus)
    case converterFailed
    case noSuchProcess

    var description: String {
        switch self {
        case .noOutputDevice: return "не удалось определить устройство вывода"
        case .tapFailed(let s): return "AudioHardwareCreateProcessTap failed (\(s)) — вероятно, нет разрешения на запись системного звука"
        case .noTapUID: return "у созданного tap нет UID"
        case .aggregateFailed(let s): return "AudioHardwareCreateAggregateDevice failed (\(s))"
        case .formatFailed(let s): return "не удалось прочитать формат tap (\(s))"
        case .ioProcFailed(let s): return "AudioDeviceCreateIOProcIDWithBlock failed (\(s))"
        case .startFailed(let s): return "AudioDeviceStart failed (\(s))"
        case .converterFailed: return "не удалось создать конвертер частоты дискретизации"
        case .noSuchProcess: return "выбранное приложение не найдено среди источников звука"
        }
    }
}

/// Что именно писать: весь системный звук или звук конкретных приложений.
enum TapScope {
    case global(excludePIDs: [pid_t])
    case processes([pid_t])
}

/// Захват системного звука через CoreAudio process tap.
///
/// Chromium на macOS 26 этот путь не осиливает (его probe разрешений падает
/// молча), поэтому tap создаётся и обслуживается здесь напрямую.
final class TapCapture {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private var outputFormat: AVAudioFormat?
    private let onSamples: (UnsafeBufferPointer<Float>) -> Void
    private let targetRate: Double

    init(targetRate: Double, onSamples: @escaping (UnsafeBufferPointer<Float>) -> Void) {
        self.targetRate = targetRate
        self.onSamples = onSamples
    }

    func start(scope: TapScope) throws {
        guard let output = defaultOutputDevice() else { throw TapError.noOutputDevice }

        let description: CATapDescription
        switch scope {
        case .global(let excluded):
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded.compactMap(processObjectID(forPID:)))
        case .processes(let pids):
            let objects = pids.compactMap(processObjectID(forPID:))
            guard !objects.isEmpty else { throw TapError.noSuchProcess }
            description = CATapDescription(stereoMixdownOfProcesses: objects)
        }
        // Приватный tap не появляется в общесистемном списке устройств,
        // а unmuted значит, что пользователь продолжает слышать звук как обычно.
        description.isPrivate = true
        description.muteBehavior = .unmuted

        let tapStatus = AudioHardwareCreateProcessTap(description, &tapID)
        guard tapStatus == noErr else { throw TapError.tapFailed(tapStatus) }
        guard let tapUID = objectString(tapID, Sel.tapUID) else { throw TapError.noTapUID }

        let aggregateDescription: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Spyly System Audio",
            kAudioAggregateDeviceUIDKey: "com.spyly.aggregate.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: output.uid,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: output.uid]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: tapUID
            ]]
        ]
        let aggStatus = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
        guard aggStatus == noErr else { throw TapError.aggregateFailed(aggStatus) }

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var formatAddr = address(Sel.tapFormat)
        let fmtStatus = AudioObjectGetPropertyData(tapID, &formatAddr, 0, nil, &size, &asbd)
        guard fmtStatus == noErr, asbd.mSampleRate > 0 else { throw TapError.formatFailed(fmtStatus) }

        guard let inFormat = AVAudioFormat(streamDescription: &asbd),
              let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                            sampleRate: targetRate,
                                            channels: 1,
                                            interleaved: false),
              let conv = AVAudioConverter(from: inFormat, to: outFormat)
        else { throw TapError.converterFailed }

        inputFormat = inFormat
        outputFormat = outFormat
        converter = conv

        let procStatus = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) { [weak self] _, inputData, _, _, _ in
            self?.handle(inputData)
        }
        guard procStatus == noErr, ioProcID != nil else { throw TapError.ioProcFailed(procStatus) }

        let startStatus = AudioDeviceStart(aggregateID, ioProcID)
        guard startStatus == noErr else { throw TapError.startFailed(startStatus) }
    }

    private func handle(_ inputData: UnsafePointer<AudioBufferList>) {
        guard let inFormat = inputFormat, let outFormat = outputFormat, let conv = converter else { return }

        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard let firstBuffer = list.first, firstBuffer.mDataByteSize > 0 else { return }
        let channels = max(1, Int(inFormat.channelCount))
        let bytesPerFrame = MemoryLayout<Float>.size * (list.count > 1 ? 1 : channels)
        let frames = Int(firstBuffer.mDataByteSize) / bytesPerFrame
        guard frames > 0 else { return }

        guard let inBuffer = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        inBuffer.frameLength = AVAudioFrameCount(frames)
        let dst = UnsafeMutableAudioBufferListPointer(inBuffer.mutableAudioBufferList)
        for i in 0..<min(dst.count, list.count) {
            guard let src = list[i].mData, let out = dst[i].mData else { continue }
            let n = min(Int(list[i].mDataByteSize), Int(dst[i].mDataByteSize))
            memcpy(out, src, n)
            dst[i].mDataByteSize = UInt32(n)
        }

        // Ресемплинг делает AVAudioConverter: наивное прореживание 48→16 кГц
        // даёт алиасинг, который потом виден как «металл» в расшифровке.
        let ratio = outFormat.sampleRate / inFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(frames) * ratio) + 32
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return }

        var supplied = false
        var error: NSError?
        let status = conv.convert(to: outBuffer, error: &error) { _, statusOut in
            if supplied {
                statusOut.pointee = .noDataNow
                return nil
            }
            supplied = true
            statusOut.pointee = .haveData
            return inBuffer
        }
        guard status != .error, outBuffer.frameLength > 0, let channelData = outBuffer.floatChannelData else { return }
        onSamples(UnsafeBufferPointer(start: channelData[0], count: Int(outBuffer.frameLength)))
    }

    /// Убрать за собой обязательно: приватный агрегат, оставшийся после падения,
    /// висит в списке аудиоустройств системы до перезагрузки.
    func stop() {
        if let proc = ioProcID, aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, proc)
            AudioDeviceDestroyIOProcID(aggregateID, proc)
            ioProcID = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    deinit { stop() }
}
