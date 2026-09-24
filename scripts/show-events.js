// Prints the anonymous in-app funnel: how many people reached each step between opening the app and
// paying, and what happened each time the plans were shown. See lib/events.js for what is counted.
//
//   npm run events            last 30 days, from the live site
//   npm run events -- 7       last 7 days
//
// Reads GET /api/events, which is behind the admin token like every bulk read, so
// ISSUE_REPORT_ADMIN_TOKEN has to be set here to the same value it has on Render. APP_ORIGIN points it
// somewhere else, e.g. http://127.0.0.1:3000 for a local server. The store half of the funnel
// (impressions, page views, downloads) and trial conversions are in App Store Connect, not here.

const origin = process.env.APP_ORIGIN || "https://www.curbalerts.co";
const token = process.env.ISSUE_REPORT_ADMIN_TOKEN;
const days = Number(process.argv[2]) || 30;

function percent(share) {
  return share === null ? "" : `${Math.round(share * 100)}%`;
}

async function main() {
  if (!token) {
    console.error("Set ISSUE_REPORT_ADMIN_TOKEN to the admin token configured on the server.");
    process.exit(1);
  }

  const response = await fetch(`${origin}/api/events?days=${days}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    console.error(`${origin} answered ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  const { since, rows, funnel } = await response.json();
  console.log(`In-app funnel since ${since} (${origin})\n`);
  console.log("Sessions that...        Count   Of the step before");
  for (const step of funnel.steps) {
    console.log(`${step.event.padEnd(22)} ${String(step.count).padStart(5)}   ${percent(step.ofPrevious)}`);
  }
  console.log("\nOf the sessions that saw the plans");
  for (const outcome of funnel.outcomes) {
    console.log(`${outcome.event.padEnd(22)} ${String(outcome.count).padStart(5)}   ${percent(outcome.ofShown)}`);
  }

  const versions = [...new Set(rows.map((row) => `${row.platform} ${row.appVersion}`))].sort();
  if (versions.length) {
    console.log(`\nFrom: ${versions.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
