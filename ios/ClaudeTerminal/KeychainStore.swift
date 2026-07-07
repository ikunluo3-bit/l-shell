import Foundation
import Security

/// Generic-password wrapper for Claude profile credentials. Secrets stay in the
/// Keychain unless an individual profile explicitly opts into plaintext settings.
enum KeychainStore {
    private static let service = "ClaudeTerminal"
    private static let legacyAccount = "credential"

    private static func account(for profileID: String) -> String {
        "claude.profile.\(profileID).credential"
    }

    private static func baseQuery(account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    static func loadCredential(for profileID: String) -> String {
        load(account: account(for: profileID))
    }

    @discardableResult
    static func saveCredential(_ value: String, for profileID: String) -> Bool {
        save(value, account: account(for: profileID))
    }

    @discardableResult
    static func deleteCredential(for profileID: String) -> Bool {
        delete(account: account(for: profileID))
    }

    static func loadLegacyCredential() -> String {
        load(account: legacyAccount)
    }

    @discardableResult
    static func deleteLegacyCredential() -> Bool {
        delete(account: legacyAccount)
    }

    private static func load(account: String) -> String {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }

    @discardableResult
    private static func save(_ value: String, account: String) -> Bool {
        if value.isEmpty { return delete(account: account) }
        let attrs: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let query = baseQuery(account: account)
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            let add = query.merging(attrs) { _, new in new }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    @discardableResult
    private static func delete(account: String) -> Bool {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
