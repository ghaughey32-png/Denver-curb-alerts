import Foundation
import Security

/// The account session token, kept in the keychain.
///
/// The page cannot use the session cookie from inside the app, so it signs in with a bearer token
/// instead and needs somewhere to keep it across launches. The keychain is the only honest place
/// for a 30-day credential on a device; localStorage would put it where the page's own storage and
/// any script it loads can read it. See "Sessions travel as a cookie or a bearer token" in AGENTS.md.
enum SessionKeychain {
    private static let service = "co.curbalerts.app.session"
    private static let account = "session-token"

    struct KeychainError: LocalizedError {
        let status: OSStatus

        var errorDescription: String? {
            "Your sign-in could not be saved on this phone (keychain error \(status))."
        }
    }

    static func read() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty else { return nil }
        return token
    }

    static func write(_ token: String) throws {
        let data = Data(token.utf8)
        let updateStatus = SecItemUpdate(baseQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)

        if updateStatus == errSecItemNotFound {
            var item = baseQuery()
            item[kSecValueData as String] = data
            // ThisDeviceOnly: a session belongs to this phone. Restoring a backup onto a new phone
            // should mean signing in again there, not quietly carrying a live credential across.
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError(status: addStatus) }
        } else if updateStatus != errSecSuccess {
            throw KeychainError(status: updateStatus)
        }
    }

    static func delete() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
