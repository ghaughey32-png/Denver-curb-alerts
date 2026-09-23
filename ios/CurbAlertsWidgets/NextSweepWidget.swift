import AppIntents
import SwiftUI
import UIKit
import WidgetKit

/// The next sweep for the driver's curbs, on the home screen and the lock screen.
///
/// Everything comes from the reminder jobs the page hands the app, read out of the App Group. The
/// widget never touches the network or the page, so it is only as current as the last time the app
/// was opened - the same limit the notifications have.
struct NextSweepWidget: Widget {
    static let kind = "NextSweepWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: NextSweepProvider()) { entry in
            NextSweepWidgetView(entry: entry)
                .containerBackground(WidgetPalette.background, for: .widget)
                .widgetURL(SweepWidgetLink.url(forPagePath: entry.link))
        }
        .configurationDisplayName("Next sweep")
        .description("When you next need to move your car, and for which curb.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline, .accessoryCircular])
    }
}

/// The card follows the phone's appearance, unlike the app itself, which is light only: a widget
/// sits on the home screen among the system's own, and a cream tile on a dark screen reads as a
/// stuck notification rather than part of the phone. The light halves are `Palette`'s, so the two
/// appearances are the same product. Only the home-screen sizes use this - the lock-screen ones are
/// drawn in the system's tint and carry no colour of their own.
private enum WidgetPalette {
    static let accent = adaptive(light: Palette.accent, dark: Color(red: 0.898, green: 0.553, blue: 0.318))
    static let ink = adaptive(light: Palette.ink, dark: Color(red: 0.937, green: 0.925, blue: 0.902))
    static let muted = adaptive(light: Palette.muted, dark: Color(red: 0.639, green: 0.690, blue: 0.718))
    static let background = adaptive(light: Palette.cream, dark: Color(red: 0.086, green: 0.125, blue: 0.149))
    /// The button's label. Dark mode needs a lighter orange to sit on a dark card, and white text on
    /// that is too faint to read at a glance - which is the only way a widget is ever read.
    static let onAccent = adaptive(light: .white, dark: Color(red: 0.086, green: 0.125, blue: 0.149))
    static let green = adaptive(light: Palette.green, dark: Color(red: 0.400, green: 0.769, blue: 0.482))

    private static func adaptive(light: Color, dark: Color) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }
}

// MARK: - Timeline

struct NextSweepEntry: TimelineEntry {
    let date: Date
    /// The soonest sweep still to move for.
    let next: UpcomingSweep?
    /// The one after it, for the medium widget's second line.
    let following: UpcomingSweep?
    /// A sweep today or tomorrow the driver has already confirmed, and nothing unconfirmed before it.
    /// Shown so the tap on the button visibly did something, rather than the widget silently
    /// skipping ahead to a sweep a week away.
    let moved: UpcomingSweep?
    /// There are reminders set up, but no subscription covering them. Shown in place of a sweep so
    /// the widget never looks like it is still keeping watch when it is not.
    var paused = false

    var link: String? {
        next?.url
    }
}

struct NextSweepProvider: TimelineProvider {
    func placeholder(in context: Context) -> NextSweepEntry {
        Self.sampleEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (NextSweepEntry) -> Void) {
        // The widget gallery shows a sample rather than an empty tile to someone who has not set
        // up a reminder yet; once there is real data, the gallery shows that.
        let entry = Self.entry(at: Date())
        completion(context.isPreview && entry.next == nil && entry.moved == nil ? Self.sampleEntry : entry)
    }

    /// One entry now and one at each of the next seven midnights, so "tomorrow" becomes "today"
    /// on time with the app closed. The app reloads the timeline whenever the schedule changes or a
    /// sweep is confirmed, so nothing else needs an entry of its own.
    func getTimeline(in context: Context, completion: @escaping (Timeline<NextSweepEntry>) -> Void) {
        let calendar = Calendar.current
        let now = Date()
        let today = calendar.startOfDay(for: now)
        let midnights = (1...7).compactMap { calendar.date(byAdding: .day, value: $0, to: today) }
        let entries = [Self.entry(at: now)] + midnights.map(Self.entry(at:))
        completion(Timeline(entries: entries, policy: .after(midnights.last ?? now.addingTimeInterval(86_400))))
    }

    static func entry(at date: Date) -> NextSweepEntry {
        let store = ReminderStore()
        let access = store.access
        // Worked out per entry, so a plan that ends at midnight Thursday turns the widget to
        // "paused" at that midnight's entry with the app closed.
        if !store.jobs.isEmpty && !access.isEntitled(at: date) {
            return NextSweepEntry(date: date, next: nil, following: nil, moved: nil, paused: true)
        }
        let jobs = access.coveredJobs(store.jobs, at: date)
        let moved = store.effectiveMovedSweepKeys()
        let upcoming = UpcomingSweep.upcoming(jobs: jobs, moved: moved, now: date)

        let calendar = Calendar.current
        let today = calendar.startOfDay(for: date)
        let dayAfterTomorrow = calendar.date(byAdding: .day, value: 2, to: today) ?? today
        let recentlyMoved = UpcomingSweep.upcoming(jobs: jobs, moved: [], now: date)
            .first { moved.contains($0.sweepKey) && $0.day < dayAfterTomorrow }
        let showMoved = recentlyMoved.flatMap { sweep in
            (upcoming.first.map { $0.day > sweep.day } ?? true) ? sweep : nil
        }

        return NextSweepEntry(
            date: date,
            next: upcoming.first,
            following: upcoming.dropFirst().first,
            moved: showMoved
        )
    }

