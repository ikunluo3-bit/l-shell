import SwiftUI
import SwiftTerm
import UIKit

/// Owns the ONE persistent terminal emulator for the app's lifetime.
///
/// The embedded Node runtime is a single instance that can never restart in-process
/// (nodejs-mobile), so there is exactly one terminal session. Keeping the TerminalView
/// (and its scrollback) here — instead of recreating it inside a SwiftUI
/// UIViewRepresentable every time the terminal screen appears — means navigating away
/// and back preserves the running session and history (task 8). The Node→emulator
/// output binding is wired once here, not per view.
final class TerminalSession: ObservableObject {
    static let shared = TerminalSession()

    /// Non-nil while a terminal session is live (Node started). Drives the
    /// "terminal session" controls in the container menu.
    @Published private(set) var runningContainerID: String?
    @Published private(set) var runningContainerName: String?
    /// The config the live session was booted with. Lets other screens (the container
    /// home's "running" strip, "接管") re-open the terminal without rebuilding a config.
    @Published private(set) var currentConfig: ClaudeLaunchConfig?
    /// Best-effort record of the command believed to be foreground (nil = a bare shell
    /// prompt). Lets a re-launch skip a needless restart when claude is already up in the
    /// same mode, while still typing the command when the session is at a shell.
    @Published private(set) var currentForeground: String?
    /// Whether the software keyboard is currently shown — drives the header toggle's icon.
    @Published private(set) var isKeyboardVisible = false

    /// The SwiftTerm emulator view — created LAZILY on first access (when the terminal
    /// screen appears), NOT at app launch. Eagerly building this heavy UIKit view during
    /// SwiftUI's first render (the container list observes this singleton) tripped an
    /// AttributeGraph cycle that terminated the app at launch on iOS 27 devices. Deferring
    /// it keeps launch to pure SwiftUI; merely observing the session no longer creates it.
    private lazy var _terminalView: TerminalView = {
        let tv = TerminalView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        tv.backgroundColor = .black
        tv.getTerminal().silentLog = true
        tv.terminalDelegate = coordinator
        // Suppress SwiftTerm's default cramped accessory bar; the keys live in a
        // persistent SwiftUI toolbar (TerminalKeyBar) that is always fully visible.
        tv.inputAccessoryView = UIView(frame: .zero)
        return tv
    }()
    var terminalView: TerminalView { _terminalView }

    private let coordinator = Coordinator()
    private var booted = false
    private var pendingConfig: (config: ClaudeLaunchConfig, resourceRoot: String)?

