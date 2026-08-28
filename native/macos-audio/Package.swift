// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "spyly-audiotap",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(
            name: "spyly-audiotap",
            path: "Sources/spyly-audiotap",
            // Info.plist встраивается в сам бинарник: без него система не
            // показывает запрос доступа к календарю по отдельному
            // исполняемому файлу — EventKit молча отвечает отказом.
            linkerSettings: [
                .unsafeFlags([
                    "-Xlinker", "-sectcreate",
                    "-Xlinker", "__TEXT",
                    "-Xlinker", "__info_plist",
                    "-Xlinker", "Sources/spyly-audiotap/Info.plist"
                ])
            ]
        )
    ]
)
