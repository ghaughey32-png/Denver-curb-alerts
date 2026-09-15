import ActivityKit
import Foundation

/// The lock-screen card for one sweep. Compiled into both the app, which starts and ends it, and
/// the widget extension, which draws it - the two have to agree on this shape exactly.
struct SweepActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var moved: Bool
    }

    /// `<set id>|<YYYY-MM-DD>`, the same key the page and the reminder scheduler use, so confirming
    /// from the card silences exactly the reminders it is about.
    var sweepKey: String
    var setName: String
    var curbSummary: String
}