    private init() {
        coordinator.session = self

        // Node output → emulator. The closure captures `self`, not the view, so binding
        // it here does NOT force the lazy terminalView into existence; it is resolved on
        // the first byte — by which point the terminal screen has already created it.
        NodeRunner.shared.onOutput = { [weak self] data in
            self?.terminalView.feed(byteArray: [UInt8](data)[...])
        }
        NodeRunner.shared.onSessionEnd = { [weak self] in
            guard let self else { return }
            let msg = "\r\n\u{001B}[2m\(AppStrings.sessionEndedRelaunch)\u{001B}[0m\r\n"
            self.terminalView.feed(text: msg)
            self.booted = false
            self.runningContainerID = nil
            self.runningContainerName = nil
            self.currentConfig = nil
            self.currentForeground = nil
        }

        // Track real keyboard visibility so the header toggle shows the right icon,
        // no matter how the keyboard was shown or dismissed. Singleton — never removed.
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] _ in
            self?.isKeyboardVisible = true
        }
        nc.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] _ in
            self?.isKeyboardVisible = false
        }
    }

    // MARK: lifecycle

    /// Records the config to boot with once the first real size is known. No-op if a
    /// session is already running (single Node instance — the first container wins).
    func prepare(config: ClaudeLaunchConfig, resourceRoot: String) {
        guard !booted else { return }
        pendingConfig = (config, resourceRoot)
    }

    /// Called by the coordinator on every size report. First valid size boots Node
    /// (once); later ones just resize. Keeps boot out of view `makeUIView` so it runs
    /// with a real terminal geometry.
    fileprivate func handleSize(cols: Int, rows: Int) {
        guard cols > 0, rows > 0 else { return }
        if booted {
            NodeRunner.shared.resize(columns: cols, rows: rows)
            return
        }
        guard let pending = pendingConfig else { return }
        booted = true
        pendingConfig = nil
        runningContainerID = pending.config.profileID
        runningContainerName = pending.config.profileName
        currentConfig = pending.config
        // A non-empty start command means Node boots straight into that program.
        currentForeground = pending.config.extraEnv["LSHELL_START_COMMAND"]
        // Debug isolation: show the SwiftTerm view WITHOUT booting Node, to separate a
        // SwiftTerm-on-device crash from a NodeMobile-start crash.
        if ProcessInfo.processInfo.environment["LSHELL_SKIP_NODE"] == "1" {
            terminalView.feed(text: "[LSHELL_SKIP_NODE: terminal shown, Node not started]\r\n")
            return
        }
        NodeRunner.shared.start(resourceRoot: pending.resourceRoot,
                                home: pending.config.home,
                                workspace: pending.config.workspace,
                                columns: cols, rows: rows,
                                extraEnv: pending.config.extraEnv)
    }

    var isRunning: Bool { runningContainerID != nil }

    /// True when a DIFFERENT container's Node session is already live. Switching to
    /// `containerID` would require terminating it — nodejs-mobile can't reboot Node
    /// in-process, so callers surface a confirm dialog and do a full app restart via
    /// PendingContainerSwitch (guarantees process-level container isolation).
    func conflicts(with containerID: String) -> Bool {
        isRunning && runningContainerID != containerID
    }

    /// Bring up the keyboard on demand (tap-to-focus / screen appear).
    /// Reliable even when a TUI has mouse reporting on and swallows taps.
    func focusKeyboard() {
        guard !terminalView.isFirstResponder else { return }
        _ = terminalView.becomeFirstResponder()
    }

    // MARK: persistent key bar actions

    /// Send a raw byte sequence to Node's stdin (Esc / Tab / arrows). Works whether or
    /// not the keyboard is up — the bytes go straight to the pipe, not through the view.
    func sendBytes(_ bytes: [UInt8]) { NodeRunner.shared.sendInput(Data(bytes)) }

    /// Arm SwiftTerm's control modifier so the next typed key is control-modified.
    func armControl() { terminalView.controlModifier = true }

    /// Explicit keyboard toggle for the key bar's ⌨ key. Reliable way to summon the
    /// software keyboard (real device) or dismiss it.
    func toggleKeyboard() {
        if terminalView.isFirstResponder { _ = terminalView.resignFirstResponder() }
        else { _ = terminalView.becomeFirstResponder() }
    }

    // MARK: unified launch (root-fix for "second launch does nothing")

    /// Make `command` the foreground program, whatever state the session is in.
    ///
    /// nodejs-mobile can boot only ONCE per process, so a launch mode baked into
    /// LSHELL_START_COMMAND only ever runs on that first boot. Every launch after that
    /// (session already up as a shell, already in claude, or just restarted) must instead
    /// type the command into the LIVE shell. This is the single path all "open terminal"
    /// actions funnel through, so a running/restarted session can never get stuck unable
    /// to start claude.
    ///
    /// Returns true if it handled the launch on the live session (caller then just
    /// navigates to the terminal); false if Node isn't booted yet (caller navigates with a
    /// config whose LSHELL_START_COMMAND boots it).
    @discardableResult
    func relaunchIfRunning(command: String?) -> Bool {
        guard booted else { return false }
        guard let command, !command.isEmpty else { return true } // plain shell: nothing to run
        // Already the foreground program in this exact mode → don't restart; just take over.
        if currentForeground == command { return true }
        // A DIFFERENT program is foreground → quit it via the known-good stdin path (double
        // Ctrl-C). Then enqueue the new command on the control fd: the shell runs it only
        // after the quit's launchProgram promise resolves, so the two never race.
        if currentForeground != nil {
            sendBytes([0x03])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                self?.sendBytes([0x03])
            }
        }
        currentForeground = command
        enqueueCommand(command)
        return true
    }

    /// Queue a shell command line out-of-band (control fd). Sequenced by shell.js's drain
    /// loop, so it can't collide with a program that still owns stdin.
    private func enqueueCommand(_ command: String) {
        let b64 = Data(command.utf8).base64EncodedString()
        NodeRunner.shared.sendControl("enqueue \(b64)")
    }

    // MARK: session controls (task 6-A, soft restart)

    /// Soft restart on the SAME Node: interrupt the foreground program (double Ctrl-C
    /// quits Claude Code), then drop to a clean, cleared shell prompt. Cannot change the
    /// container's env — that is baked at first boot; use "Restart App" for that.
    func restartSoft() {
        guard isRunning else { return }
        if currentForeground != nil {
            // A program is foreground → quit it with a double Ctrl-C. launchProgram's
            // finish() then resets the terminal and drops to a clean, cleared shell prompt.
            NodeRunner.shared.sendInput(Data([0x03]))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                NodeRunner.shared.sendInput(Data([0x03]))
            }
        } else {
            // Already at a shell → just clear for a clean slate (queued out-of-band).
            enqueueCommand("clear")
        }
        currentForeground = nil
    }

    // MARK: delegate

    private final class Coordinator: NSObject, TerminalViewDelegate {
        weak var session: TerminalSession?

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            NodeRunner.shared.sendInput(Data(data))
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            session?.handleSize(cols: newCols, rows: newRows)
        }

        func scrolled(source: TerminalView, position: Double) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let s = String(data: content, encoding: .utf8) { UIPasteboard.general.string = s }
        }
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func bell(source: TerminalView) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { UIApplication.shared.open(url) }
        }
    }
}
