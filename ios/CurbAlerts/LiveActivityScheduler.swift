import ActivityKit
import Foundation

/// Keeps the lock-screen cards in step with the reminder jobs.
///
/// A card starts at a sweep's first reminder on the sweep day itself - the 7:00 alert by default -
/// and says the car still needs to move until the driver taps its button. It is kept in step from
/// `ReminderScheduler.reschedule`, so a confirmation from the page, the notification or the card
/// ends it, and the page's Undo brings it back.
///
/// Scheduling one for later needs iOS 26 (`request(...start:)`). Earlier systems can only start a
/// card that is due now, so on those the card appears when the app is opened on the sweep day.
@MainActor
enum LiveActivityScheduler {
    /// How far ahead to schedule. Cards are cheap to re-plan on every open, and iOS's limit on
    /// pending activities is not documented, so this stays short rather than filling a queue.
    static let lookahead: TimeInterval = 3 * 24 * 60 * 60
    static let maximumPlanned = 3

    struct Plan {
        let sweepKey: String
        let setName: String
        let curbSummary: String
        let start: Date
        let end: Date
    }

    static func sync(jobs: [ReminderJob], movedSweepKeys moved: Set<String>, now: Date = Date()) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        let plans = plannedSweeps(jobs: jobs, moved: moved, now: now)
        let knownSweeps = Set(jobs.flatMap { $0.sweepKeys ?? [] })

        // End a card only when its sweep is confirmed or no longer has any reminders - the set was
        // deleted, or Keep reminding me and the morning alerts were all switched off. Ending every
        // card that is merely absent from this pass's plan was tried first and was wrong: it ended
        // cards the plan had simply capped out, and on a device it killed the preview card the
        // instant Face ID brought the app back to the foreground.
        for activity in Activity<SweepActivityAttributes>.activities where isLive(activity) {
            let sweepKey = activity.attributes.sweepKey
            guard !isPreview(sweepKey) else { continue }
            if moved.contains(sweepKey) || !knownSweeps.contains(sweepKey) {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }

        let existing = Set(
            Activity<SweepActivityAttributes>.activities.filter(isLive).map(\.attributes.sweepKey)
        )
        for plan in plans where !existing.contains(plan.sweepKey) {
            start(plan, now: now)
        }
    }

    /// Flips the card to "Car moved" and lets it linger a few minutes, so the tap visibly did
    /// something before the card goes away.
    static func markMoved(sweepKeys: [String]) async {
        let keys = Set(sweepKeys)
        for activity in Activity<SweepActivityAttributes>.activities
        where keys.contains(activity.attributes.sweepKey) && isLive(activity) {
            let content = ActivityContent(state: SweepActivityAttributes.ContentState(moved: true), staleDate: nil)
            await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(10 * 60)))
        }
    }

    static func plannedSweeps(jobs: [ReminderJob], moved: Set<String>, now: Date) -> [Plan] {
        let calendar = Calendar.current
        var bySweep: [String: Plan] = [:]

        for job in jobs {
            guard let alertAt = ReminderScheduler.parseDate(job.scheduledAt) else { continue }

            for sweepKey in job.sweepKeys ?? [] where !moved.contains(sweepKey) {
                // Only the sweep day's own alerts start a card. The evening-before reminders stay
                // notifications - a card that appeared at 6pm would expire overnight, before the
                // morning it is actually about.
                guard let sweepDay = ReminderScheduler.sweepDay(fromKey: sweepKey),
                      calendar.isDate(alertAt, inSameDayAs: sweepDay),
                      let end = calendar.date(byAdding: .day, value: 1, to: sweepDay),
                      end > now,
                      alertAt < now.addingTimeInterval(lookahead) else { continue }

                if let planned = bySweep[sweepKey], planned.start <= alertAt { continue }
                bySweep[sweepKey] = Plan(
                    sweepKey: sweepKey,
                    setName: job.setName ?? "Your curb",
                    curbSummary: summarize(job.segmentLabels ?? []),
                    start: alertAt,
                    end: end
                )
            }
        }

        return Array(bySweep.values.sorted { $0.start < $1.start }.prefix(maximumPlanned))
    }

    private static func start(_ plan: Plan, now: Date) {
        let attributes = SweepActivityAttributes(
            sweepKey: plan.sweepKey,
            setName: plan.setName,
            curbSummary: plan.curbSummary
        )
        let content = ActivityContent(
            state: SweepActivityAttributes.ContentState(moved: false),
            staleDate: plan.end
        )

        do {
            if plan.start > now {
                guard #available(iOS 26.0, *) else { return }
                let alert = AlertConfiguration(
                    title: "Move your car today",
                    body: LocalizedStringResource(stringLiteral: "Street sweeping on \(plan.curbSummary)."),
                    sound: .default
                )
                _ = try Activity.request(
                    attributes: attributes,
                    content: content,
                    pushType: nil,
                    style: .standard,
                    alertConfiguration: alert,
                    start: plan.start
                )
            } else {
                _ = try Activity.request(attributes: attributes, content: content, pushType: nil)
            }
        } catch {
            // Refused when the app is in the background, when the driver has turned Live Activities
            // off, or when iOS is at its limit. The notifications carry the reminder regardless;
            // the next foreground tries again.
            print("Live Activity for \(plan.sweepKey) was not started: \(error)")
        }
    }

    #if DEBUG
    /// Debug builds only: starts a card now for a made-up sweep, so the card and its button can be
    /// tried on a device without waiting for a real sweep morning. Its key names no saved set, so
    /// confirming it silences nothing real. Wired to the page's "Send test now".
    static func startPreview() {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        guard let end = calendar.date(byAdding: .day, value: 1, to: today) else { return }

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        start(
            Plan(
                sweepKey: previewPrefix + formatter.string(from: today),
                setName: "Preview",
                curbSummary: "Preview curb - LAWRENCE ST, West side",
                start: Date(),
                end: end
            ),
            now: Date()
        )
    }
    #endif

    private static let previewPrefix = "debug-preview|"

    private static func isPreview(_ sweepKey: String) -> Bool {
        sweepKey.hasPrefix(previewPrefix)
    }

    private static func isLive(_ activity: Activity<SweepActivityAttributes>) -> Bool {
        activity.activityState != .ended && activity.activityState != .dismissed
    }

    private static func summarize(_ labels: [String]) -> String {
        guard let first = labels.first else { return "Your saved curb" }
        return labels.count > 1 ? "\(first) + \(labels.count - 1) more" : first
    }
}
