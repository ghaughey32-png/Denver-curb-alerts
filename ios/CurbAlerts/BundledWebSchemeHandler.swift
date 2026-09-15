import Foundation
import UniformTypeIdentifiers
import WebKit

/// Serves the copy of `public/` that the "Bundle web app" build phase puts in the app, at
/// `curbalerts://app/...`. Serving from the bundle rather than loading the website means the 12 MB
/// inventory is on the phone from the first launch - no cold fetch over a weak mobile connection,
/// which is the failure the service worker's cache-first rule exists to paper over on the web.
final class BundledWebSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL? = Bundle.main.resourceURL?
        .appendingPathComponent("web", isDirectory: true)
        .standardizedFileURL

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let requestURL = urlSchemeTask.request.url, let root else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        // The query string is the web client's cache-busting "?v=" tag. The bundle holds exactly one
        // version of every file, so it has nothing to select and is ignored.
        let path = requestURL.path.isEmpty || requestURL.path == "/" ? "index.html" : String(requestURL.path.dropFirst())
        let fileURL = root.appendingPathComponent(path).standardizedFileURL

        guard fileURL.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
            respond(urlSchemeTask, url: requestURL, status: 404, mimeType: "text/plain", data: Data())
            return
        }

        respond(urlSchemeTask, url: requestURL, status: 200, mimeType: Self.mimeType(for: fileURL), data: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Every response is written synchronously in start, so there is never anything to cancel.
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, mimeType: String, data: Data) {
        let headers = [
            "Content-Type": mimeType,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache"
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private static func mimeType(for fileURL: URL) -> String {
        switch fileURL.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        case "svg": return "image/svg+xml"
        default:
            return UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        }
    }
}