    static var sampleEntry: NextSweepEntry {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: Date())
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today) ?? today
        let later = calendar.date(byAdding: .day, value: 15, to: today) ?? today
        return NextSweepEntry(
            date: Date(),
            next: UpcomingSweep(sweepKey: "sample|next", day: tomorrow, setName: "My curbs",
                                curbLabels: ["W 32nd Ave - North side"], url: nil),
            following: UpcomingSweep(sweepKey: "sample|later", day: later, setName: "My curbs",
                                     curbLabels: ["Lowell Blvd - East side"], url: nil),
            moved: nil
        )
    }
}

// MARK: - Wording

private enum SweepWording {
    /// Whole days from the entry's date to the sweep's.
    static func daysAway(_ sweep: UpcomingSweep, from date: Date) -> Int {
        let calendar = Calendar.current
        return calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: sweep.day).day ?? 0
    }

    /// "Today", "Tomorrow", "Thursday" within the week, then "Thu, Oct 2".
    static func when(_ sweep: UpcomingSweep, from date: Date) -> String {
        switch daysAway(sweep, from: date) {
        case ...0: return "Today"
        case 1: return "Tomorrow"
        case 2...6: return sweep.day.formatted(.dateTime.weekday(.wide))
        default: return sweep.day.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
    }

    static func curb(_ sweep: UpcomingSweep) -> String {
        guard let first = sweep.curbLabels.first else {
            return sweep.isParkedCar ? "Where you parked" : sweep.setName
        }
        return sweep.curbLabels.count > 1 ? "\(first) + \(sweep.curbLabels.count - 1) more" : first
    }

    /// The street without its side, for the one-line lock-screen widget.
    static func street(_ sweep: UpcomingSweep) -> String {
        guard let first = sweep.curbLabels.first else { return sweep.isParkedCar ? "your car" : sweep.setName }
        return first.components(separatedBy: " - ").first ?? first
    }

    /// Whose sweep this is, or nil when that would only repeat the curb line - older saved sets
    /// were often named after their own street.
    static func owner(_ sweep: UpcomingSweep) -> String? {
        if sweep.isParkedCar { return "Your parked car" }
        let name = sweep.setName.lowercased()
        let street = street(sweep).lowercased()
        return name.contains(street) || street.contains(name) ? nil : sweep.setName
    }
}

// MARK: - Views

struct NextSweepWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: NextSweepEntry

    var body: some View {
        switch family {
        case .accessoryInline:
            InlineView(entry: entry)
        case .accessoryCircular:
            CircularView(entry: entry)
        case .accessoryRectangular:
            RectangularView(entry: entry)
        case .systemMedium:
            HomeScreenView(entry: entry, isMedium: true)
        default:
            HomeScreenView(entry: entry, isMedium: false)
        }
    }
}

private struct HomeScreenView: View {
    let entry: NextSweepEntry
    let isMedium: Bool

    var body: some View {
        if entry.paused {
            pausedView
        } else if let moved = entry.moved {
            movedView(moved)
        } else if let next = entry.next {
            sweepView(next)
        } else {
            emptyView
        }
    }

