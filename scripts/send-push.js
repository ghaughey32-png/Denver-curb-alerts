// Sends one alert to every iPhone with the app installed, through Apple push. See lib/apns.js.
//
//   npm run push -- "Title" "Body"                   count who would get it, send nothing
//   npm run push -- "Title" "Body" --send            send it
//   npm run push -- "Title" "Body" --send --urgent   send it through Focus modes (time sensitive)
//   npm run push -- "Title" "Body" --send --token=<hex>   one phone only, for testing
//
// Counting is the default because this reaches every user at once and cannot be taken back.
// Reads POST /api/push/broadcast, behind the admin token like every bulk operation, so
// ISSUE_REPORT_ADMIN_TOKEN has to be set here to the same value it has on Render. APP_ORIGIN points
// it somewhere else, e.g. http://127.0.0.1:3000 for a local server.

const origin = process.env.APP_ORIGIN || "https://www.curbalerts.co";
const adminToken = process.env.ISSUE_REPORT_ADMIN_TOKEN;

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--"));
const [title, body] = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const send = flags.includes("--send");
const tokens = flags.filter((flag) => flag.startsWith("--token=")).map((flag) => flag.slice("--token=".length));
const url = (flags.find((flag) => flag.startsWith("--url=")) || "--url=/").slice("--url=".length);

async function main() {
  if (!adminToken) {
    console.error("Set ISSUE_REPORT_ADMIN_TOKEN to the admin token configured on the server.");
    process.exit(1);
  }
  if (!title || !body) {
    console.error('Usage: npm run push -- "Title" "Body" [--send] [--urgent] [--token=<hex>] [--url=/path]');
    process.exit(1);
  }

  const response = await fetch(`${origin}/api/push/broadcast`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      body,
      url,
      timeSensitive: flags.includes("--urgent"),
      dryRun: !send,
      ...(tokens.length ? { tokens } : {})
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`${origin} answered ${response.status}: ${result.error || ""} ${result.details || ""}`.trim());
    process.exit(1);
  }

  if (result.dryRun) {
    console.log(`Would send to ${result.deviceCount} iPhone(s) via ${origin}. Nothing sent; add --send to send it.`);
    return;
  }

  console.log(`Sent ${result.sent} of ${result.deviceCount}. Failed ${result.failed}. Removed ${result.removed} uninstalled.`);
  for (const [reason, count] of Object.entries(result.errors || {})) {
    console.log(`  ${reason}: ${count}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
