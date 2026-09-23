import BackgroundTasks
import Foundation
import UserNotifications
import WidgetKit

actor ReminderScheduler {
    static let shared = ReminderScheduler()

    /// iOS keeps only the soonest 64 pending local notifications per app and silently drops the
    /// rest. Scheduling three weeks ahead, capped below the limit, means nothing is ever dropped;
    /// the window moves forward on every open and every background refresh.
    static let horizon: TimeInterval = 21 * 24 * 60 * 60
    static let maximumPending = 60
    static let requestPrefix = "reminder."
    static let categoryIdentifier = "SWEEP_REMINDER"
    static let movedActionIdentifier = "MOVED_CAR"
    static let refreshTaskIdentifier = "co.curbalerts.app.reminder-refresh"

    private let store = ReminderStore()
    private let center = UNUserNotificationCenter.current()

    nonisolated static func registerCategories() {
        // No .foreground option: confirming from the lock screen should not drag the driver into
        // the app. The action runs in the background and the page catches up the next time it opens.
        let moved = UNNotificationAction(identifier: movedActionIdentifier, title: "I moved my car", options: [])
        let category = UNNotificationCategory(identifier: categoryIdentifier, actions: [moved], intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    nonisolated static func submitBackgroundRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: refreshTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 12 * 60 * 60)
        // Fails on the simulator and when Background App Refresh is off. Opening the app still
        // refills the window, so there is nothing more useful to do with the error.
        try? BGTaskScheduler.shared.submit(request)
    }

    func permission() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return "granted"
        case .denied:
            return "denied"
        default:
            return "default"
        }
    }

    func requestPermission() async throws -> String {
        _ = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        return await permission()
    }

    func movedSweepKeys() -> [String] {
        pruned(store.movedSweepKeys)
    }

    /// The page's `scheduleReminders`. It replaces everything, including the confirmed sweeps: the
    /// page's list is authoritative, which is what lets its Undo bring a sweep's reminders back.
    func replaceSchedule(jobs: [ReminderJob], movedSweepKeys: [String]) async throws {
        store.jobs = jobs
        store.movedSweepKeys = pruned(movedSweepKeys)
        await clearDeliveredForMovedSweeps()
        try await reschedule()
    }

    /// The lock-screen button. The page may not be running, so the sweep is recorded here and the
    /// page merges it in the next time it loads.
    func recordMoved(_ sweepKeys: [String]) async {
        guard !sweepKeys.isEmpty else { return }
        store.movedSweepKeys = pruned(store.movedSweepKeys + sweepKeys)
        await clearDeliveredForMovedSweeps()
        try? await reschedule()
    }

    func reschedule() async throws {
        // The gate. Reminders are the product that is sold, so only the jobs the subscription
        // covers are scheduled; the rest stay in the store for the moment it is renewed. This
        // decides for the notifications, the lock-screen card and the widget alike, and it lives
        // here rather than in the page so that no page bug can give reminders away or drop them.
        let jobs = store.access.coveredJobs(store.jobs)
        let moved = store.effectiveMovedSweepKeys()

        // The lock-screen card has its own switch in Settings and does not need notification
        // permission, so it is kept in step before the permission check below can return early.
        await LiveActivityScheduler.sync(jobs: jobs, movedSweepKeys: moved)

        // The widget draws from the same store and cannot tell when it changed. Every path that
        // changes the schedule or confirms a sweep comes through here, so this is the one reload.
        WidgetCenter.shared.reloadAllTimelines()

        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(
            withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(Self.requestPrefix) }
        )

        guard await permission() == "granted" else { return }

        let now = Date()
        let latest = now.addingTimeInterval(Self.horizon)
        let upcoming = jobs
            .compactMap { job -> (ReminderJob, Date)? in
                guard let date = SweepCalendar.parseDate(job.scheduledAt), date > now, date <= latest,
                      !Self.isSilenced(job.sweepKeys ?? [], moved: moved) else { return nil }
                return (job, date)
            }
            .sorted { $0.1 < $1.1 }
            .prefix(Self.maximumPending)

        for (job, date) in upcoming {
            try await center.add(Self.request(for: job, at: date))
        }

        try await scheduleAccessNotices(moved: moved, now: now)
    }

    /// The warnings that reminders are about to stop, or have. Planned from the full job list, not
    /// the covered one: the point is to name what the driver is about to stop hearing about.
    private func scheduleAccessNotices(moved: Set<String>, now: Date) async throws {
        let prefix = AccessNoticePlanner.identifierPrefix
        let pending = await center.pendingNotificationRequests()
        center.removePendingNotificationRequests(
            withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix(prefix) }
        )

        // Covered again, so every earlier warning is spent: the next lapse starts from nothing.
        if store.access.status == .trial || store.access.status == .active, !store.sentAccessNotices.isEmpty {
            store.sentAccessNotices = []
        }

        let sent = store.sentAccessNotices
        let notices = AccessNoticePlanner.plan(
            access: store.access,
            jobs: store.jobs,
            moved: moved,
            alreadySent: Set(sent),
            now: now
        )
        for notice in notices {
            try await center.add(Self.request(for: notice))
        }

        let newIds = notices.map(\.id).filter { !sent.contains($0) }
        if !newIds.isEmpty {
            store.sentAccessNotices = sent + newIds
        }
    }

    private static func request(for notice: AccessNoticePlanner.Notice) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        content.threadIdentifier = "subscription"
        content.userInfo = ["accessAction": notice.action.rawValue]

        let trigger: UNNotificationTrigger
        if let fireAt = notice.fireAt {
            let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: fireAt)
            trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        } else {
            trigger = UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
        }
        return UNNotificationRequest(identifier: notice.id, content: content, trigger: trigger)
    }

    func showTestNotification(title: String, body: String) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.categoryIdentifier = Self.categoryIdentifier
        content.userInfo = ["url": "/", "sweepKeys": [String]()]
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 2, repeats: false)
        try await center.add(UNNotificationRequest(identifier: "test.\(UUID().uuidString)", content: content, trigger: trigger))
    }

    // MARK: - Helpers

    private func clearDeliveredForMovedSweeps() async {
        let moved = store.effectiveMovedSweepKeys()
        let delivered = await center.deliveredNotifications()
        let identifiers = delivered
            .filter { Self.isSilenced($0.request.content.userInfo["sweepKeys"] as? [String] ?? [], moved: moved) }
            .map(\.request.identifier)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    /// A job silenced only when every sweep it covers is confirmed. Two sweeps can share one alert
    /// time, and confirming one of them must not swallow the other's warning.
    private static func isSilenced(_ sweepKeys: [String], moved: Set<String>) -> Bool {
        !sweepKeys.isEmpty && sweepKeys.allSatisfy(moved.contains)
    }

    private static func request(for job: ReminderJob, at date: Date) -> UNNotificationRequest {
        let sweepKeys = job.sweepKeys ?? []
        let content = UNMutableNotificationContent()
        content.title = job.title
        content.body = job.body
        content.sound = .default
        // Time Sensitive breaks through Focus. A sweeping reminder held back until someone leaves
        // a Work focus at 5pm is a reminder that arrived after the ticket.
        content.interruptionLevel = .timeSensitive
        content.threadIdentifier = sweepKeys.first ?? "reminders"
        content.userInfo = ["url": job.url ?? "/", "sweepKeys": sweepKeys]
        if !sweepKeys.isEmpty {
            content.categoryIdentifier = categoryIdentifier
        }

        let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        return UNNotificationRequest(identifier: requestPrefix + job.id, content: content, trigger: trigger)
    }

    /// Sweep keys are `<set id>|<YYYY-MM-DD>` in local time, the same shape the page writes. Keys
    /// for sweeps already past are dropped so the list never grows without bound.
    private func pruned(_ keys: [String]) -> [String] {
        let calendar = Calendar.current
        guard let yesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: Date())) else { return keys }

        return Set(keys)
            .filter { key in
                guard let date = SweepCalendar.sweepDay(fromKey: key) else { return false }
                return date >= yesterday
            }
            .sorted()
    }
}