    private func sweepView(_ sweep: UpcomingSweep) -> some View {
        let days = SweepWording.daysAway(sweep, from: entry.date)
        let urgent = days <= 1
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: sweep.isParkedCar ? "mappin.circle.fill" : "car.fill")
                Text(days <= 0 ? "SWEEPING TODAY" : urgent ? "SWEEPING TOMORROW" : "NEXT SWEEP")
            }
            .font(.caption2.weight(.heavy))
            .foregroundStyle(urgent ? WidgetPalette.accent : WidgetPalette.muted)

            Text(urgent ? "Move your car" : SweepWording.when(sweep, from: entry.date))
                .font(isMedium ? .title3.weight(.bold) : .headline)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(SweepWording.curb(sweep))
                .font(.caption)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(isMedium ? 1 : 2)

            if let detail = detailLine(sweep, days: days, urgent: urgent) {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(WidgetPalette.muted)
                    .lineLimit(1)
            }

            Spacer(minLength: 0)

            if urgent {
                // A LiveActivityIntent runs in the app's process, which is how this reaches the
                // reminder scheduler from the home screen with the app closed.
                Button(intent: MovedCarIntent(sweepKey: sweep.sweepKey)) {
                    Text(isMedium ? "I moved my car" : "I moved it")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(WidgetPalette.onAccent)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(WidgetPalette.accent)
            } else if isMedium, let following = entry.following {
                followingLine(following)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "3 days · My curbs" when there is room and the set name adds something. On an urgent small
    /// widget the button needs the space more.
    private func detailLine(_ sweep: UpcomingSweep, days: Int, urgent: Bool) -> String? {
        if urgent { return isMedium ? SweepWording.owner(sweep) : nil }
        return ["\(days) days", SweepWording.owner(sweep)].compactMap { $0 }.joined(separator: " · ")
    }

    private func movedView(_ sweep: UpcomingSweep) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                Text("CAR MOVED")
            }
            .font(.caption2.weight(.heavy))
            .foregroundStyle(WidgetPalette.green)

            Text(SweepWording.when(sweep, from: entry.date) + "'s sweep")
                .font(isMedium ? .title3.weight(.bold) : .headline)
                .foregroundStyle(WidgetPalette.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)

            Text(SweepWording.curb(sweep))
                .font(.caption)
                .foregroundStyle(WidgetPalette.muted)
                .lineLimit(isMedium ? 1 : 2)

            Spacer(minLength: 0)

            if let next = entry.next {
                followingLine(next)
            } else {
                Text("Nothing else coming up")
                    .font(.caption2)
                    .foregroundStyle(WidgetPalette.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func followingLine(_ sweep: UpcomingSweep) -> some View {
        Text("Then \(SweepWording.when(sweep, from: entry.date)) · \(SweepWording.street(sweep))")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(WidgetPalette.muted)
            .lineLimit(1)
    }

    private var pausedView: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "bell.slash.fill")
                Text("CURB ALERTS")
            }
            .font(.caption2.weight(.heavy))
            .foregroundStyle(WidgetPalette.muted)

            Text("Reminders paused")
                .font(.headline)
                .foregroundStyle(WidgetPalette.ink)

            Spacer(minLength: 0)

            Text("Open Curb Alerts to turn them back on.")
                .font(.caption2)
                .foregroundStyle(WidgetPalette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyView: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "car.fill")
                Text("CURB ALERTS")
            }
            .font(.caption2.weight(.heavy))
            .foregroundStyle(WidgetPalette.muted)

            Text("No sweeps coming up")
                .font(.headline)
                .foregroundStyle(WidgetPalette.ink)

            Spacer(minLength: 0)

            Text("Tap a curb on the map and turn on its reminder.")
                .font(.caption2)
                .foregroundStyle(WidgetPalette.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The lock screen draws these in the system's own tint, so they carry no colour of their own.
private struct RectangularView: View {
    let entry: NextSweepEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if entry.paused {
                Label("Reminders paused", systemImage: "bell.slash.fill")
                    .font(.headline)
                Text("Open Curb Alerts").lineLimit(1)
            } else if let moved = entry.moved {
                Label("Car moved", systemImage: "checkmark.circle.fill")
                    .font(.headline)
                Text(SweepWording.curb(moved)).lineLimit(1)
                if let next = entry.next {
                    Text("Then \(SweepWording.when(next, from: entry.date))").lineLimit(1)
                }
            } else if let next = entry.next {
                let days = SweepWording.daysAway(next, from: entry.date)
                Label(days <= 1 ? "Sweeping \(SweepWording.when(next, from: entry.date).lowercased())"
                                : "Sweep \(SweepWording.when(next, from: entry.date))",
                      systemImage: "car.fill")
                    .font(.headline)
                    .widgetAccentable()
                Text(SweepWording.curb(next)).lineLimit(1)
                Text(days <= 1 ? "Move your car" : "In \(days) days").lineLimit(1)
            } else {
                Label("No sweeps", systemImage: "car.fill")
                    .font(.headline)
                Text("Nothing coming up").lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct InlineView: View {
    let entry: NextSweepEntry

    var body: some View {
        if entry.paused {
            Label("Sweep reminders paused", systemImage: "bell.slash.fill")
        } else if let next = entry.next {
            Label("Sweep \(SweepWording.when(next, from: entry.date)) · \(SweepWording.street(next))", systemImage: "car.fill")
        } else {
            Label("No sweeps coming up", systemImage: "car.fill")
        }
    }
}

private struct CircularView: View {
    let entry: NextSweepEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if entry.paused {
                Image(systemName: "bell.slash")
            } else if let next = entry.next {
                let days = SweepWording.daysAway(next, from: entry.date)
                VStack(spacing: 0) {
                    Image(systemName: "car.fill").font(.caption)
                    Text(days <= 0 ? "Today" : days == 1 ? "Tmrw" : "\(days)d")
                        .font(.caption.weight(.bold))
                        .minimumScaleFactor(0.7)
                }
                .widgetAccentable()
            } else {
                Image(systemName: "car")
            }
        }
    }
}

#Preview(as: .systemSmall) {
    NextSweepWidget()
} timeline: {
    NextSweepProvider.sampleEntry
}
