import SwiftUI
import UIKit
import WebKit

struct WebShellView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        WebShell.shared.webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// The one web view, and both directions of the bridge to the page inside it.
///
/// Page to app: `window.DenverCurbAlertsNative`, whose contract lives beside
/// `getNativeReminderBridge` in public/app.js and under "Shipping on iOS" in AGENTS.md.
/// App to page: a `curb-alerts-native` DOM event, for things that happen on the lock screen.
@MainActor
final class WebShell: NSObject {
    static let shared = WebShell()
    static let scheme = "curbalerts"
    static let startURL = URL(string: "curbalerts://app/index.html")!
    private static let messageHandlerName = "curbAlerts"
    private static let appVersion: String = {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(version) (\(build))"
    }()

    let webView: WKWebView
    private var hasStartedLoading = false
    private var pageLoaded = false
    private var pendingEvents: [[String: Any]] = []
    private var lastPermission = "default"

    private override init() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(BundledWebSchemeHandler(), forURLScheme: Self.scheme)
        configuration.websiteDataStore = .default()
        configuration.userContentController = WKUserContentController()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.957, green: 0.937, blue: 0.902, alpha: 1)
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
        // Safari > Develop > Simulator can attach to the page in debug builds.
        webView.isInspectable = true
        #endif
        super.init()
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: Self.messageHandlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
    }

    func loadIfNeeded() async {
        guard !hasStartedLoading else { return }
        hasStartedLoading = true
        await installBridgeScript()
        webView.load(URLRequest(url: Self.startURL))
    }

    /// Events wait for the page. A cold launch from a reminder tap arrives before the page exists,
    /// and dropping it would lose exactly the tap that launched the app.
    func dispatch(_ detail: [String: Any]) {
        guard pageLoaded else {
            pendingEvents.append(detail)
            return
        }

        guard let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('curb-alerts-native', { detail: \(json) }));",
            completionHandler: nil
        )
    }

    /// Notification permission can change in Settings while the app is in the background. The page
    /// reads `bridge.permission` synchronously, so the property has to be kept current from here.
    func refreshPermission() async {
        let permission = await ReminderScheduler.shared.permission()
        guard permission != lastPermission else { return }
        lastPermission = permission
        guard pageLoaded else { return }

        webView.evaluateJavaScript(
            "if (window.DenverCurbAlertsNative) { window.DenverCurbAlertsNative.permission = \"\(permission)\"; }",
            completionHandler: nil
        )
        dispatch(["type": "permission-changed", "permission": permission])
    }

    private func installBridgeScript() async {
        let permission = await ReminderScheduler.shared.permission()
        let movedSweepKeys = await ReminderScheduler.shared.movedSweepKeys()
        lastPermission = permission

        let initial: [String: Any] = [
            "permission": permission,
            "movedSweepKeys": movedSweepKeys,
            "subscription": ReminderStore().access.bridgeValue,
            // "1.0 (9)": groups the anonymous funnel counts by build, so a change can be compared
            // with the one before it.
            "appVersion": Self.appVersion
        ]
        let json = (try? JSONSerialization.data(withJSONObject: initial)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let source = Self.bridgeSource.replacingOccurrences(of: "__INITIAL_STATE__", with: json)

        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    private func presentingViewController() -> UIViewController? {
        let windows = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
        var top = windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }

    // Plain ES5 on purpose: it runs before app.js, in every page load, and must not be the thing
    // that fails. postMessage on a reply-capable handler returns a promise of the native reply.
    private static let bridgeSource = """
    (function () {
      "use strict";
      var initial = __INITIAL_STATE__;
      var handler = window.webkit.messageHandlers.\(messageHandlerName);
      function call(action, payload) {
        return handler.postMessage({ action: action, payload: payload || {} });
      }
      var bridge = {
        platform: "ios",
        permission: initial.permission,
        movedSweepKeys: initial.movedSweepKeys,
        subscription: initial.subscription,
        appVersion: initial.appVersion,
        showPaywall: function () {
          return call("showPaywall").then(function (subscription) {
            bridge.subscription = subscription;
            return subscription;
          });
        },
        manageSubscription: function (kind) {
          return call("manageSubscription", { kind: kind || "manage" });
        },
        restorePurchases: function () {
          return call("restorePurchases").then(function (subscription) {
            bridge.subscription = subscription;
            return subscription;
          });
        },
        requestPermission: function () {
          return call("requestPermission").then(function (permission) {
            bridge.permission = permission;
            return permission;
          });
        },
        scheduleReminders: function (jobs, options) {
          return call("scheduleReminders", {
            jobs: jobs || [],
            movedSweepKeys: (options && options.movedSweepKeys) || []
          });
        },
        showTestNotification: function (notification) {
          return call("showTestNotification", notification || {});
        },
        getCurrentPosition: function () {
          return call("getCurrentPosition");
        },
        getSessionToken: function () {
          return call("getSessionToken");
        },
        setSessionToken: function (token) {
          return call("setSessionToken", { token: token });
        },
        clearSessionToken: function () {
          return call("clearSessionToken");
        }
      };
      // Kept current before the page's own listener runs, since this one is registered first.
      window.addEventListener("curb-alerts-native", function (event) {
        var detail = event.detail || {};
        if (detail.type === "subscription-changed" && detail.subscription) {
          bridge.subscription = detail.subscription;
        }
      });
      window.DenverCurbAlertsNative = bridge;
    })();
    """
}

extension WebShell: WKScriptMessageHandlerWithReply {
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else {
            return (nil, "Malformed message from the page.")
        }
        let payload = body["payload"] as? [String: Any] ?? [:]

        do {
            switch action {
            case "requestPermission":
                let permission = try await ReminderScheduler.shared.requestPermission()
                lastPermission = permission
                return (permission, nil)

            case "scheduleReminders":
                let data = try JSONSerialization.data(withJSONObject: payload["jobs"] ?? [])
                let jobs = try JSONDecoder().decode([ReminderJob].self, from: data)
                let movedSweepKeys = payload["movedSweepKeys"] as? [String] ?? []
                try await ReminderScheduler.shared.replaceSchedule(jobs: jobs, movedSweepKeys: movedSweepKeys)
                return (jobs.count, nil)

            case "showTestNotification":
                try await ReminderScheduler.shared.showTestNotification(
                    title: payload["title"] as? String ?? "Curb Alerts",
                    body: payload["body"] as? String ?? "This is what a sweeping reminder looks like."
                )
                LiveActivityScheduler.startTestCard()
                return (true, nil)

            case "showPaywall":
                await SubscriptionActions.showPaywall()
                return (await SubscriptionManager.shared.refresh().bridgeValue, nil)

            case "manageSubscription":
                let kind = payload["kind"] as? String
                await SubscriptionActions.open(kind == "billing" ? .billing : .manage)
                return (true, nil)

            case "restorePurchases":
                try await SubscriptionActions.restore()
                return (ReminderStore().access.bridgeValue, nil)

            case "getSessionToken":
                if let token = SessionKeychain.read() {
                    return (token, nil)
                }
                return (nil, nil)

            case "setSessionToken":
                guard let token = payload["token"] as? String, !token.isEmpty else {
                    return (nil, "No session token to save.")
                }
                try SessionKeychain.write(token)
                return (true, nil)

            case "clearSessionToken":
                SessionKeychain.delete()
                return (true, nil)

            case "getCurrentPosition":
                let location = try await LocationProvider.shared.currentLocation()
                return ([
                    "latitude": location.coordinate.latitude,
                    "longitude": location.coordinate.longitude,
                    "accuracy": location.horizontalAccuracy
                ], nil)

            default:
                return (nil, "Unknown request from the page: \(action).")
            }
        } catch {
            // The page treats a rejection as "not scheduled" and retries on its next render, which is
            // the behaviour wanted: a schedule the device refused must never read as a working one.
            return (nil, error.localizedDescription)
        }
    }
}

extension WebShell: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }

        if url.scheme == Self.scheme || url.scheme == "about" || navigationAction.targetFrame?.isMainFrame == false {
            return .allow
        }

        // Anything leaving the bundle - Denver's site, a mailto: link, the Terms on the web - opens in
        // the system app for it rather than replacing the app's only page.
        await UIApplication.shared.open(url)
        return .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        let events = pendingEvents
        pendingEvents.removeAll()
        events.forEach(dispatch)
    }

    // iOS reclaims a backgrounded web view's content process under memory pressure, leaving a blank
    // page. Reload with a fresh bridge script so the confirmed sweeps it carries are current.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageLoaded = false
        Task {
            await installBridgeScript()
            webView.load(URLRequest(url: Self.startURL))
        }
    }
}

extension WebShell: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            UIApplication.shared.open(url)
        }
        return nil
    }

    // A WKWebView with no UI delegate answers alert() instantly and confirm() with false, so any
    // "are you sure?" in the page would silently refuse. These give the page real dialogs.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        guard let presenter = presentingViewController() else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume() })
            presenter.present(alert, animated: true)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        guard let presenter = presentingViewController() else { return false }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in continuation.resume(returning: true) })
            presenter.present(alert, animated: true)
        }
    }
}
