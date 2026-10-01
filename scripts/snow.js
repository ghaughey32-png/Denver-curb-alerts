// Declares or cancels a snow emergency, through the server's admin route. See lib/snow.js.
//
//   npm run snow -- declare --day1=2026-12-10            print the timeline and who it reaches, send nothing
//   npm run snow -- declare --day1=2026-12-10 --send     declare it: the first alert goes out now, the rest on schedule
//   npm run snow -- cancel [--send]                      tell the phones that were told, and stop the timeline
//   npm run snow -- status                               what the server thinks is active
//   add --token=<hex> to declare for one phone only, to try it end to end
//
// Declaring is the only thing that ever starts an emergency, and it is a person's decision. Counting
// is the default because a sent alert cannot be taken back. Like `npm run push`, ISSUE_REPORT_ADMIN_TOKEN
// has to be set here to the value it has on the server, and APP_ORIGIN points it somewhere else.

const origin = process.env.APP_ORIGIN || "https://www.curbalerts.co";
const adminToken = process.env.ISSUE_REPORT_ADMIN_TOKEN;

const args = process.argv.slice(2);
const [command] = args.filter((arg) => !arg.startsWith("--"));
const flags = args.filter((arg) => arg.startsWith("--"));
const flagValue = (name) => (flags.find((flag) => flag.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const send = flags.includes("--send");
const city = flagValue("city") || "minneapolis";
const tokens = flags.filter((flag) => flag.startsWith("--token=")).map((flag) => flag.slice("--token=".length));

function printTimeline(timeline) {
  for (const step of timeline) {
    const local = new Date(step.at).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
    console.log(`  ${step.state.padEnd(8)} ${local}  ${step.id.padEnd(13)} ${step.audienceCount} phone(s)${step.lapsedCount ? `, plus ${step.lapsedCount} told their alerts are off` : ""}`);
  }
}

async function main() {
  if (!["declare", "cancel", "status"].includes(command)) {
    console.error("Usage: npm run snow -- declare --day1=YYYY-MM-DD [--send] [--token=<hex>] [--city=minneapolis]");
    console.error("       npm run snow -- cancel [--send]");
    console.error("       npm run snow -- status");
    process.exit(1);
  }

  if (command === "status") {
    const result = await (await fetch(`${origin}/api/snow-emergency?city=${encodeURIComponent(city)}`)).json();
    console.log(result.active ? `Active for ${result.emergency.day1Date}, declared ${result.emergency.declaredAt}.` : `No active snow emergency for ${city}.`);
    return;
  }

  if (!adminToken) {
    console.error("Set ISSUE_REPORT_ADMIN_TOKEN to the admin token configured on the server.");
    process.exit(1);
  }

  const day1Date = flagValue("day1");
  if (command === "declare" && !day1Date) {
    console.error("declare needs --day1=YYYY-MM-DD, the day Day 1 begins.");
    process.exit(1);
  }

  const response = await fetch(`${origin}/api/snow-emergency`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action: command, city, day1Date, dryRun: !send, ...(tokens.length ? { tokens } : {}) })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`${origin} answered ${response.status}: ${result.error || ""} ${result.details || ""}`.trim());
    process.exit(1);
  }

  if (result.alreadyActive) {
    console.log(`Already active for ${result.emergency.day1Date}; nothing changed.`);
    return;
  }

  if (command === "declare") {
    console.log(result.dryRun ? `Would declare Day 1 on ${day1Date} via ${origin}. Nothing sent; add --send.` : `Declared Day 1 on ${day1Date}.`);
    printTimeline(result.timeline);
    for (const step of result.sent || []) {
      console.log(`Sent ${step.id}: ${step.sent} of ${step.deviceCount}, failed ${step.failed}, removed ${step.removed}.`);
    }
    return;
  }

  console.log(
    result.dryRun
      ? `Would tell ${result.deviceCount} phone(s) the emergency is cancelled via ${origin}. Nothing sent; add --send.`
      : `Cancelled. Sent ${result.sent} of ${result.deviceCount}. Failed ${result.failed}. Removed ${result.removed}.`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
