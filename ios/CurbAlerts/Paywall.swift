import StoreKit
import SwiftUI
import UIKit

/// The subscription screen. Apple's own `SubscriptionStoreView`, not a hand-built one: it shows the
/// prices in the buyer's currency, the trial terms, Restore Purchases and the Terms and Privacy
/// links exactly the way App Review expects a subscription screen to, so the part of the app most
/// likely to be rejected is the part written least by us.
struct PaywallView: View {
    /// Closes the sheet, after a purchase.
    let close: () -> Void
    /// Called however the sheet went away - Apple's own close button, a swipe down, or `close` -
    /// so the page's promise always settles.
    let gone: () -> Void

    /// "4¢", worked out from the yearly plan's real price once StoreKit has it. Never typed in: the
    /// price is set in App Store Connect and can change, and a buyer may be paying in another currency.
    @State private var dailyCost: String?

    /// The orange stripe in the app icon, #D37135, sampled from AppIcon-1024.png.
    static let logoOrange = Color(red: 0xD3 / 255, green: 0x71 / 255, blue: 0x35 / 255)

    static let termsURL = URL(string: "https://www.curbalerts.co/#terms")!
    static let privacyURL = URL(string: "https://www.curbalerts.co/#privacy")!

    var body: some View {
        SubscriptionStoreView(productIDs: SubscriptionManager.productIDs) {
            VStack(spacing: 12) {
                // A copy of the app icon (AppLogo in the asset catalog): iOS will not hand an app its
                // own AppIcon as an image. Clipped to the home-screen icon's shape.
                Image("AppLogo")
                    .resizable()
                    .frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                    .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
                Text("Never get a sweeping ticket")
                    .font(.title2.weight(.bold))
                    .multilineTextAlignment(.center)
                Text("Reminders the evening before and the morning of every sweep on your curb, and they keep coming until you've moved your car.")
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                VStack(spacing: 2) {
                    Text("A Denver street sweeping ticket costs $50.")
                    if let dailyCost {
                        Text("Curb Alerts costs about \(dailyCost) a day.")
                            .foregroundStyle(Self.logoOrange)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .multilineTextAlignment(.center)
            }
            .padding(.horizontal)
            .task {
                let products = await SubscriptionManager.shared.loadProducts()
                if let yearly = products.first(where: { $0.id == SubscriptionManager.yearlyProductID }) {
                    dailyCost = Self.dailyCost(of: yearly)
                }
            }
        }
        .storeButton(.visible, for: .restorePurchases)
        .subscriptionStorePolicyDestination(url: Self.termsURL, for: .termsOfService)
        .subscriptionStorePolicyDestination(url: Self.privacyURL, for: .privacyPolicy)
        .onInAppPurchaseCompletion { _, result in
            guard case .success(.success(let verification)) = result else { return }
            if case .verified(let transaction) = verification {
                await transaction.finish()
            }
            await SubscriptionManager.shared.refresh()
            close()
        }
        // SubscriptionStoreView draws its own close button in a sheet; a second one of ours
        // sat beside it on a device and was removed.
        .onDisappear(perform: gone)
    }
}

extension PaywallView {
    /// The yearly plan spread over its year: $14.99 is about 4¢ a day. Whole cents for a price under a
    /// dollar in US dollars, which is how anyone would say it; the store's own currency format otherwise.
    static func dailyCost(of product: Product) -> String {
        let perDay = product.price / 365
        if product.priceFormatStyle.currencyCode == "USD" {
            let cents = (NSDecimalNumber(decimal: perDay * 100).doubleValue).rounded()
            if cents >= 1 && cents < 100 {
                return "\(Int(cents))¢"
            }
        }
        return perDay.formatted(product.priceFormatStyle)
    }
}

/// Everything that sends a driver to fix or start their subscription, from the page's buttons and
/// from the reminders-are-stopping notices alike.
@MainActor
enum SubscriptionActions {
    private static var presented: UIViewController?

    /// Shows the paywall and returns once it is gone, bought from or not. The caller asks
    /// `ReminderAccess` what happened rather than trusting how the sheet was closed.
    static func showPaywall() async {
        if let presented, presented.presentingViewController != nil { return }
        guard let presenter = topViewController() else { return }

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            var resumed = false
            let finish = {
                guard !resumed else { return }
                resumed = true
                presented = nil
                continuation.resume()
            }

            // Weak: the view holds this closure, and the controller holds the view.
            weak var host: UIHostingController<PaywallView>?
            let view = PaywallView(close: { host?.dismiss(animated: true) }, gone: finish)
            let controller = UIHostingController(rootView: view)
            host = controller
            presented = controller
            presenter.present(controller, animated: true)
        }
    }

    static func open(_ action: AccessNoticePlanner.Action) async {
        switch action {
        case .billing:
            // Apple's own page for the payment method on the Apple ID.
            if let url = URL(string: "https://apps.apple.com/account/billing") {
                await UIApplication.shared.open(url)
            }
        case .manage:
            if let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first {
                try? await AppStore.showManageSubscriptions(in: scene)
            }
            await SubscriptionManager.shared.refresh()
        case .subscribe:
            await showPaywall()
        }
    }

    static func restore() async throws {
        try await AppStore.sync()
        await SubscriptionManager.shared.refresh()
    }

    private static func topViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        var top = windows.first(where: \.isKeyWindow)?.rootViewController
        while let next = top?.presentedViewController {
            top = next
        }
        return top
    }
}
