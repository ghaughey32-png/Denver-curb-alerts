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

    /// Test cards come from "Send test now" and name no saved set, so confirming one silences
    /// nothing real. The widget reads this to label the card as a test.
    static let testCardPrefix = "test-card|"

    var isTestCard: Bool {
        sweepKey.hasPrefix(Self.testCardPrefix)
    }
}
