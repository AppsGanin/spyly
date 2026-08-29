import AVFoundation
import EventKit
import Foundation

// The protocol with Node:
//   stdout is raw PCM: Float32, mono, at the sample rate that was asked for
//   stderr is line-by-line JSON with status, errors and the signal level
// Splitting the streams lets the audio be read without parsing and keeps it out of the logs.

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data((line + "\n").utf8))
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["type": "error", "message": message])
    exit(code)
}

struct Options {
    var mode = "capture"
    var micDevice: String?
    /// Remove what is playing through the speakers from the microphone. Switched off by a flag.
    var cancelEcho = true
    var sampleRate: Double = 16000
    var excludePIDs: [pid_t] = []
    var includePIDs: [pid_t] = []
}

func parseArguments() -> Options {
    var o = Options()
    var i = 1
    let args = CommandLine.arguments
    while i < args.count {
        let arg = args[i]
        switch arg {
        case "list-processes", "list-mics", "mic-status", "check", "capture", "capture-mic",
             "calendar-status", "calendar-request", "calendar-events":
            o.mode = arg
        case "--rate":
            i += 1
            if i < args.count, let v = Double(args[i]) { o.sampleRate = v }
        case "--exclude-pid":
            i += 1
            if i < args.count, let v = Int32(args[i]) { o.excludePIDs.append(v) }
        case "--include-pid":
            i += 1
            if i < args.count, let v = Int32(args[i]) { o.includePIDs.append(v) }
        case "--no-echo-cancel":
            o.cancelEcho = false
        case "--mic-device":
            i += 1
            if i < args.count { o.micDevice = args[i] }
        default:
            break
        }
        i += 1
    }
    return o
}

let options = parseArguments()

switch options.mode {
case "list-processes":
    let list = listAudioApps()
    if let data = try? JSONEncoder().encode(list), let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("[]")
    }
    exit(0)

case "calendar-status":
    emit(["type": "calendar", "granted": calendarAuthorized(), "denied": calendarDenied()])
    exit(calendarAuthorized() ? 0 : (calendarDenied() ? 3 : 2))

case "calendar-request":
    let granted = requestCalendarAccess(store: EKEventStore())
    emit(["type": "calendar", "granted": granted, "denied": calendarDenied()])
    exit(granted ? 0 : (calendarDenied() ? 3 : 2))

case "calendar-events":
    let back = Int(ProcessInfo.processInfo.environment["SPYLY_CAL_BACK"] ?? "") ?? 20
    let forward = Int(ProcessInfo.processInfo.environment["SPYLY_CAL_FORWARD"] ?? "") ?? 10
    let events = calendarEvents(backMinutes: back, forwardMinutes: forward)
    if let data = try? JSONEncoder().encode(events), let out = String(data: data, encoding: .utf8) {
        print(out)
    } else {
        print("[]")
    }
    exit(0)

case "list-mics":
    let devices = MicCapture.inputDevices()
    if let data = try? JSONSerialization.data(withJSONObject: devices), let out = String(data: data, encoding: .utf8) {
        print(out)
    } else { print("[]") }
    exit(0)

case "mic-status":
    let status = microphoneInUse()
    let payload: [String: Any] = ["type": "mic-status", "busy": status.busy, "apps": status.apps]
    if let data = try? JSONSerialization.data(withJSONObject: payload), let out = String(data: data, encoding: .utf8) {
        print(out)
    }
    exit(0)

case "check":
    // A permission probe: a tap is created and torn down at once. Trying is the
    // only reliable way to learn whether we will be let in.
    var probe = AudioObjectID(kAudioObjectUnknown)
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.isPrivate = true
    let status = AudioHardwareCreateProcessTap(description, &probe)
    if status == noErr {
        AudioHardwareDestroyProcessTap(probe)
        emit(["type": "check", "granted": true])
        exit(0)
    }
    emit(["type": "check", "granted": false, "status": Int(status)])
    exit(2)

default:
    break
}

// ── capture mode ────────────────────────────────────────────────────────────

let stdoutHandle = FileHandle.standardOutput

/// The signal level is computed synchronously under a lock.
///
/// This used to be `levelQueue.async { ... samples.count ... }`: the closure
/// outlived the callback and read an `UnsafeBufferPointer` after the buffer had
/// been released. It showed up outside as a zero level, but it was reading
/// freed memory.
final class LevelMeter {
    private let lock = NSLock()
    private var peak: Float = 0
    private var frames = 0

    func add(peak newPeak: Float, frames n: Int) {
        lock.lock()
        if newPeak > peak { peak = newPeak }
        frames += n
        lock.unlock()
    }

    /// Take the peak that has accumulated and reset it until the next report.
    func drain() -> (peak: Float, frames: Int) {
        lock.lock()
        let result = (peak, frames)
        peak = 0
        lock.unlock()
        return result
    }
}

let meter = LevelMeter()

/// Both tracks are written the same way: compute the level and hand the PCM to stdout.
let writeSamples: (UnsafeBufferPointer<Float>) -> Void = { samples in
    var sumSquares: Float = 0
    for v in samples { sumSquares += v * v }
    let rms = samples.isEmpty ? 0 : (sumSquares / Float(samples.count)).squareRoot()
    meter.add(peak: rms, frames: samples.count)
    stdoutHandle.write(Data(buffer: samples))
}

let capture = TapCapture(targetRate: options.sampleRate, onSamples: writeSamples)
let mic = MicCapture(targetRate: options.sampleRate, onSamples: writeSamples)

// Cleaning up on signals is mandatory too: otherwise the private aggregate is
// left behind in the system after the process is killed.
var signalSources: [DispatchSourceSignal] = []
var shuttingDown = false
func shutdown(_ code: Int32) {
    guard !shuttingDown else { return }
    shuttingDown = true
    capture.stop()
    mic.stop()
    exit(code)
}
for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown(0) }
    source.resume()
    signalSources.append(source)
}

// If the parent (Electron) has died there is nobody left to write for, so we exit.
let parentWatch = DispatchSource.makeTimerSource(queue: .main)
parentWatch.schedule(deadline: .now() + 2, repeating: 2)
parentWatch.setEventHandler {
    if getppid() == 1 { shutdown(0) }
}
parentWatch.resume()

let levelTimer = DispatchSource.makeTimerSource(queue: .main)
levelTimer.schedule(deadline: .now() + 0.1, repeating: 0.1)
levelTimer.setEventHandler {
    let (peak, frames) = meter.drain()
    emit(["type": "level", "rms": Double(peak), "frames": frames])
}
levelTimer.resume()

do {
    if options.mode == "capture-mic" {
        try mic.start(deviceUID: options.micDevice, cancelEcho: options.cancelEcho)
    } else {
        let scope: TapScope = options.includePIDs.isEmpty
            ? .global(excludePIDs: options.excludePIDs)
            : .processes(options.includePIDs)
        try capture.start(scope: scope)
    }
    emit(["type": "ready", "sampleRate": options.sampleRate, "channels": 1, "format": "f32le"])
} catch {
    fail("\(error)")
}

RunLoop.main.run()
