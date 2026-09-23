import Foundation

/// Whether this device's reminders are paid for, and until when, as `SubscriptionManager` last saw
/// it. The reminder is the product that is sold; the map is free.
///
/// It lives in the App Group beside the reminder jobs because the widget is a separate process and
/// has to know whether to show a sweep or "Reminders paused". It deliberately does not import
/// StoreKit: the app is the only writer, and the widget only reads this plain record.
struct ReminderAccess: Codable, Equatable {
    enum Status: String, Codable {
        /// Never subscribed on this Apple ID, or StoreKit has not been asked yet.
        case none
        /// Inside the yearly plan's free trial. `endsAt` is when the first charge falls.
        case trial
        /// Paid and set to renew. `endsAt` is the renewal date.
        case active
        /// Paid, but switched off in Settings. Reminders stop at `endsAt` unless they turn it back on.
        case cancelling
        /// A renewal failed. Inside the Billing Grace Period reminders still run until `endsAt`;
        /// once it is past, Apple is still retrying but the driver is no longer covered.
        case billingIssue
        /// Lapsed or refunded.
        case expired
    }

    var status: Status
    var productID: String?
    /// When reminders stop if nothing changes, or when the next charge falls for a plan that renews.
    var endsAt: Date?
    var willRenew: Bool
    var checkedAt: Date

    static let unknown = ReminderAccess(status: .none, productID: nil, endsAt: nil, willRenew: false, checkedAt: .distantPast)

    /// The one question the reminder gate asks. A failed payment still counts while its grace
    /// period runs: cutting reminders the moment a card is declined turns a billing problem into a
    /// parking ticket, and the driver is warned well before the grace period ends.
    func isEntitled(at now: Date = Date()) -> Bool {
        switch status {
        case .trial, .active:
            return true
        case .cancelling, .billingIssue:
            guard let endsAt else { return false }
            return endsAt > now
        case .none, .expired:
            return false
        }
    }
}

extension ReminderStore {
    private static let accessKey = "reminderAccess"

    var access: ReminderAccess {
        get {
            guard let data = defaults.data(forKey: Self.accessKey) else { return .unknown }
            return (try? JSONDecoder().decode(ReminderAccess.self, from: data)) ?? .unknown
        }
        nonmutating set {
            defaults.set(try? JSONEncoder().encode(newValue), forKey: Self.accessKey)
        }
    }
}
