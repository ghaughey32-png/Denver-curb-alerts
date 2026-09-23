import Foundation

/// One reminder as the web client's `buildNotificationJobs` produces it. Times are absolute, which
/// is the whole reason the device can schedule these itself with no server involved.
struct ReminderJob: Codable, Equatable {
    let id: String
    let title: String
    let body: String
    let scheduledAt: String
    var setName: String?
    var url: String?
    var sweepKeys: [String]?
    var segmentLabels: [String]?
}

/// The full job list and the confirmed sweeps, kept outside the web view. The page is not running
/// when a background refresh fires, when the lock-screen button is pressed, or when the home-screen
/// widget draws, so anything needed at those moments has to live here rather than in the page's
/// localStorage.
///
/// It lives in the App Group rather than the app's own defaults because the widget extension is a
/// separate process and cannot read those. The app is the only writer; the widget only reads.
struct ReminderStore {
    static let appGroup = "group.co.curbalerts.app"

    private static let jobsKey = "reminderJobs"
    private static let movedKey = "movedSweepKeys"

    /// Falls back to the app's own defaults if the group container is unavailable, which only
    /// happens when the entitlement is missing. The app keeps working; the widget sees nothing.
    let defaults = UserDefaults(suiteName: ReminderStore.appGroup) ?? .standard

    var jobs: [ReminderJob] {
        get {
            guard let data = defaults.data(forKey: Self.jobsKey) else { return [] }
            return (try? JSONDecoder().decode([ReminderJob].self, from: data)) ?? []
        }
        nonmutating set {
            defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.jobsKey)
        }
    }

    var movedSweepKeys: [String] {
        get { defaults.stringArray(forKey: Self.movedKey) ?? [] }
        nonmutating set { defaults.set(newValue, forKey: Self.movedKey) }
    }

    /// Builds 5 and earlier kept both lists in the app's own defaults. Moved once, at launch, so an
    /// installed tester keeps every reminder across the update rather than waiting for the page to
    /// hand the list over again - which would not happen until they next open the app.
    static func migrateFromStandardDefaultsIfNeeded() {
        guard let group = UserDefaults(suiteName: appGroup) else { return }
        let standard = UserDefaults.standard
        for key in [jobsKey, movedKey] {
            guard let value = standard.object(forKey: key) else { continue }
            if group.object(forKey: key) == nil {
                group.set(value, forKey: key)
            }
            standard.removeObject(forKey: key)
        }
    }

    /// The confirmed sweeps, plus every sweep of a parking pin the car has left. A pin's set id starts
    /// `parked-`, and confirming any one of its sweeps means the car is no longer at that spot, so its
    /// later reminders are for a curb nobody is parked on. The page drops that pin the next time it
    /// opens; this is what stops the device, and the widget, treating it as parked in the meantime.
    func effectiveMovedSweepKeys() -> Set<String> {
        let moved = Set(movedSweepKeys)
        let releasedPins = Set(moved.compactMap { key -> Substring? in
            key.hasPrefix("parked-") ? key.split(separator: "|").first : nil
        })
        guard !releasedPins.isEmpty else { return moved }

        let pinSweeps = jobs
            .flatMap { $0.sweepKeys ?? [] }
            .filter { key in key.split(separator: "|").first.map(releasedPins.contains) ?? false }
        return moved.union(pinSweeps)
    }
}

enum SweepCalendar {
    static func parseDate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }

    /// Local midnight of the day a sweep key names. Sweep keys are `<set id>|<YYYY-MM-DD>` in local
    /// time, the same shape the page writes.
    static func sweepDay(fromKey key: String) -> Date? {
        guard let suffix = key.split(separator: "|").last else { return nil }

        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: String(suffix))
    }
}

/// One sweep the driver still has to move for, as the widget shows it.
struct UpcomingSweep: Equatable {
    let sweepKey: String
    let day: Date
    let setName: String
    let curbLabels: [String]
    /// The first reminder's link, `/?moved=<sweep key>`. Opening it focuses that sweep in the page's
    /// banner without confirming it, the same as tapping the reminder itself.
    let url: String?

    var isParkedCar: Bool {
        sweepKey.hasPrefix("parked-")
    }

    /// Sweeps still to come as of `now`, soonest first. A sweep stays listed for the whole of its
    /// day: Denver publishes dates, not times, so there is no moment on the day when it is safely
    /// over. Confirmed sweeps, and every sweep of a pin the car has left, are dropped.
    static func upcoming(jobs: [ReminderJob], moved: Set<String>, now: Date) -> [UpcomingSweep] {
        let today = Calendar.current.startOfDay(for: now)
        var bySweep: [String: (sweep: UpcomingSweep, firstAlert: Date)] = [:]

        for job in jobs {
            let alertAt = SweepCalendar.parseDate(job.scheduledAt) ?? .distantFuture

            for sweepKey in job.sweepKeys ?? [] where !moved.contains(sweepKey) {
                guard let day = SweepCalendar.sweepDay(fromKey: sweepKey), day >= today else { continue }

                if var existing = bySweep[sweepKey] {
                    // A sweep's jobs can each carry a different subset of its curbs, so the labels
                    // are the union. The link comes from the earliest alert, as the card's does.
                    var labels = existing.sweep.curbLabels
                    for label in job.segmentLabels ?? [] where !labels.contains(label) {
                        labels.append(label)
                    }
                    let earlier = alertAt < existing.firstAlert
                    existing.sweep = UpcomingSweep(
                        sweepKey: sweepKey,
                        day: day,
                        setName: existing.sweep.setName,
                        curbLabels: labels,
                        url: earlier ? (job.url ?? existing.sweep.url) : existing.sweep.url
                    )
                    existing.firstAlert = min(existing.firstAlert, alertAt)
                    bySweep[sweepKey] = existing
                } else {
                    bySweep[sweepKey] = (
                        UpcomingSweep(
                            sweepKey: sweepKey,
                            day: day,
                            setName: job.setName ?? "Your curb",
                            curbLabels: job.segmentLabels ?? [],
                            url: job.url
                        ),
                        alertAt
                    )
                }
            }
        }

        // The parked car first on a shared day: it is where the car actually is.
        return bySweep.values.map(\.sweep).sorted { lhs, rhs in
            if lhs.day != rhs.day { return lhs.day < rhs.day }
            if lhs.isParkedCar != rhs.isParkedCar { return lhs.isParkedCar }
            return lhs.sweepKey < rhs.sweepKey
        }
    }
}
