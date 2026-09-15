import CoreLocation
import Foundation

/// "Use my location" for the page, answered by Core Location.
///
/// The page is served off `curbalerts://`, which WebKit does not treat as a secure context, so
/// `navigator.geolocation` never works inside the app no matter what the user allows. Confirmed on
/// a device on 2026-09-15: the button simply failed. The page asks the bridge instead, and the app
/// asks iOS directly, with its own "While Using the App" prompt.
@MainActor
final class LocationProvider: NSObject, CLLocationManagerDelegate {
    static let shared = LocationProvider()

    // The page shows these messages as they are, so they are written for the driver. Core Location's
    // own errors read like "kCLErrorDomain error 0" and never reach the page.
    enum LocationError: LocalizedError {
        case denied
        case unavailable

        var errorDescription: String? {
            switch self {
            case .denied:
                return "Location is turned off for Curb Alerts. Turn it on in Settings > Privacy & Security > Location Services."
            case .unavailable:
                return "We couldn't find your location just now. Try again in a moment, or move around the map manually."
            }
        }
    }

    private let manager = CLLocationManager()
    private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []
    private var locationWaiters: [CheckedContinuation<CLLocation, Error>] = []

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    func currentLocation() async throws -> CLLocation {
        if manager.authorizationStatus == .notDetermined {
            await withCheckedContinuation { continuation in
                authorizationWaiters.append(continuation)
                manager.requestWhenInUseAuthorization()
            }
        }

        switch manager.authorizationStatus {
        case .denied, .restricted:
            throw LocationError.denied
        default:
            break
        }

        // Two taps while a fix is in flight share the one request rather than starting a second.
        return try await withCheckedThrowingContinuation { continuation in
            locationWaiters.append(continuation)
            if locationWaiters.count == 1 {
                manager.requestLocation()
            }
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            // The delegate is told the current status as soon as it is assigned, which is still
            // "not determined" before the prompt has been answered. Only a real answer wakes anyone.
            guard self.manager.authorizationStatus != .notDetermined else { return }
            let waiters = authorizationWaiters
            authorizationWaiters.removeAll()
            waiters.forEach { $0.resume() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        Task { @MainActor in finish(.success(location)) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in finish(.failure(denied ? LocationError.denied : LocationError.unavailable)) }
    }

    private func finish(_ result: Result<CLLocation, Error>) {
        let waiters = locationWaiters
        locationWaiters.removeAll()
        waiters.forEach { $0.resume(with: result) }
    }
}
