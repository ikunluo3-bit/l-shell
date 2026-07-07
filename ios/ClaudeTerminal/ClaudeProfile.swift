import Foundation

enum ClaudeAuthMode: String, Codable, CaseIterable, Identifiable {
    case apiKey
    case oauthToken

    var id: String { rawValue }

    var title: String {
        switch self {
        case .apiKey: return AppStrings.apiKey
        case .oauthToken: return AppStrings.oauth
        }
    }

    var placeholder: String {
        switch self {
        case .apiKey: return "sk-ant-api03-..."
        case .oauthToken: return "sk-ant-oat01-..."
        }
    }
}

enum ClaudeProxyMode: String, Codable, CaseIterable, Identifiable {
    case direct
    case custom

    static var allCases: [ClaudeProxyMode] { [.direct, .custom] }

    var id: String { rawValue }

    var title: String {
        switch self {
        case .direct: return AppStrings.direct
        case .custom: return AppStrings.customProxy
        }
    }
}

/// Official = empty config, sign in with `claude` from the terminal (OAuth).
/// Third-party = fill endpoint / key / models for an API or relay gateway.
enum ClaudeLoginMode: String, Codable, CaseIterable, Identifiable {
    case official
    case thirdParty

    var id: String { rawValue }

    var title: String {
        switch self {
        case .official: return AppStrings.officialLogin
        case .thirdParty: return AppStrings.thirdPartyAPI
        }
    }
}

struct ClaudeProfile: Codable, Identifiable, Equatable, Hashable {
    var id: String
    var name: String
    var loginMode: ClaudeLoginMode
    var baseURL: String
    var credential: String
    var mainModel: String
    var opusModel: String
    var fastModel: String
    var authMode: ClaudeAuthMode
    var proxyMode: ClaudeProxyMode
    var proxyEndpoint: String
    var plaintextSettingsEnabled: Bool
    var workspaceName: String
    var isActive: Bool
    /// True once the user has saved this container's Claude config at least once. Lets the
    /// tool picker skip the config page and go straight to the dashboard on later visits.
    var claudeConfigured: Bool

    var baseURLDisplay: String {
        baseURL.isEmpty ? AppStrings.endpointNotSet : baseURL
    }

    /// Whether Claude is set up enough to jump past the config gate. Explicit flag, OR a
    /// legacy third-party container that already carries an endpoint (predates the flag).
    var isClaudeConfigured: Bool {
        claudeConfigured || (loginMode == .thirdParty && !baseURL.isEmpty)
    }

    var displayName: String {
        name.isEmpty ? AppStrings.untitledContainer : name
    }

    var proxyURL: String {
        proxyMode == .direct ? "" : Self.normalizedProxyURL(proxyEndpoint)
    }

    var proxyDisplay: String {
        switch proxyMode {
        case .direct:
            return AppStrings.direct
        case .custom:
            let url = proxyURL
            return url.isEmpty ? AppStrings.proxyNotSet : url
        }
    }

    init(id: String,
         name: String,
         loginMode: ClaudeLoginMode = .official,
         baseURL: String,
         credential: String = "",
         mainModel: String,
         opusModel: String,
         fastModel: String,
         authMode: ClaudeAuthMode,
         proxyMode: ClaudeProxyMode,
         proxyEndpoint: String = "",
         plaintextSettingsEnabled: Bool,
         workspaceName: String,
         isActive: Bool,
         claudeConfigured: Bool = false) {
        self.id = id
        self.name = name
        self.loginMode = loginMode
        self.baseURL = baseURL
        self.credential = credential
        self.mainModel = mainModel
        self.opusModel = opusModel
        self.fastModel = fastModel
        self.authMode = authMode
        self.proxyMode = proxyMode
        self.proxyEndpoint = proxyEndpoint
        self.plaintextSettingsEnabled = plaintextSettingsEnabled
        self.workspaceName = workspaceName
        self.isActive = isActive
        self.claudeConfigured = claudeConfigured
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, loginMode, baseURL, credential, mainModel, opusModel, fastModel
        case authMode, proxyMode, proxyEndpoint, plaintextSettingsEnabled, workspaceName, isActive
        case claudeConfigured
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        baseURL = try values.decode(String.self, forKey: .baseURL)
        credential = try values.decodeIfPresent(String.self, forKey: .credential) ?? ""
        mainModel = try values.decode(String.self, forKey: .mainModel)
        opusModel = try values.decodeIfPresent(String.self, forKey: .opusModel) ?? mainModel
        fastModel = try values.decode(String.self, forKey: .fastModel)
        authMode = try values.decode(ClaudeAuthMode.self, forKey: .authMode)
        let rawProxyMode = try values.decodeIfPresent(String.self, forKey: .proxyMode) ?? ClaudeProxyMode.direct.rawValue
        proxyMode = ClaudeProxyMode(rawValue: rawProxyMode) ?? .custom
        proxyEndpoint = try values.decodeIfPresent(String.self, forKey: .proxyEndpoint) ?? ""
        plaintextSettingsEnabled = try values.decodeIfPresent(Bool.self, forKey: .plaintextSettingsEnabled) ?? true
        workspaceName = try values.decode(String.self, forKey: .workspaceName)
        isActive = try values.decode(Bool.self, forKey: .isActive)
        claudeConfigured = try values.decodeIfPresent(Bool.self, forKey: .claudeConfigured) ?? false
        if let raw = try values.decodeIfPresent(String.self, forKey: .loginMode),
           let mode = ClaudeLoginMode(rawValue: raw) {
            loginMode = mode
        } else {
            // Migration: older profiles infer official vs third-party from their config.
            loginMode = (!baseURL.isEmpty || !credential.isEmpty) ? .thirdParty : .official
        }
    }

    static func defaultProfile() -> ClaudeProfile {
        return ClaudeProfile(
            id: UUID().uuidString.lowercased(),
            name: AppStrings.untitledContainer,
            loginMode: .official,
            baseURL: "",
            credential: "",
            mainModel: "",
            opusModel: "",
            fastModel: "",
            authMode: .apiKey,
            proxyMode: .direct,
            proxyEndpoint: "",
            plaintextSettingsEnabled: true,
            workspaceName: "workspace",
            isActive: true
        )
    }

    static func newProfile() -> ClaudeProfile {
        var profile = defaultProfile()
        profile.id = UUID().uuidString.lowercased()
        profile.name = ""
        profile.isActive = false
        return profile
    }

    func normalized() -> ClaudeProfile {
        var copy = self
        copy.name = copy.name.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.baseURL = copy.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.credential = copy.credential.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.mainModel = copy.mainModel.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.opusModel = copy.opusModel.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.fastModel = copy.fastModel.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.proxyEndpoint = Self.normalizedProxyURL(copy.proxyEndpoint)
        copy.workspaceName = copy.workspaceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if copy.name.isEmpty { copy.name = AppStrings.untitledContainer }
        if copy.workspaceName.isEmpty { copy.workspaceName = "workspace" }
        if copy.proxyMode == .direct { copy.proxyEndpoint = "" }
        copy.plaintextSettingsEnabled = true
        return copy
    }

    static func normalizedProxyURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let lowercased = trimmed.lowercased()
        if lowercased.hasPrefix("http://") ||
            lowercased.hasPrefix("https://") ||
            lowercased.hasPrefix("socks4://") ||
            lowercased.hasPrefix("socks5://") {
            return trimmed
        }
        if trimmed.allSatisfy({ $0.isNumber }) {
            return "http://127.0.0.1:\(trimmed)"
        }
        return "http://\(trimmed)"
    }
}
