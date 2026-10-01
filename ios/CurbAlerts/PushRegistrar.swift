import Foundation
import UIKit

/// Hands this phone's Apple push token to the server, so the server can reach the phone with news it
/// could not have scheduled in advance - a snow emergency, declared hours before it bites.
///
/// Sweep reminders do not use this and must not start to. Their dates are known weeks ahead, so
/// `ReminderScheduler` puts them on the phone as local notifications, which fire with no connection
/// and no server at all. Push is the channel for what the phone cannot know yet.
///
/// With the token goes the list of curbs this phone has reminders on, the parked pin's curb included,
/// by id and never by coordinates. That is what lets the server send an alert about a street only to
/// the phones watching a curb on it, rather than to everyone.
///
/// Registering never asks the driver anything: the token is issued whether or not notifications are
/// allowed, and the permission the page already asks for is what lets an alert show.
@MainActor
final class PushRegistrar {
    static let shared = PushRegistrar()

    /// The same server the page talks to (`HOSTED_APP_ORIGIN` in `public/app.js`).
    static let apiOrigin = URL(string: "https://www.curbalerts.co")!

    // Debug builds from Xcode are signed for Apple's sandbox and get sandbox tokens; TestFlight and
    // App Store builds get production ones. A token sent to the wrong host is refused outright.
    #if DEBUG
    static let environment = "sandbox"
    #else
    static let environment = "production"
    #endif

    private enum Keys {
        static let token = "push.registeredToken"
        static let signedIn = "push.registeredSignedIn"
        static let registeredAt = "push.registeredAt"
        static let registeredCurbs = "push.registeredCurbIds"
        static let watchedCurbs = "push.watchedCurbIds"
        static let registeredAccess = "push.registeredAccess"
    }

    /// Re-sent weekly even when nothing changed, so the server's copy of a quiet phone stays fresh.
    private static let refreshInterval: TimeInterval = 7 * 24 * 60 * 60

    private let defaults = UserDefaults.standard
    private var currentToken: String?
    private var uploading = false
    // A change that arrives while an upload is in flight is sent straight after it, rather than
    // waiting for the next launch with the server holding the old list.
    private var uploadAgain = false

    func register() {
        UIApplication.shared.registerForRemoteNotifications()
    }

    func didRegister(deviceToken: Data) {
        currentToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await upload(force: false) }
    }

    /// Signing in or out changes which account the phone belongs to, so the server hears about it
    /// straight away rather than at the next weekly refresh.
    func sessionChanged() {
        Task { await upload(force: true) }
    }

    /// The subscription started, lapsed or moved: the server decides who hears a snow alert from what
    /// it was last told, so it is told straight away.
    func accessChanged() {
        Task { await upload(force: false) }
    }

    /// Called with every schedule the page hands over. Kept on the phone as well, so a launch that
    /// registers before the page has rendered still sends the last known list rather than none.
    func updateWatchedCurbs(_ curbIds: [String]) {
        let sorted = Array(Set(curbIds)).sorted()
        guard sorted != watchedCurbIds else { return }
        defaults.set(sorted, forKey: Keys.watchedCurbs)
        Task { await upload(force: false) }
    }

    private var watchedCurbIds: [String] {
        defaults.stringArray(forKey: Keys.watchedCurbs) ?? []
    }

    private func upload(force: Bool) async {
        guard let token = currentToken else { return }
        if uploading {
            uploadAgain = true
            return
        }

        let previousToken = defaults.string(forKey: Keys.token)
        let sessionToken = SessionKeychain.read()
        let signedIn = sessionToken != nil
        let registeredAt = defaults.object(forKey: Keys.registeredAt) as? Date ?? .distantPast
        let curbIds = watchedCurbIds
        let access = ReminderStore().access.pushValue
        let accessKey = Self.signature(of: access)
        let unchanged = previousToken == token
            && defaults.bool(forKey: Keys.signedIn) == signedIn
            && defaults.stringArray(forKey: Keys.registeredCurbs) == curbIds
            && defaults.string(forKey: Keys.registeredAccess) == accessKey
            && Date().timeIntervalSince(registeredAt) < Self.refreshInterval
        if unchanged && !force { return }

        uploading = true
        defer {
            uploading = false
            if uploadAgain {
                uploadAgain = false
                Task { await upload(force: false) }
            }
        }

        var request = URLRequest(url: Self.apiOrigin.appending(path: "api/push/apns"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let sessionToken {
            request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        }
        let info = Bundle.main.infoDictionary
        let version = "\(info?["CFBundleShortVersionString"] as? String ?? "") (\(info?["CFBundleVersion"] as? String ?? ""))"
        var body: [String: Any] = [
            "token": token,
            "environment": Self.environment,
            "appVersion": version,
            "watchedCurbIds": curbIds
        ]
        if let access {
            body["reminderAccess"] = access
        }
        if let previousToken, previousToken != token {
            body["previousToken"] = previousToken
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        // A failure is left unrecorded, so the next foreground tries again.
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let status = (response as? HTTPURLResponse)?.statusCode,
              (200..<300).contains(status) else { return }

        defaults.set(token, forKey: Keys.token)
        defaults.set(signedIn, forKey: Keys.signedIn)
        defaults.set(curbIds, forKey: Keys.registeredCurbs)
        defaults.set(accessKey, forKey: Keys.registeredAccess)
        defaults.set(Date(), forKey: Keys.registeredAt)
    }

    private static func signature(of access: [String: Any]?) -> String {
        guard let access else { return "unknown" }
        return "\(access["entitled"] ?? "")|\(access["endsAt"] ?? "")"
    }
}
