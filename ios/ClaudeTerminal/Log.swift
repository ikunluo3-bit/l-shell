import Foundation

/// Persistent log at Documents/lshell.log — survives crashes so we can see how far
/// boot got and what Node printed before an abrupt exit. Readable via the Files app.
enum Log {
    static let url: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("lshell.log")
    }()

    private static let queue = DispatchQueue(label: "lshell.log")
    private static var handle: FileHandle?

    /// Truncate + open a fresh log for this launch.
    static func start() {
        queue.sync {
            FileManager.default.createFile(atPath: url.path, contents: nil)
            handle = try? FileHandle(forWritingTo: url)
        }
        line("=== L Shell launch \(Date()) ===")
        installCrashHandlers()
    }

    /// A timestamped diagnostic line.
    static func line(_ s: String) {
        raw(Data(("[\(stamp())] " + s + "\n").utf8))
    }

    /// Raw bytes (used to tee Node's stdout/stderr verbatim).
    static func raw(_ data: Data) {
        queue.async {
            if handle == nil { handle = try? FileHandle(forWritingTo: url) }
            // Throwing API — NOT the deprecated write(_:), which raises an UNCATCHABLE
            // NSException on any write error (disk full / I/O). This is the hottest path
            // (tees every Node output chunk), so a bad write must fail quietly, not abort.
            try? handle?.write(contentsOf: data)
        }
    }

    private static func stamp() -> String {
        let t = Date().timeIntervalSince1970
        return String(format: "%.3f", t.truncatingRemainder(dividingBy: 100000))
    }

    // MARK: crash capture

    private static func installCrashHandlers() {
        NSSetUncaughtExceptionHandler { ex in
            Log.line("‼️ NSException \(ex.name.rawValue): \(ex.reason ?? "")")
            Log.line(ex.callStackSymbols.joined(separator: "\n"))
        }
        for sig in [SIGABRT, SIGSEGV, SIGILL, SIGBUS, SIGTRAP, SIGFPE] {
            signal(sig) { s in
                // async-signal-safe enough for a short marker: write() directly.
                let msg = "‼️ FATAL signal \(s)\n"
                if let fh = Log.handle { try? fh.write(contentsOf: Data(msg.utf8)) }
                signal(s, SIG_DFL); raise(s)
            }
        }
    }
}
