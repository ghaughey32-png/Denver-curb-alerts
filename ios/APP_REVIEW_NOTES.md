# App Review notes

Paste the text below into App Store Connect → App Review Information → Notes for each submission.
Check it against the build before pasting: the paywall trigger and the notification-permission timing
were checked against public/app.js on 2026-10-09 (the Swift prompt was not read); the sandbox testing
steps were written from AGENTS.md and should be confirmed. Keep it in step with the Terms, Privacy and paywall copy.

```
Denver Curb Alerts helps drivers avoid street-sweeping tickets in Denver and snow-emergency tickets in Minneapolis.

NO SIGN-IN REQUIRED
Accounts are optional. Every screen works signed out, so no demo account is needed.

WHAT IS FREE AND WHAT IS SOLD
The map is free. Reminders are sold by auto-renewable subscription: yearly (14-day free trial) and monthly. The paywall appears when you tap "Remind me about this curb". Prices are shown by StoreKit.

HOW TO TEST
1. Open the map and tap any colored curb to see its sweeping rules.
2. Tap "Remind me about this curb" to reach the paywall, then subscribe in the sandbox. Tap "Turn on reminders" when prompted and allow notifications.
3. Reminders are scheduled on the device as local notifications. "Send test now" sends a test notification immediately.

MINNEAPOLIS SNOW EMERGENCIES
The city switcher in the header changes the map to Minneapolis. The curb map and rules there work at any time and can be reviewed now.
Snow alerts are push notifications sent only when the City of Minneapolis declares a snow emergency, and a person on our team confirms and sends each declaration. No emergency is declared outside winter storms, so you will not see a snow alert during review, and none is expected. This is normal operation, not a missing feature. Snow alerts are included with the same subscription as reminders.

NOTIFICATIONS
We use notifications for reminders the device schedules locally, and for snow-emergency alerts sent through Apple Push Notification service. The app asks for notification permission only after you tap "Turn on reminders".

DEVICES
Runs natively on iPhone and iPad, in all iPad orientations.

CONTACT
support@curbalerts.co
```
