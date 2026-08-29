// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "spyly-audiotap",
    platforms: [.macOS("14.2")],
    targets: [
        .executableTarget(
            name: "spyly-audiotap",
            path: "Sources/spyly-audiotap",
            // The Info.plist is embedded into the binary itself: without it
            // the system shows no calendar access request for a standalone
            // executable, and EventKit silently answers with a refusal.
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
