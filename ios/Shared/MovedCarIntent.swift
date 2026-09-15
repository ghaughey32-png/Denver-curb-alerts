import AppIntents
import Foundation

/// The card's "I moved my car" button.
///
/// A LiveActivityIntent runs in the app's process, not the widget's, which is what lets it reach the
/// reminder scheduler. The widget still compiles this type because its button names it, so each
/// target supplies its own `MovedCarIntentHandler`: the app's does the work, the widget's is a stub
/// that never runs.
struct MovedCarIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "I moved my car"
    static var description = IntentDescription("Stops the street sweeping reminders for this sweep.")
    static var isDiscoverable = false

    @Parameter(title: "Sweep")
    var sweepKey: String

    init() {}

    init(sweepKey: String) {
        self.sweepKey = sweepKey
    }

    func perform() async throws -> some IntentResult {
        await MovedCarIntentHandler.handle(sweepKey: sweepKey)
        return .result()
    }
}
