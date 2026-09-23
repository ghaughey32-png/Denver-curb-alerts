import Foundation
import StoreKit

/// Reads the reminder subscription from StoreKit and keeps `ReminderStore.access` in step with it.
///
/// Two products in one subscription group: yearly at $14.99 with a 14-day free trial, monthly at
/// $2.99 with none. Prices are set in App Store Connect and read from `Product.displayPrice`; they
/// are never written into the app or the page.
///
/// The subscription belongs to the Apple ID, not to a Curb Alerts account, so it needs no sign-in:
/// reminders already work signed out, and gating them behind an account would be a sign-up wall.
actor SubscriptionManager {
    static let shared = SubscriptionManager()

    static let yearlyProductID = "co.curbalerts.app.reminders.yearly"
    static let monthlyProductID = "co.curbalerts.app.reminders.monthly"
    /// Yearly first: it is the plan the paywall leads with.
    static let productIDs = [yearlyProductID, monthlyProductID]

    private let store = ReminderStore()
    private var updates: Task<Void, Never>?
    private var products: [Product] = []

    /// Called once at launch. Renewals, refunds, cancellations and purchases made on another device
    /// arrive on `Transaction.updates`, including ones that happened while the app was closed, so
    /// the listener has to be running before anything else asks.
    func start() {
        guard updates == nil else { return }

        updates = Task.detached(priority: .background) {
            for await result in Transaction.updates {
                if case .verified(let transaction) = result {
                    await transaction.finish()
                }
                await SubscriptionManager.shared.refresh()
            }
        }
    }

    /// The two plans as App Store Connect describes them, yearly first. Empty when the store cannot
    /// be reached, or before the products exist in App Store Connect.
    func loadProducts() async -> [Product] {
        if products.isEmpty, let loaded = try? await Product.products(for: Self.productIDs) {
            products = loaded.sorted { lhs, rhs in
                (Self.productIDs.firstIndex(of: lhs.id) ?? .max) < (Self.productIDs.firstIndex(of: rhs.id) ?? .max)
            }
        }
        return products
    }

    /// Asks StoreKit where the subscription stands, saves it, and reschedules if that changed.
    /// Works offline: StoreKit keeps the signed transactions on the device.
    @discardableResult
    func refresh() async -> ReminderAccess {
        let access = await currentAccess()
        let previous = store.access
        store.access = access

        // A change in access is a change in which reminders may run, and reschedule is the one
        // place that turns reminders, the lock-screen card and the widget on and off.
        if previous.status != access.status || previous.endsAt != access.endsAt || previous.productID != access.productID {
            try? await ReminderScheduler.shared.reschedule()
        }
        return access
    }

    private func currentAccess(now: Date = Date()) async -> ReminderAccess {
        // A subscription in its grace period is still a current entitlement; one in billing retry
        // past the grace period is not, which is why the latest transaction is consulted as well.
        var candidates: [Transaction] = []
        for await result in Transaction.currentEntitlements {
            if case .verified(let transaction) = result, Self.productIDs.contains(transaction.productID) {
                candidates.append(transaction)
            }
        }
        if candidates.isEmpty {
            for productID in Self.productIDs {
                if case .verified(let transaction)? = await Transaction.latest(for: productID) {
                    candidates.append(transaction)
                }
            }
        }

        let described = await withTaskGroup(of: ReminderAccess.self) { group in
            for transaction in candidates {
                group.addTask { await Self.describe(transaction, now: now) }
            }
            var all: [ReminderAccess] = []
            for await access in group {
                all.append(access)
            }
            return all
        }

        // Entitled beats not, and of two entitled readings the one that lasts longer wins.
        let best = described.max { lhs, rhs in
            let lhsEntitled = lhs.isEntitled(at: now)
            let rhsEntitled = rhs.isEntitled(at: now)
            if lhsEntitled != rhsEntitled { return !lhsEntitled }
            return (lhs.endsAt ?? .distantPast) < (rhs.endsAt ?? .distantPast)
        }
        return best ?? ReminderAccess(status: .none, productID: nil, endsAt: nil, willRenew: false, checkedAt: now)
    }

    private static func describe(_ transaction: Transaction, now: Date) async -> ReminderAccess {
        let productID = transaction.productID

        if transaction.revocationDate != nil {
            return ReminderAccess(status: .expired, productID: productID, endsAt: transaction.revocationDate, willRenew: false, checkedAt: now)
        }

        guard let status = await transaction.subscriptionStatus else {
            // No status reachable. The transaction alone still says whether it is in force.
            let inForce = (transaction.expirationDate ?? .distantPast) > now
            return ReminderAccess(
                status: inForce ? (transaction.offerType == .introductory ? .trial : .active) : .expired,
                productID: productID,
                endsAt: transaction.expirationDate,
                willRenew: inForce,
                checkedAt: now
            )
        }

        let renewal: Product.SubscriptionInfo.RenewalInfo?
        if case .verified(let info) = status.renewalInfo {
            renewal = info
        } else {
            renewal = nil
        }
        let willRenew = renewal?.willAutoRenew ?? false

        switch status.state {
        case .subscribed:
            let isTrial = transaction.offerType == .introductory
            return ReminderAccess(
                status: willRenew ? (isTrial ? .trial : .active) : .cancelling,
                productID: productID,
                endsAt: transaction.expirationDate,
                willRenew: willRenew,
                checkedAt: now
            )
        case .inGracePeriod:
            return ReminderAccess(
                status: .billingIssue,
                productID: productID,
                endsAt: renewal?.gracePeriodExpirationDate ?? transaction.expirationDate,
                willRenew: willRenew,
                checkedAt: now
            )
        case .inBillingRetryPeriod:
            // Past any grace period. Apple is still retrying, so a fixed card brings it straight
            // back, but reminders are not covered in the meantime.
            return ReminderAccess(status: .billingIssue, productID: productID, endsAt: transaction.expirationDate, willRenew: willRenew, checkedAt: now)
        default:
            return ReminderAccess(status: .expired, productID: productID, endsAt: transaction.expirationDate, willRenew: false, checkedAt: now)
        }
    }
}
