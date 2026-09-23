import Foundation
import StoreKit
import UIKit
import UserNotifications

final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationCoordinator()

    // Without this a reminder that fires while the app is open is swallowed silently, and on a
    // sweep morning the app being open is not evidence that anyone has looked at it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        let sweepKeys = userInfo["sweepKeys"] as? [String] ?? []

        switch response.actionIdentifier {
        case ReminderScheduler.movedActionIdentifier:
            await LiveActivityScheduler.markMoved(sweepKeys: sweepKeys)
            await ReminderScheduler.shared.recordMoved(sweepKeys)
            await WebShell.shared.dispatch(["type": "sweep-moved", "sweepKeys": sweepKeys])
        case UNNotificationDefaultActionIdentifier:
            if let raw = userInfo["accessAction"] as? String, let action = AccessNoticePlanner.Action(rawValue: raw) {
                await open(action)
                return
            }
            // Opening a reminder is not confirmation. The page only moves that sweep to the front of
            // its banner, and the driver still has to say the car is moved.
            let url = userInfo["url"] as? String ?? "/"
            await WebShell.shared.dispatch(["type": "open-url", "url": url])
        default:
            break
        }
    }

    /// Where a reminders-are-stopping notice takes the driver: straight to the thing that fixes it.
    @MainActor
    private func open(_ action: AccessNoticePlanner.Action) async {
        switch action {
        case .billing:
            // Apple's own page for updating the payment method on the Apple ID.
            if let url = URL(string: "https://apps.apple.com/account/billing") {
                await UIApplication.shared.open(url)
            }
        case .manage:
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            if let scene {
                try? await AppStore.showManageSubscriptions(in: scene)
            }
        case .subscribe:
            // The paywall lives in the app. Until it is wired to a route of its own, the app opening
            // at all is the way there.
            WebShell.shared.dispatch(["type": "open-url", "url": "/"])
        }
    }
}
