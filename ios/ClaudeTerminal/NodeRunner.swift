import Foundation
import UIKit
import NodeMobile

/// Boots the embedded Node.js (nodejs-mobile, V8 jitless) and bridges its stdio to
/// the terminal view. iOS forbids fork/exec, so Node runs IN-PROCESS: node_start()
/// takes over a background thread's event loop for the life of the session.
///
/// stdio bridge (the Code App pattern): we dup2 pipes onto the process's std fds so
/// Node's stdout/stderr flow back to us as bytes, and our keystrokes reach Node's
/// stdin. A 4th pipe carries out-of-band control (live terminal resize); its read fd
/// is handed to JS via CLAUDE_IOS_CONTROL_FD so it never collides with anything.
final class NodeRunner {

    static let shared = NodeRunner()

    /// Node's stdout/stderr bytes (already on the main queue).
    var onOutput: ((Data) -> Void)?
    /// Fired when the Node runtime truly dies (the JS session loop otherwise keeps
    /// Node alive across cli.js exits — new sessions start on Enter).
    var onSessionEnd: (() -> Void)?

    private let inPipe = Pipe()       // app  -> node stdin
    private let outPipe = Pipe()      // node stdout+stderr -> app
    private let controlPipe = Pipe()  // app  -> node control fd

    private var started = false
    private let startLock = NSLock()

    var isStarted: Bool {
        startLock.lock(); defer { startLock.unlock() }
        return started
    }

    /// All pipe writes happen here, never on main: a full 64KB pipe blocks only this
    /// queue, and raw Darwin.write() can't throw the uncatchable NSException that
    /// FileHandle.write raises on EPIPE.
    private let inputQueue = DispatchQueue(label: "node-input")

    /// Guards sessionAlive / nodeLaunched / pendingResize.
    private let stateLock = NSLock()
    private var sessionAlive = false
    private var nodeLaunched = false
    /// Latest size reported before Node launched; flushed right after launch.
    private var pendingResize: (cols: Int, rows: Int)?

    /// Output coalescing: readabilityHandler fires on a GCD thread per pipe read;
    /// batching to one main-queue hop every ~8ms keeps the UI responsive under
    /// heavy streams.
    private let outputLock = NSLock()
    private var outputBuffer = Data()
    private var flushScheduled = false

    private init() {}

