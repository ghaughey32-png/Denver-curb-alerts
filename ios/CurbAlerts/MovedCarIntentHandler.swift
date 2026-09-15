import Foundation

/// What the card's "I moved my car" button does. It runs in the app's process, possibly with the
/// app in the background and no page loaded, so everything it touches has to work without the web
/// view - the same constraints as the notification's button of the same name.
enum MovedCarIntentHandler {
    static func handle(sweepKey: String) async {
        // The card first, so the driver sees "Car moved" straight away rather than after the
        // reminder bookkeeping finishes.
        await LiveActivityScheduler.markMoved(sweepKeys: [sweepKey])
        await ReminderScheduler.shared.recordMoved([sweepKey])
        await WebShell.shared.dispatch(["type": "sweep-moved", "sweepKeys": [sweepKey]])
    }
}
