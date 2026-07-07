import Combine
import Foundation

final class ClaudeProfileStore: ObservableObject {
    @Published private(set) var profiles: [ClaudeProfile] = []

    static var storePath: String {
        (FileManager.applicationSupportPath as NSString).appendingPathComponent("containers.json")
    }

    private static var legacyStorePath: String {
        (FileManager.applicationSupportPath as NSString).appendingPathComponent("claude-profiles.json")
    }

    init() {
        load()
    }

    var activeProfile: ClaudeProfile? {
        profiles.first(where: { $0.isActive }) ?? profiles.first
    }

    func bootstrap() {
        ensureStoreDirectory()
        migrateLegacyCredential()
        persist()
    }

    func save(profile: ClaudeProfile) {
        var normalized = profile.normalized()
        var next = profiles
        if normalized.isActive {
            next = next.map { existing in
                var copy = existing
                copy.isActive = existing.id == normalized.id
                return copy
            }
        } else if profiles.isEmpty || !profiles.contains(where: { $0.isActive }) {
            normalized.isActive = true
        }

        if let index = next.firstIndex(where: { $0.id == normalized.id }) {
            next[index] = normalized
        } else {
            next.append(normalized)
        }
        profiles = normalizedProfiles(next)
        persist()
    }

    func delete(_ id: String) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        let wasActive = profiles.first(where: { $0.id == id })?.isActive == true
        profiles.removeAll { $0.id == id }
        KeychainStore.deleteCredential(for: id)
        if wasActive, profiles.indices.contains(0) {
            profiles[0].isActive = true
        }
        persist()
    }

    func setActive(_ id: String) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        profiles = profiles.map { profile in
            var copy = profile
            copy.isActive = profile.id == id
            return copy
        }
        persist()
    }

    func profile(id: String) -> ClaudeProfile? {
        profiles.first(where: { $0.id == id })
    }

    func hasCredential(for profileID: String) -> Bool {
        guard let profile = profiles.first(where: { $0.id == profileID }) else { return false }
        return !profile.credential.isEmpty
    }

    func makeLaunchConfig(for profile: ClaudeProfile,
                          launchMode: TerminalLaunchMode = .shell) throws -> ClaudeLaunchConfig {
        let current = profiles.first(where: { $0.id == profile.id }) ?? profile
        return try ClaudeSettingsWriter.makeLaunchConfig(profile: current,
                                                         launchMode: launchMode,
                                                         home: homePath(for: current),
                                                         workspace: workspacePath(for: current))
    }

    func homePath(for profile: ClaudeProfile) -> String {
        (containerPath(for: profile) as NSString).appendingPathComponent("home")
    }

    func workspacePath(for profile: ClaudeProfile) -> String {
        (containerPath(for: profile) as NSString).appendingPathComponent("workspace")
    }

    func settingsPath(for profile: ClaudeProfile) -> String {
        (homePath(for: profile) as NSString).appendingPathComponent(".claude/settings.json")
    }

    private func containerPath(for profile: ClaudeProfile) -> String {
        let containers = (FileManager.documentsPath as NSString).appendingPathComponent("containers")
        return (containers as NSString).appendingPathComponent(profile.id)
    }

    private func load() {
        ensureStoreDirectory()
        let currentURL = URL(fileURLWithPath: Self.storePath)
        let legacyURL = URL(fileURLWithPath: Self.legacyStorePath)
        let sourceURL = FileManager.default.fileExists(atPath: Self.storePath) ? currentURL : legacyURL
        guard let data = try? Data(contentsOf: sourceURL),
              let decoded = try? JSONDecoder().decode([ClaudeProfile].self, from: data) else {
            profiles = []
            return
        }
        profiles = normalizedProfiles(decoded.map(scrubBundledDefaults))
    }

    private func persist() {
        ensureStoreDirectory()
        let url = URL(fileURLWithPath: Self.storePath)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        if let data = try? encoder.encode(normalizedProfiles(profiles)) {
            try? data.write(to: url, options: .atomic)
        }
    }

    private func normalizedProfiles(_ input: [ClaudeProfile]) -> [ClaudeProfile] {
        var list = input.map { $0.normalized() }
        if list.isEmpty { return [] }
        if !list.contains(where: { $0.isActive }) {
            list[0].isActive = true
        }
        var activeSeen = false
        return list.map { profile in
            var copy = profile
            if copy.isActive {
                copy.isActive = !activeSeen
                activeSeen = true
            }
            return copy
        }
    }

    private func ensureStoreDirectory() {
        try? FileManager.default.createDirectory(atPath: FileManager.applicationSupportPath,
                                                 withIntermediateDirectories: true)
    }

    private func migrateLegacyCredential() {
        guard let active = activeProfile else { return }
        let defaults = UserDefaults.standard
        var legacyCredential = defaults.string(forKey: "credential") ?? ""
        if legacyCredential.isEmpty {
            legacyCredential = KeychainStore.loadLegacyCredential()
        }
        if legacyCredential.isEmpty {
            legacyCredential = KeychainStore.loadCredential(for: active.id)
        }
        guard !legacyCredential.isEmpty,
              active.credential.isEmpty else { return }

        if let index = profiles.firstIndex(where: { $0.id == active.id }) {
            profiles[index].credential = legacyCredential
        }
        KeychainStore.deleteCredential(for: active.id)
        KeychainStore.deleteLegacyCredential()
        defaults.removeObject(forKey: "credential")

        if defaults.bool(forKey: "credentialIsOAuth"),
           let index = profiles.firstIndex(where: { $0.id == active.id }) {
            profiles[index].authMode = .oauthToken
            persist()
        }
    }

    private func scrubBundledDefaults(_ profile: ClaudeProfile) -> ClaudeProfile {
        var copy = profile
        let wasOldDefault = copy.id == "default-claude"
        if wasOldDefault {
            copy.name = AppStrings.untitledContainer
            copy.baseURL = ""
            copy.mainModel = ""
            copy.opusModel = ""
            copy.fastModel = ""
        }
        return copy
    }
}
