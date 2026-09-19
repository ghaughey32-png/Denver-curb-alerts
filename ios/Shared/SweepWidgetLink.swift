import Foundation

/// The URL a tap on the home-screen widget opens the app with. It wraps the page path the reminder
/// jobs already carry (`/?moved=<sweep key>`), so the app hands the page exactly what it hands it
/// when a reminder is tapped.
///
/// The host is `widget`, not `app`: `curbalerts://app/...` is what the web view loads its own files
/// from, and keeping the two apart means nothing here can be mistaken for a page request.
enum SweepWidgetLink {
    static let scheme = "curbalerts"
    static let host = "widget"

    static func url(forPagePath path: String?) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.path = "/open"
        components.queryItems = [URLQueryItem(name: "path", value: path ?? "/")]
        return components.url ?? URL(string: "\(scheme)://\(host)/open")!
    }

    /// Only a same-page path is passed on; anything else falls back to the page root.
    static func pagePath(from url: URL) -> String {
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "path" }?.value ?? "/"
        return path.hasPrefix("/") && !path.hasPrefix("//") ? path : "/"
    }
}
