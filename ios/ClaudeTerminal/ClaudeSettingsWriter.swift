import Foundation

struct ClaudeLaunchConfig: Identifiable, Equatable, Hashable {
    let id: String
    let profileID: String
    let profileName: String
    let home: String
    let workspace: String
    let extraEnv: [String: String]

    static func == (lhs: ClaudeLaunchConfig, rhs: ClaudeLaunchConfig) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

enum TerminalLaunchMode: Equatable, Hashable {
    case shell
    case claudeDefault
    case claudeBypassPermissions
    case debugNodeTest   // dev-only: self-test the in-process node executor at boot

    var startupCommand: String? {
        switch self {
        case .shell:
            return nil
        case .claudeDefault:
            return "claude"
        case .claudeBypassPermissions:
            return "claude --permission-mode bypassPermissions"
        case .debugNodeTest:
            return "echo NODETEST_START; node -e 'console.log(\"NODE_OK\", 6*7)'; node --version; "
                 + "node -e 'while(true){}'; echo \"LOOP_EXIT=$?\"; "
                 + "node -e 'setTimeout(()=>console.log(\"ASYNC_OK\"),20)'; echo NODETEST_DONE"
        }
    }

    /// Stable string for persisting a pending switch across an app restart.
    var storageKey: String {
        switch self {
        case .shell: return "shell"
        case .claudeDefault: return "claudeDefault"
        case .claudeBypassPermissions: return "claudeBypassPermissions"
        case .debugNodeTest: return "debugNodeTest"
        }
    }
    init?(storageKey: String) {
        switch storageKey {
        case "shell": self = .shell
        case "claudeDefault": self = .claudeDefault
        case "claudeBypassPermissions": self = .claudeBypassPermissions
        case "debugNodeTest": self = .debugNodeTest
        default: return nil
        }
    }
}

/// Switching containers means booting Node with a different HOME/workspace, but
/// nodejs-mobile cannot restart Node in-process. The user-approved behavior is a full
/// app restart for guaranteed isolation: persist the target container + launch mode,
/// exit(0), and on next launch ContentView reads this and navigates straight into the
/// new container's terminal — a completely fresh process, no cross-container leakage.
enum PendingContainerSwitch {
    private static let key = "lshell.pendingContainerSwitch"

    /// Persist the target and terminate the process. The next launch resumes into it.
    static func stashAndRestart(containerID: String, mode: TerminalLaunchMode) {
        UserDefaults.standard.set(["containerID": containerID, "mode": mode.storageKey], forKey: key)
        UserDefaults.standard.synchronize()
        exit(0)
    }

    /// Read and clear a pending switch (nil if none).
    static func take() -> (containerID: String, mode: TerminalLaunchMode)? {
        let d = UserDefaults.standard
        guard let dict = d.dictionary(forKey: key),
              let cid = dict["containerID"] as? String,
              let modeKey = dict["mode"] as? String,
              let mode = TerminalLaunchMode(storageKey: modeKey) else { return nil }
        d.removeObject(forKey: key)
        return (cid, mode)
    }
}

enum ClaudeSettingsWriter {
    static func makeLaunchConfig(profile: ClaudeProfile,
                                 launchMode: TerminalLaunchMode = .shell,
                                 home: String,
                                 workspace: String) throws -> ClaudeLaunchConfig {
        try prepareDirectories(home: home, workspace: workspace)
        var env = environment(for: profile, includeSecret: true)
        if let startupCommand = launchMode.startupCommand {
            env["LSHELL_START_COMMAND"] = startupCommand
        }
        let settingsEnv = environment(for: profile, includeSecret: true)
        try writeSettings(env: settingsEnv, home: home)
        return ClaudeLaunchConfig(id: UUID().uuidString,
                                  profileID: profile.id,
                                  profileName: profile.displayName,
                                  home: home,
                                  workspace: workspace,
                                  extraEnv: env)
    }

    static func environment(for profile: ClaudeProfile,
                            includeSecret: Bool) -> [String: String] {
        var env: [String: String] = [
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "HTTPS_PROXY": profile.proxyURL,
            "HTTP_PROXY": profile.proxyURL,
            "NO_PROXY": "localhost,127.0.0.1"
        ]

        // Official login: leave endpoint / key / models unset so `claude` runs its own
        // OAuth sign-in (stored in ~/.claude/.credentials.json). Only the proxy and the
        // non-essential-traffic flag ride along.
        guard profile.loginMode == .thirdParty else { return env }

        if !profile.baseURL.isEmpty {
            env["ANTHROPIC_BASE_URL"] = profile.baseURL
        }
        if !profile.mainModel.isEmpty {
            env["ANTHROPIC_MODEL"] = profile.mainModel
            env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = profile.mainModel
        }
        if !profile.opusModel.isEmpty {
            env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = profile.opusModel
        }
        if !profile.fastModel.isEmpty {
            env["ANTHROPIC_SMALL_FAST_MODEL"] = profile.fastModel
            env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = profile.fastModel
        }

        switch profile.authMode {
        case .apiKey:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = ""
            env["ANTHROPIC_AUTH_TOKEN"] = ""
            if includeSecret && !profile.credential.isEmpty {
                env["ANTHROPIC_API_KEY"] = profile.credential
            }
        case .oauthToken:
            env["ANTHROPIC_API_KEY"] = ""
            env["ANTHROPIC_AUTH_TOKEN"] = ""
            if includeSecret && !profile.credential.isEmpty {
                env["CLAUDE_CODE_OAUTH_TOKEN"] = profile.credential
            }
        }

        return env
    }

    private static func prepareDirectories(home: String, workspace: String) throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: home, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: workspace, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: (home as NSString).appendingPathComponent(".claude"),
                               withIntermediateDirectories: true)
    }

    private static func writeSettings(env: [String: String], home: String) throws {
        let settingsPath = (home as NSString).appendingPathComponent(".claude/settings.json")
        let data = try JSONSerialization.data(withJSONObject: ["env": env],
                                              options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: settingsPath), options: .atomic)
    }
}
