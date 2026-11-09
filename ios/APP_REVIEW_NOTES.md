# App Review notes

Paste the text below into App Store Connect → App Review Information → Notes for each submission.
Check it against the build before pasting: the paywall trigger and the notification-permission timing
were checked against public/app.js on 2026-10-09 (and the Swift side: no prompt at launch); the sandbox testing
steps were written from AGENTS.md and should be confirmed. The ACCOUNTS AND ACCOUNT DELETION section was added 2026-10-31 after build 13 was rejected under 5.1.1(v); confirm the button labels against the build. The THREE CITIES (Guideline 4.3) and SAN FRANCISCO sections were added 2026-11-09 for version 1.1 (build 14). San Francisco and Minneapolis were already in build 13, which Apple approved, so these sections explain existing behaviour rather than announcing new cities; the only app change in 1.1 is the winter line on the paywall. Confirm the switcher wording and that line against the build. The LOCATION section was added 2026-10-30 for build 13, after build 12 was rejected under 5.1.1(iv). Keep it in step with the Terms, Privacy and paywall copy.

```
Denver Curb Alerts helps drivers avoid street-sweeping tickets in Denver and San Francisco, and snow-emergency tickets in Minneapolis.

THREE CITIES, ONE APP (Guideline 4.3)
This is one app with one codebase and one subscription, not the same app repeated per city. The previous version (1.0, build 13) already included all three cities. Each city has its own data and its own rules, built from that city's own public records:
- Denver: the city's street sweeping routes, with left and right sides of each street separated, sweeping dates, and a schedule that only runs April to November.
- San Francisco: the city's posted street cleaning windows per block side, including overnight sweeping (remind the evening before) and 5th-week days the schedule does not confirm. San Francisco sweeps all year.
- Minneapolis: snow-emergency parking bans, which are not sweeping at all. They are day 1, 2 and 3 rules that apply only when the city declares an emergency.
The app picks the city from the driver's location, and a switcher in the header changes it by hand. We did not publish a separate app per city, because the map, reminders and subscription are shared and a driver who travels between cities should not need three apps.

ACCOUNTS AND ACCOUNT DELETION
Accounts are optional (they back up saved curbs across devices). Every screen works signed out, so no demo account is needed.
To create an account: tap the "Sign in" button at the top right of the header, choose "Create account", enter any email and a password of 10+ characters.
To delete it: tap the account button at the top right (it now shows the email), then tap "Delete account", enter the password, and tap "Delete my account". Deletion is immediate and permanent: it removes the account, saved curb sets, sessions and push registrations from our server. No website or email is needed. The screen recording is attached to the reply to App Review.

WHAT IS FREE AND WHAT IS SOLD
The map is free. Reminders are sold by auto-renewable subscription: yearly (14-day free trial) and monthly. The paywall appears when you tap "Remind me about this curb". Prices are shown by StoreKit.

HOW TO TEST
1. Open the map and tap any colored curb to see its sweeping rules.
2. Tap "Remind me about this curb" to reach the paywall, then subscribe in the sandbox. Tap "Turn on reminders" when prompted and allow notifications.
3. Reminders are scheduled on the device as local notifications. "Send test now" sends a test notification immediately.

SAN FRANCISCO
Use the city switcher in the header to choose San Francisco. The curb map and posted sweeping windows work at any time and can be reviewed now. Tapping a curb shows its sweeping schedule; "Remind me about this curb" uses the same paywall and subscription as Denver. San Francisco sweeps all year, so reminders there have no off-season. WHAT IS NEW IN THIS VERSION: when Denver is the active city and it is December to March, the plans screen shows one line saying Denver's sweeping season is on break and reminders resume in April. San Francisco never shows it. Nothing else in the app changed. That line is expected, not a fault.

MINNEAPOLIS SNOW EMERGENCIES
The city switcher in the header changes the map to Minneapolis. The curb map and rules there work at any time and can be reviewed now.
Snow alerts are push notifications sent only when the City of Minneapolis declares a snow emergency, and a person on our team confirms and sends each declaration. No emergency is declared outside winter storms, so you will not see a snow alert during review, and none is expected. This is normal operation, not a missing feature. Snow alerts are included with the same subscription as reminders.

NOTIFICATIONS
We use notifications for reminders the device schedules locally, and for snow-emergency alerts sent through Apple Push Notification service. The app asks for notification permission only after you tap "Turn on reminders" or "Send test now".

LOCATION
Location is optional and is never requested at launch. The "Find my curb" and "Mark my spot" buttons on the map are the driver's own action; tapping one shows the standard iOS location prompt directly, with no custom screen in front of it. If the driver declines, the map still works and they can search an address or tap a curb. The parking pin's coordinates stay on the device.

DEVICES
Runs natively on iPhone and iPad, in all iPad orientations.

CONTACT
support@curbalerts.co
```