    /// Launch Claude Code. `resourceRoot` is the bundled node-runtime directory;
    /// `home` is the sandbox HOME; `workspace` is the initial working directory.
    func start(resourceRoot: String,
               home: String,
               workspace: String,
               columns: Int,
               rows: Int,
               extraEnv: [String: String] = [:]) {
        startLock.lock(); defer { startLock.unlock() }
        guard !started else { return }
        started = true

        Log.start()
        Log.line("NodeRunner.start resourceRoot=\(resourceRoot) home=\(home) ws=\(workspace) \(columns)x\(rows)")
        Log.line("extraEnv keys: \(extraEnv.keys.sorted().joined(separator: ","))")

        // EPIPE must come back as write() == -1, never as a process-killing signal.
        signal(SIGPIPE, SIG_IGN)

        stateLock.lock()
        sessionAlive = true
        stateLock.unlock()

        redirectStdio()
        applyEnvironment(resourceRoot: resourceRoot, home: home, workspace: workspace,
                         columns: columns, rows: rows, extraEnv: extraEnv)
        FileManager.default.changeCurrentDirectoryPath(workspace)

        let bootstrap = (resourceRoot as NSString).appendingPathComponent("bootstrap.js")
        Log.line("bootstrap path: \(bootstrap) exists=\(FileManager.default.fileExists(atPath: bootstrap))")
        // Real-device V8 flags (the simulator's looser sandbox/address space hid the need):
        //  --jitless               no JIT code region reserved at startup.
        //  --no-short-builtin-calls  CRITICAL on >=4GB devices: V8 auto-enables
        //     short_builtin_calls, which reserves a 128MB CodeRange and mprotect(PROT_EXEC)s
        //     the remapped embedded builtins INDEPENDENT of --jitless. Without a JIT
        //     entitlement iOS refuses execute on that page → Instruction Abort in
        //     Builtins_* during node::InitializePrimordials → SIGKILL (was 9/10 device
        //     crashes). This keeps builtins running in-place from the signed __TEXT.
        //  --regexp-interpret-all  force the RegExp interpreter so irregexp never codegens
        //     (the only other V8 subsystem that lazily requests executable memory).
        //  --stack-size=864        make a genuine deep-recursion overflow throw a catchable
        //     RangeError well before the 16MB native guard page (see thread.stackSize).
        var argv = ["node", "--jitless", "--no-short-builtin-calls",
                    "--regexp-interpret-all", "--stack-size=864"]
        if let flags = ProcessInfo.processInfo.environment["LSHELL_NODE_FLAGS"] {
            argv += flags.split(separator: " ").map(String.init)
        }
        argv.append(bootstrap)
        Log.line("node argv: \(argv.joined(separator: " "))")
        launchNode(argv: argv)

        // Flush any resize reported while Node was still pre-launch.
        stateLock.lock()
        nodeLaunched = true
        let pending = pendingResize
        pendingResize = nil
        stateLock.unlock()
        if let p = pending { writeControl("resize \(p.cols) \(p.rows)\n") }

        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = true
        }
    }

    // MARK: input

    /// Send user keystrokes to Node's stdin.
    func sendInput(_ data: Data) {
        write(data, to: inPipe.fileHandleForWriting.fileDescriptor)
    }
    func sendInput(_ text: String) { sendInput(Data(text.utf8)) }

    /// Notify the JS side of a new terminal size (drives SIGWINCH in the tty shim).
    /// Pre-launch sizes are held and flushed once Node is up.
    func resize(columns: Int, rows: Int) {
        stateLock.lock()
        if !nodeLaunched {
            pendingResize = (columns, rows)
            stateLock.unlock()
            return
        }
        stateLock.unlock()
        writeControl("resize \(columns) \(rows)\n")
    }

    /// Send a newline-delimited command on the out-of-band control fd (e.g.
    /// `enqueue <base64>`). Works even while a foreground program owns stdin.
    func sendControl(_ line: String) {
        writeControl(line.hasSuffix("\n") ? line : line + "\n")
    }

    // MARK: display-only notes

    /// Inject a dim informational line into the terminal (never sent to Node).
    /// Thread-safe; rides the normal coalesced output path to preserve byte order.
    func feedNote(_ text: String) {
        enqueueOutput(Data("\r\n\u{001B}[2m\(text)\u{001B}[0m\r\n".utf8))
    }

    /// UI hint for the (rare) case the runtime itself dies — cli.js exits are handled
    /// by the JS session loop, which waits for Enter to start a new session.
    func endSessionUIHint() {
        feedNote(AppStrings.sessionEndedRelaunch)
    }

    // MARK: internals

    private func writeControl(_ line: String) {
        write(Data(line.utf8), to: controlPipe.fileHandleForWriting.fileDescriptor)
    }

    /// Serial off-main writer: loops over partial writes, retries EINTR; on EPIPE/
    /// EBADF (or any other failure) drops silently and marks the session dead.
    private func write(_ data: Data, to fd: Int32) {
        inputQueue.async { [weak self] in
            guard let self else { return }
            self.stateLock.lock()
            let alive = self.sessionAlive
            self.stateLock.unlock()
            guard alive else { return }

            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard var p = raw.baseAddress else { return }
                var remaining = raw.count
                while remaining > 0 {
                    let n = Darwin.write(fd, p, remaining)
                    if n > 0 {
                        p = p.advanced(by: n)
                        remaining -= n
                    } else if n < 0 && errno == EINTR {
                        continue
                    } else {
                        self.stateLock.lock()
                        self.sessionAlive = false
                        self.stateLock.unlock()
                        return
                    }
                }
            }
        }
    }

    private func redirectStdio() {
        // Unbuffer so the terminal sees output immediately.
        setvbuf(stdout, nil, _IONBF, 0)
        setvbuf(stderr, nil, _IONBF, 0)

        dup2(outPipe.fileHandleForWriting.fileDescriptor, STDOUT_FILENO)
        dup2(outPipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
        dup2(inPipe.fileHandleForReading.fileDescriptor, STDIN_FILENO)
        // Control channel fd is passed via CLAUDE_IOS_CONTROL_FD (applyEnvironment);
        // no dup2 — stealing fd 3 broke callers that expect it free.

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            Log.raw(data)                 // tee everything Node prints into the log
            if let terminalData = self.filterTerminalNoise(data) {
                self.enqueueOutput(terminalData)
            }
        }
        Log.line("redirectStdio done (stdout/stderr/stdin dup2'd)")
    }

    // iOS routes NSLog / os_log / CoreText diagnostics to the process's stderr (fd 2),
    // which redirectStdio() dup2's onto the terminal pipe — so lines like
    //   "2026-07-07 14:33:00.691 ClaudeTerminal[2666:1110910] CoreText note: …"
    // leak into the terminal on launch. Every such line carries the "<name>[pid:tid]"
    // marker that real Node/Claude terminal output never emits; strip only those,
    // leaving every other byte (ANSI escapes, normal output) untouched.
    private lazy var systemLogMarker = Data("\(ProcessInfo.processInfo.processName)[".utf8)
    private static let systemLogRegex = try? NSRegularExpression(
        pattern: #"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \S+\[\d+:\d+\] .*(\n|$)"#,
        options: [.anchorsMatchLines])

    private func filterTerminalNoise(_ data: Data) -> Data? {
        #if targetEnvironment(simulator)
        if let text = String(data: data, encoding: .utf8),
           text.contains("Class UIAccessibilityLoaderWebShared is implemented in both"),
           text.contains("WebCore.axbundle"),
           text.contains("WebKit.axbundle") {
            return nil
        }
        #endif
        // Fast path: only chunks carrying the process-log marker can hold a system log.
        guard data.range(of: systemLogMarker) != nil,
              let regex = Self.systemLogRegex,
              let text = String(data: data, encoding: .utf8) else { return data }
        let stripped = regex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: "")
        if stripped == text { return data }          // marker present but not a log line
        if stripped.isEmpty { return nil }
        return stripped.data(using: .utf8) ?? data
    }

    /// Cap the pending-output buffer. A program flooding stdout faster than SwiftTerm
    /// renders (yes, cat of a huge file, verbose loop) would otherwise grow outputBuffer
    /// without bound → jetsam SIGKILL on the memory-tight device. Past the cap we keep the
    /// most recent bytes (what the user actually sees) and drop the oldest.
    private let maxOutputBuffer = 4 * 1024 * 1024

    private func enqueueOutput(_ data: Data) {
        outputLock.lock()
        outputBuffer.append(data)
        if outputBuffer.count > maxOutputBuffer {
            outputBuffer.removeFirst(outputBuffer.count - maxOutputBuffer)
        }
        let schedule = !flushScheduled
        if schedule { flushScheduled = true }
        outputLock.unlock()
        guard schedule else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(8)) { [weak self] in
            self?.flushOutput()
        }
    }

    /// Main queue only.
    private func flushOutput() {
        outputLock.lock()
        let data = outputBuffer
        outputBuffer = Data()
        flushScheduled = false
        outputLock.unlock()
        if !data.isEmpty { onOutput?(data) }
    }

    private func applyEnvironment(resourceRoot: String, home: String, workspace: String,
                                  columns: Int, rows: Int, extraEnv: [String: String]) {
        var env: [String: String] = [
            "HOME": home,
            "CLAUDE_CONFIG_DIR": (home as NSString).appendingPathComponent(".claude"),
            "TMPDIR": NSTemporaryDirectory(),
            "PWD": workspace,
            "TERM": "xterm-256color",
            "FORCE_COLOR": "3",
            "COLUMNS": String(columns),
            "LINES": String(rows),
            "TZ": TimeZone.current.identifier,
            "LANG": "en_US.UTF-8",
            // Shims
            "CLAUDE_IOS_TTY": "1",
            "CLAUDE_IOS_SESSION": "1",
            "CLAUDE_IOS_CONTROL": "1",
            "CLAUDE_IOS_CONTROL_FD": String(controlPipe.fileHandleForReading.fileDescriptor),
            "CLAUDE_IOS_COLUMNS": String(columns),
            "CLAUDE_IOS_ROWS": String(rows),
            // Claude Code behavior on-device
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "DISABLE_ERROR_REPORTING": "1",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "USE_BUILTIN_RIPGREP": "0",
            "LSHELL_BASH_DEBUG": "1",   // dev: dump Bash-tool scripts to ~/lshell-bash-debug.log
            "SHELL": "/bin/bash",
            "PATH": "/bin:/usr/bin:/usr/local/bin",
            "NODE_PATH": (resourceRoot as NSString).appendingPathComponent("node_modules"),
        ]
        // CPython (lshell_py N-API bridge): PYTHONHOME + stdlib/lib-dynload search
        // paths. Resources/python is a sibling folder-ref of nodejs in the app
        // bundle, so it sits at <bundle>/python (resourceRoot = <bundle>/nodejs).
        let pyHome = ((resourceRoot as NSString).deletingLastPathComponent as NSString).appendingPathComponent("python")
        env["LSHELL_PYTHON_HOME"] = pyHome
        env["LSHELL_PY_STDLIB"] = (pyHome as NSString).appendingPathComponent("lib/python3.13")
        env["LSHELL_PY_DYNLOAD"] = (pyHome as NSString).appendingPathComponent("lib/python3.13/lib-dynload")
        // pip3 installs here and python3 prepends it to sys.path — same dir on both
        // sides (must be container-writable; the bundled PYTHONHOME is read-only).
        env["LSHELL_PY_SITE"] = (home as NSString).appendingPathComponent(".lshell/python/site-packages")
        for (k, v) in extraEnv { env[k] = v }
        for (k, v) in env { setenv(k, v, 1) }
    }

    private func launchNode(argv: [String]) {
        let thread = Thread { [weak self] in
            // Register the CPython N-API bridge as a LINKED binding BEFORE node
            // initializes. Node 18's NAPI_MODULE is symbol-based (dlopen-only), so a
            // statically-linked module must self-register via napi_module_register
            // here; then process._linkedBinding('lshell_py') resolves it. Calling the
            // C symbol from Swift also anchors the bridge against dead-strip.
            lshell_register_python()
            Log.line("node thread running; calling node_start(\(argv.joined(separator: " ")))")
            // Build a C argv (NULL-terminated).
            var cargs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
            cargs.append(nil)
            let code = cargs.withUnsafeMutableBufferPointer { buf -> Int32 in
                return node_start(Int32(argv.count), buf.baseAddress)
            }
            for p in cargs where p != nil { free(p) }
            Log.line("‼️ node_start RETURNED code=\(code) (runtime died — cannot restart in-process)")
            // The JS session loop keeps Node alive across cli.js exits, so reaching
            // here means the runtime itself died. It can never restart in-process.
            DispatchQueue.main.async {
                guard let self else { return }
                self.stateLock.lock()
                self.sessionAlive = false
                self.stateLock.unlock()
                // Do NOT reset `started` to false. nodejs-mobile cannot re-init V8/libuv
                // in-process, so a later start() calling node_start() a SECOND time would
                // crash. Leaving started latched true keeps start()'s `guard !started`
                // permanently closed; recovery is a full app restart (onSessionEnd guides it).
                UIApplication.shared.isIdleTimerDisabled = false
                self.flushOutput()
                self.onSessionEnd?()
            }
        }
        // 16MB native + V8 --stack-size=864KB → ~18x headroom, so a genuinely deep JS
        // path throws a catchable RangeError long before the native guard page. jitless
        // burns more native stack per JS frame; the stack is reserved-not-resident (no
        // jetsam concern) and trivial on an 8GB device. NEVER set --stack-size (KB) >= this.
        thread.stackSize = 16 * 1024 * 1024 // >= 2MB required; 16MB for jitless headroom
        thread.qualityOfService = .userInteractive
        thread.name = "node-main"
        thread.start()
    }
}
