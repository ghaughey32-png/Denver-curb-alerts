/// Never runs. `MovedCarIntent` is a LiveActivityIntent, so iOS performs it in the app's process,
/// where the real handler lives. This target compiles the intent only because the card's button
/// names it, and the intent needs a handler of this shape to compile against.
enum MovedCarIntentHandler {
    static func handle(sweepKey: String) async {}
}
