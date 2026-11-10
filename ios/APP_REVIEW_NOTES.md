# App Review notes

Paste the text below into App Store Connect → App Review Information → Notes for each submission.
Check it against the build before pasting: the paywall trigger and the notification-permission timing
were checked against public/app.js on 2026-10-09 (and the Swift side: no prompt at launch); the sandbox testing
steps were written from AGENTS.md and should be confirmed. The ACCOUNTS AND ACCOUNT DELETION section was added 2026-10-31 after build 13 was rejected under 5.1.1(v); confirm the button labels against the build. The THREE CITIES (Guideline 4.3) and SAN FRANCISCO sections were added 2026-11-09. San Francisco and Minneapolis were already in build 13, which Apple approved, so these sections explain existing behaviour rather than announcing new cities. WHAT IS NEW IN THIS VERSION was rewritten 2026-11-10 for 1.2 (build 15); build 14 (1.1) was never submitted, so 1.2 carries its winter line too. Confirm the switcher wording and the changes listed against the build. The LOCATION section was added 2026-10-30 for build 13, after build 12 was rejected under 5.1.1(iv). Keep it in step with the Terms, Privacy and paywall copy.

```
Denver Curb Alerts helps drivers avoid street-sweeping tickets in Denver and San Francisco, and snow-emergency tickets in Minneapolis.

THREE CITIES, ONE APP (Guideline 4.3)
One app, one codebase, one subscription. Version 1.0 (build 13) already included all three cities. Each has its own data and rules from its own public records:
- Denver: street sweeping routes with left and right sides separated, April to November.
- San Francisco: posted street cleaning windows per block side, including overnight sweeping. It sweeps all year.
- Minneapolis: snow-emergency parking bans (day 1, 2, 3), which apply only when the city declares an emergency. Not sweeping.
The app picks the city from the driver's location, and a header switcher changes it by hand. A driver who travels should not need three apps.

ACCOUNTS AND ACCOUNT DELETION
Accounts are optional (they back up saved curbs). Every screen works signed out, so no demo account is needed.
Create: tap "Sign in" at the top right, choose "Create account", enter any email and a password of 10+ characters.
Delete: tap the account button at the top right (it shows the email), tap "Delete account", enter the password, tap "Delete my account". Deletion is immediate and permanent and removes the account, saved curbs, sessions and push registrations from our server. No website or email is needed.

WHAT IS NEW IN THIS VERSION (1.2)
Small changes to existing screens, no new features or cities:
- The alerts page starts with "Reminders on this device", and the "Turn on reminders" button is larger.
- The plans screen names the driver's city and what a ticket or tow costs there; Minneapolis wording says snow emergencies, not sweeping. The Minneapolis alerts status line likewise.
- When Denver is active and it is December to March, the plans screen shows one line saying Denver's sweeping season is on break and reminders resume in April. San Francisco never shows it. That line is expected.

WHAT IS FREE AND WHAT IS SOLD
The map is free. Reminders are an auto-renewable subscription: yearly (14-day free trial) and monthly. The paywall appears when you tap "Remind me about this curb". Prices come from StoreKit.

HOW TO TEST
1. Tap any colored curb on the map to see its rules.
2. Tap "Remind me about this curb", subscribe in the sandbox, tap "Turn on reminders" and allow notifications.
3. Reminders are local notifications. "Send test now" sends one immediately.
To review San Francisco or Minneapolis, choose it in the header switcher; their maps and rules work at any time. San Francisco uses the same paywall.

MINNEAPOLIS SNOW ALERTS
Snow alerts are push notifications sent only when the City of Minneapolis declares a snow emergency, and a person on our team confirms and sends each one. None is declared outside winter storms, so you will not see one during review; that is normal operation. They are included in the same subscription.

NOTIFICATIONS AND LOCATION
Notification permission is asked only after you tap "Turn on reminders" or "Send test now". Location is optional and never requested at launch: "Find my curb" and "Mark my spot" are the driver's own action and show the standard iOS prompt directly. If declined, the map still works. The parking pin's coordinates stay on the device.

Runs natively on iPhone and iPad. Contact: support@curbalerts.co
```
