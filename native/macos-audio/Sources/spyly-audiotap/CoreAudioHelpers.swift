import AppKit
import CoreAudio
import Foundation

/// Селекторы CoreAudio, для которых в Swift нет готовых констант.
enum Sel {
    static func fourCC(_ s: String) -> AudioObjectPropertySelector {
        var r: UInt32 = 0
        for c in s.utf8 { r = (r << 8) + UInt32(c) }
        return r
    }
    static let tapUID = fourCC("tuid")
    static let tapFormat = fourCC("tfmt")
    static let processBundleID = fourCC("pbid")
    static let processPID = fourCC("ppid")
    static let processIsRunningOutput = fourCC("pado")
    static let processObjectList = fourCC("prs#")
    static let translatePIDToProcessObject = fourCC("id2p")
    static let deviceIsRunningSomewhere = fourCC("gone")
    static let processIsRunningInput = fourCC("padi")
}

func address(_ selector: AudioObjectPropertySelector,
             scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func objectString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<CFString?>.size)
    var out: CFString?
    let err = withUnsafeMutablePointer(to: &out) {
        AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0)
    }
    return err == noErr ? out as String? : nil
}

func objectUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
    var addr = address(selector)
    var size = UInt32(MemoryLayout<UInt32>.size)
    var out: UInt32 = 0
    let err = AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &out)
    return err == noErr ? out : nil
}

func objectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
    var addr = address(selector)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = [AudioObjectID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &ids) == noErr else { return [] }
    return ids
}

/// CATapDescription принимает не PID, а идентификаторы аудиообъектов процессов.
func processObjectID(forPID pid: pid_t) -> AudioObjectID? {
    var addr = address(Sel.translatePIDToProcessObject)
    var input = pid
    var out = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let err = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &addr,
        UInt32(MemoryLayout<pid_t>.size), &input, &size, &out)
    return err == noErr && out != kAudioObjectUnknown ? out : nil
}

func defaultOutputDevice() -> (id: AudioObjectID, uid: String)? {
    var addr = address(kAudioHardwarePropertyDefaultOutputDevice)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var device = AudioObjectID(kAudioObjectUnknown)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr,
          let uid = objectString(device, kAudioDevicePropertyDeviceUID)
    else { return nil }
    return (device, uid)
}

/// Приложение как его видит пользователь.
///
/// Звук браузерных созвонов (Meet, Телемост в Chrome) идёт не от основного
/// процесса, а от хелперов, поэтому процессы одного приложения схлопываются
/// в одну запись со списком PID — при захвате нужны все они.
struct AudioApp: Encodable {
    let key: String
    let name: String
    let bundleID: String?
    let pids: [Int32]
    let isPlaying: Bool
}

/// `com.google.Chrome.helper.renderer` → `com.google.Chrome`
private func baseBundleID(_ bundle: String) -> String {
    var parts = bundle.split(separator: ".").map(String.init)
    while let last = parts.last, ["helper", "renderer", "gpu", "plugin"].contains(last.lowercased()) {
        parts.removeLast()
    }
    return parts.joined(separator: ".")
}

/// «Google Chrome Helper (Renderer)» → «Google Chrome»
private func baseAppName(_ name: String) -> String {
    if let range = name.range(of: " Helper") { return String(name[name.startIndex..<range.lowerBound]) }
    return name
}

