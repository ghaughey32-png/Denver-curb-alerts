import SwiftUI
import UserNotifications

@main
struct CurbAlertsApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WebShellView()
                .background(Color(red: 0.957, green: 0.937, blue: 0.902))
                .task { await WebShell.shared.loadIfNeeded() }
                // A tap on the home-screen widget. Like opening a reminder, this only focuses the
                // sweep in the page's banner; the driver still says the car is moved.
                .onOpenURL { url in
                    guard url.scheme == SweepWidgetLink.scheme, url.host == SweepWidgetLink.host else { return }
                    WebShell.shared.dispatch(["type": "open-url", "url": SweepWidgetLink.pagePath(from: url)])
                }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active:
                // Opening the app is the moment the rolling window moves forward. The page will hand
                // over a fresh job list too once it renders, but this refill does not wait on it.
                Task {
                    // A renewal, a lapse or a refund can all happen while the app is closed.
                    await SubscriptionManager.shared.refresh()
                    try? await ReminderScheduler.shared.reschedule()
                    await WebShell.shared.refreshPermission()
                }
            case .background:
                ReminderScheduler.submitBackgroundRefresh()
            default:
                break
            }
        }
        // iOS keeps only 64 pending local notifications, so only the next three weeks are ever on
        // the device. This is what tops that window up for someone who does not open the app.
        .backgroundTask(.appRefresh(ReminderScheduler.refreshTaskIdentifier)) {
            await SubscriptionManager.shared.refresh()
            try? await ReminderScheduler.shared.reschedule()
            ReminderScheduler.submitBackgroundRefresh()
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // Both have to be in place before launch finishes, or a tap on a reminder that cold-launches
        // the app - including the "I moved my car" button - is delivered to nobody.
        UNUserNotificationCenter.current().delegate = NotificationCoordinator.shared
        ReminderScheduler.registerCategories()
        ReminderStore.migrateFromStandardDefaultsIfNeeded()
        // Before the first screen, so a purchase that completed while the app was closed - or on
        // another device - is heard about as soon as possible.
        Task {
            await SubscriptionManager.shared.start()
            await SubscriptionManager.shared.refresh()
        }
        return true
    }
}
