import Foundation
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
                await SubscriptionActions.open(action)
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
}