func listAudioApps() -> [AudioApp] {
    let objects = objectList(AudioObjectID(kAudioObjectSystemObject), Sel.processObjectList)

    // Показываем только приложения с иконкой в Dock. Это надёжнее списка
    // исключений: отсекает демоны вроде loginwindow и Пункта управления,
    // но оставляет Safari и FaceTime, в которых тоже созваниваются.
    let userApps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    let userAppBundles = Set(userApps.compactMap { $0.bundleIdentifier })
    let userAppNames = Set(userApps.compactMap { $0.localizedName })

    struct Accumulator {
        var name: String
        var bundleID: String?
        var pids: [Int32] = []
        var isPlaying = false
    }
    var groups: [String: Accumulator] = [:]
    var seenPIDs = Set<Int32>()

    for object in objects {
        guard let rawPID = objectUInt32(object, Sel.processPID) else { continue }
        let pid = Int32(bitPattern: rawPID)
        guard pid > 0, !seenPIDs.contains(pid) else { continue }
        seenPIDs.insert(pid)

        let bundle = objectString(object, Sel.processBundleID)
        let running = NSRunningApplication(processIdentifier: pid)
        let rawName = running?.localizedName

        let base = bundle.map(baseBundleID)
        let displayName = baseAppName(rawName ?? base ?? "PID \(pid)")
        guard !displayName.isEmpty else { continue }

        // Хелперы браузера сами по себе в Dock не значатся, поэтому проверяем
        // не сам процесс, а приложение, которому он принадлежит.
        let belongsToUserApp = (base.map(userAppBundles.contains) ?? false) || userAppNames.contains(displayName)
        guard belongsToUserApp else { continue }
        let key = base ?? displayName
        let playing = (objectUInt32(object, Sel.processIsRunningOutput) ?? 0) != 0

        var acc = groups[key] ?? Accumulator(name: displayName, bundleID: base)
        // Более короткое имя обычно и есть имя основного приложения.
        if displayName.count < acc.name.count { acc.name = displayName }
        acc.pids.append(pid)
        acc.isPlaying = acc.isPlaying || playing
        groups[key] = acc
    }

    return groups
        .map { AudioApp(key: $0.key, name: $0.value.name, bundleID: $0.value.bundleID,
                        pids: $0.value.pids.sorted(), isPlaying: $0.value.isPlaying) }
        .sorted { ($0.isPlaying ? 0 : 1, $0.name.lowercased()) < ($1.isPlaying ? 0 : 1, $1.name.lowercased()) }
}

/// Кто-то другой сейчас пишет с микрофона.
///
/// Главный признак того, что идёт созвон: он ловит и браузерные звонки
/// (Meet, Телемост в Chrome), где имя процесса ничего не говорит.
/// Оговорка: Bluetooth-гарнитуры на macOS стабильно сообщают, что не
/// используются, поэтому одного этого признака мало.
func microphoneInUse() -> (busy: Bool, apps: [String]) {
    var apps: [String] = []
    let objects = objectList(AudioObjectID(kAudioObjectSystemObject), Sel.processObjectList)
    let userApps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    let userAppBundles = Set(userApps.compactMap { $0.bundleIdentifier })

    for object in objects {
        guard (objectUInt32(object, Sel.processIsRunningInput) ?? 0) != 0 else { continue }
        guard let rawPID = objectUInt32(object, Sel.processPID) else { continue }
        let pid = Int32(bitPattern: rawPID)
        let name = NSRunningApplication(processIdentifier: pid)?.localizedName
        let bundle = objectString(object, Sel.processBundleID)
        let base = bundle.map { $0.split(separator: ".").prefix(3).joined(separator: ".") }
        // Себя в список не включаем: мы и сами пишем с микрофона.
        if pid == ProcessInfo.processInfo.processIdentifier { continue }
        let belongsToUserApp = (base.map(userAppBundles.contains) ?? false) || name != nil
        if belongsToUserApp, let display = name ?? bundle {
            if !apps.contains(display) { apps.append(display) }
        }
    }

    // Запасной признак: устройство ввода занято кем-то в системе.
    var deviceBusy = false
    var addr = address(kAudioHardwarePropertyDefaultInputDevice)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var device = AudioObjectID(kAudioObjectUnknown)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device) == noErr {
        deviceBusy = (objectUInt32(device, Sel.deviceIsRunningSomewhere) ?? 0) != 0
    }

    return (!apps.isEmpty || deviceBusy, apps)
}
