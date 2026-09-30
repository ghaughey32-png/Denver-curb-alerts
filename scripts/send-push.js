// Sends one alert, through Apple push, to the iPhones it is relevant to. See lib/apns.js.
//
// Every send names its audience; there is no default:
//
//   --curbs=<id>,<id>        phones with a reminder on any of these curbs ("<way>:<side>")
//   --curbs-file=<path>      the same, from a file of ids, one per line or a JSON array
//   --everyone               every phone - only for a message that genuinely concerns everybody
//
//   npm run push -- "Title" "Body" --curbs-file=day1.txt           count who would get it, send nothing
//   npm run push -- "Title" "Body" --curbs-file=day1.txt --send    send it
//   add --urgent to send it through Focus modes (time sensitive), --token=<hex> for one phone only
//
// Counting is the default because a sent alert cannot be taken back.
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
const flagValue = (name) => (flags.find((flag) => flag.startsWith(`--${name}=`)) || "").slice(name.length + 3);

function readCurbIds() {
  const ids = flagValue("curbs").split(",");
  const file = flagValue("curbs-file");
  if (file) {
    const text = require("node:fs").readFileSync(file, "utf8").trim();
    ids.push(...(text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/)));
  }
  return ids.map((id) => String(id).trim()).filter(Boolean);
}

async function main() {
  if (!adminToken) {
    console.error("Set ISSUE_REPORT_ADMIN_TOKEN to the admin token configured on the server.");
    process.exit(1);
  }
  const curbIds = readCurbIds();
  const everyone = flags.includes("--everyone");
  if (!title || !body || everyone === Boolean(curbIds.length)) {
    console.error('Usage: npm run push -- "Title" "Body" (--curbs=<ids> | --curbs-file=<path> | --everyone)');
    console.error("       [--send] [--urgent] [--token=<hex>] [--url=/path]");
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
      ...(everyone ? { everyone: true } : { curbIds }),
      ...(tokens.length ? { tokens } : {})
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`${origin} answered ${response.status}: ${result.error || ""} ${result.details || ""}`.trim());
    process.exit(1);
  }

  if (result.dryRun) {
    const audience = everyone ? "every iPhone" : `the phones watching any of ${curbIds.length} curb(s)`;
    console.log(`Would send to ${result.deviceCount} iPhone(s), ${audience}, via ${origin}. Nothing sent; add --send.`);
    return;
  }

  console.log(`Sent ${result.sent} of ${result.deviceCount}. Failed ${result.failed}. Removed ${result.removed} uninstalled.`);
  for (const [reason, count] of Object.entries(result.errors || {})) {
    console.log(`  ${reason}: ${count}`);
  }
  // The one refusal that has already cost a day: a key's environment is fixed when it is created.
  if (result.errors?.BadEnvironmentKeyInToken) {
    console.log("\nThe APNs key on the server is not enabled for this environment. A key's environment cannot be");
    console.log("changed after it is created: make a new one as Sandbox & Production, Team Scoped, and put it on Render.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
