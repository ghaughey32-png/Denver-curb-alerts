import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The web app's palette, so the card reads as the same product as the banner it mirrors.
private enum Palette {
    static let accent = Color(red: 0.706, green: 0.365, blue: 0.165)
    static let ink = Color(red: 0.122, green: 0.184, blue: 0.216)
    static let muted = Color(red: 0.384, green: 0.447, blue: 0.482)
    static let cream = Color(red: 0.984, green: 0.973, blue: 0.949)
    static let green = Color(red: 0.184, green: 0.490, blue: 0.243)
}

struct SweepLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SweepActivityAttributes.self) { context in
            SweepLockScreenView(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Palette.cream)
                .activitySystemActionForegroundColor(Palette.ink)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.state.moved ? "checkmark.circle.fill" : "car.fill")
                        .font(.title2)
                        .foregroundStyle(context.state.moved ? Palette.green : Palette.accent)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.state.moved ? "Car moved" : context.attributes.isTestCard ? "Test: Move your car today" : "Move your car today")
                            .font(.headline)
                        Text(context.attributes.curbSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if !context.state.moved {
                        MovedCarButton(sweepKey: context.attributes.sweepKey)
                    }
                }
            } compactLeading: {
                Image(systemName: context.state.moved ? "checkmark.circle.fill" : "car.fill")
                    .foregroundStyle(context.state.moved ? Palette.green : Palette.accent)
            } compactTrailing: {
                Text(context.state.moved ? "Moved" : "Move")
                    .font(.caption.weight(.bold))
            } minimal: {
                Image(systemName: context.state.moved ? "checkmark" : "car.fill")
                    .foregroundStyle(context.state.moved ? Palette.green : Palette.accent)
            }
            .keylineTint(Palette.accent)
        }
    }
}

private struct SweepLockScreenView: View {
    let attributes: SweepActivityAttributes
    let state: SweepActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: state.moved ? "checkmark.circle.fill" : "car.fill")
                    .font(.title)
                    .foregroundStyle(state.moved ? Palette.green : Palette.accent)

                VStack(alignment: .leading, spacing: 2) {
                    Text(state.moved ? "NICE WORK" : attributes.isTestCard ? "TEST CARD - STREET SWEEPING TODAY" : "STREET SWEEPING TODAY")
                        .font(.caption2.weight(.heavy))
                        .foregroundStyle(state.moved ? Palette.green : Palette.accent)
                    Text(state.moved ? "Car moved. That's it for this sweep." : "Move your car")
                        .font(.headline)
                        .foregroundStyle(Palette.ink)
                    Text(attributes.curbSummary)
                        .font(.subheadline)
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }

            if !state.moved {
                MovedCarButton(sweepKey: attributes.sweepKey)
            }
        }
        .padding(16)
    }
}

private struct MovedCarButton: View {
    let sweepKey: String

    var body: some View {
        Button(intent: MovedCarIntent(sweepKey: sweepKey)) {
            Text("I moved my car")
                .font(.headline)
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(Palette.accent)
    }
}
