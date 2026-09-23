import Foundation

/// The warnings a driver gets before, and when, their sweep reminders stop.
///
/// The rule this exists for is in AGENTS.md: reminders are sold, but they never stop silently. A
/// driver who believes they are covered and gets the ticket because a card was declined is the one
/// failure the paywall must not cause. So every way reminders can end - a failed payment, a
/// cancelled plan, a refund, or reminders that now need a subscription at all - is announced ahead
/// of time where it can be, and the moment it happens where it cannot.
///
/// Everything here is a local notification planned from `ReminderAccess`, so it arrives whether or
/// not the app is opened again. Pure: no StoreKit and no notification center, so it can be checked
/// on its own.
enum AccessNoticePlanner {
    /// What a tap on the notice opens.
    enum Action: String {
        /// Apple's payment-method page, for a failed renewal.
        case billing
        /// Apple's subscription screen, to turn a cancelled plan back on.
        case manage
        /// The app, where the paywall is.
        case subscribe
    }

    struct Notice: Equatable {
        /// Stable for a given lapse, so a notice is replaced rather than duplicated on every
        /// reschedule, and a one-off is sent once. Keyed by the end date, so a later lapse with a
        /// different end date warns afresh.
        let id: String
        let title: String
        let body: String
        /// Nil means now.
        let fireAt: Date?
        let action: Action
    }

    static let identifierPrefix = "access."
    /// iOS gives an app no say over a notification's colour, so the alarm goes in the title, the
    /// first thing read on the lock screen. Every notice here gets it: each one is about reminders
    /// being off or about to stop.
    static let alarm = "😱 "
    /// A cancelled plan gets crossed-out eyes rather than the scream: the driver ended it themselves.
    static let cancelledAlarm = "😵 "
    /// Warnings go out mid-morning, not at whatever hour a renewal happens to fall.
    static let warningHour = 10

    /// - Parameter alreadySent: ids of notices already scheduled or sent. Only the one-offs that
    ///   fire now consult it; a future notice is re-added on every pass because the scheduler
    ///   clears pending notices first.
    static func plan(
        access: ReminderAccess,
        jobs: [ReminderJob],
        moved: Set<String>,
        alreadySent: Set<String>,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [Notice] {
        // StoreKit has not answered yet, which is not the same as "not subscribed". Telling a paying
        // driver their reminders need a subscription because the app raced its own launch would be
        // its own kind of lie.
        guard access.checkedAt != .distantPast else { return [] }

        // Nothing is set up to remind, so nothing is being taken away.
        let jobs = jobs.filter { (SweepCalendar.parseDate($0.scheduledAt) ?? .distantPast) > now }
        guard !jobs.isEmpty else { return [] }

        let stamp = access.endsAt.map { String(Int($0.timeIntervalSince1970)) } ?? "none"
        var notices: [Notice] = []

        func once(_ notice: Notice) {
            if !alreadySent.contains(notice.id) { notices.append(notice) }
        }

        // Day names are relative to when the notice is read, not when it is planned: a warning that
        // fires Thursday about a Friday end has to say "tomorrow", whatever today is.
        func missedSweepLine(readAt: Date) -> String? {
            guard let sweep = UpcomingSweep.upcoming(jobs: jobs, moved: moved, now: readAt).first else { return nil }
            let curb = sweep.curbLabels.first ?? sweep.setName
            return "\(curb) is swept \(dayName(sweep.day, now: readAt, calendar: calendar)), and you won't be reminded."
        }

        func stopped(at date: Date?) -> Notice {
            let missed = missedSweepLine(readAt: max(date ?? now, now))
            return Notice(
                id: identifierPrefix + "stopped|" + stamp,
                title: alarm + "Sweep reminders have stopped",
                body: [missed, "Open Curb Alerts to turn them back on."].compactMap { $0 }.joined(separator: " "),
                fireAt: date.flatMap { $0 > now ? $0 : nil },
                action: .subscribe
            )
        }

        // One "stopped" per lapse. The end date moves as a lapse goes on - the grace period's end, then
        // the plan's own expiry once Apple gives up retrying - so keying this one on the date alone
        // would announce the same stop twice. The scheduler forgets every sent id once the plan is
        // active again, which is what lets the next lapse warn afresh.
        let stopAlreadyAnnounced = alreadySent.contains { $0.hasPrefix(identifierPrefix + "stopped|") }
        func announceStopNow() {
            if !stopAlreadyAnnounced { notices.append(stopped(at: nil)) }
        }

        switch access.status {
        case .trial, .active:
            return []

        case .none:
            // Reminders set up before they needed a subscription - a tester's, or anyone's from a
            // build before the paywall. One notice, once; it is not repeated every open.
            let missed = missedSweepLine(readAt: now)
            once(Notice(
                id: identifierPrefix + "needs-subscription",
                title: alarm + "Sweep reminders need a subscription",
                body: ["Your curbs are saved, but reminders are off.", missed, "Open Curb Alerts to turn them back on."]
                    .compactMap { $0 }.joined(separator: " "),
                fireAt: nil,
                action: .subscribe
            ))

        case .cancelling, .billingIssue:
            guard let endsAt = access.endsAt, endsAt > now else {
                // Already past: the grace period ran out, or the plan ended while the app was shut.
                announceStopNow()
                break
            }

            let isBilling = access.status == .billingIssue
            let action: Action = isBilling ? .billing : .manage
            func warning(id: String, readAt: Date, fireAt: Date?) -> Notice {
                let endDay = dayName(endsAt, now: readAt, calendar: calendar)
                return Notice(
                    id: identifierPrefix + id + "|" + stamp,
                    title: isBilling ? alarm + "Payment failed: sweep reminders stop \(endDay)" : cancelledAlarm + "Sweep reminders end \(endDay)",
                    body: isBilling
                        ? "Apple couldn't renew your Curb Alerts subscription. Update your payment method to keep your reminders."
                        : "Your subscription is cancelled, so reminders stop \(endDay). Turn it back on to keep them.",
                    fireAt: fireAt,
                    action: action
                )
            }

            if isBilling {
                // The failure itself is news, and it may be weeks before the grace period ends.
                once(warning(id: "billing-now", readAt: now, fireAt: nil))
            }

            let ahead = [3, 1].compactMap { days -> Notice? in
                guard let day = calendar.date(byAdding: .day, value: -days, to: endsAt),
                      let at = calendar.date(bySettingHour: warningHour, minute: 0, second: 0, of: day),
                      at > now, at < endsAt else { return nil }
                return warning(id: "ending-\(days)d", readAt: at, fireAt: at)
            }
            notices.append(contentsOf: ahead)

            // Cancelled with less than a day left, so neither advance warning can still fire.
            if ahead.isEmpty && !isBilling {
                once(warning(id: "ending-now", readAt: now, fireAt: nil))
            }

            notices.append(stopped(at: endsAt))

        case .expired:
            // A refund, or a lapse first seen after the fact.
            announceStopNow()
        }

        return notices
    }

    /// "today", "tomorrow", "Thursday" within the week, then "Thursday, Oct 2".
    static func dayName(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: date)).day ?? 0
        switch days {
        case ...0: return "today"
        case 1: return "tomorrow"
        default:
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = days < 7 ? "EEEE" : "EEEE, MMM d"
            return formatter.string(from: date)
        }
    }
}
