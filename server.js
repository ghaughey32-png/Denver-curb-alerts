const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const zlib = require("node:zlib");

const accounts = require("./lib/accounts.js");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
// Overridable so test/accounts.test.js can stand a real server up against a throwaway directory
// instead of writing accounts and sessions into the working copy. Unset everywhere else.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DATABASE_URL = process.env.DATABASE_URL || "";
const ISSUE_REPORT_ADMIN_TOKEN = process.env.ISSUE_REPORT_ADMIN_TOKEN || "";
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "subscriptions.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const REMINDER_PLANS_FILE = path.join(DATA_DIR, "reminder-plans.json");
const ISSUE_REPORTS_FILE = path.join(DATA_DIR, "issue-reports.json");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const DENVER_API_BASE = "https://www.denvergov.org/api/";
const REMINDER_DISPATCH_INTERVAL_MS = 60 * 1000;
const COLLECTION_KEYS = {
  subscriptions: "subscriptions",
  pushSubscriptions: "push-subscriptions",
  reminderPlans: "reminder-plans",
  issueReports: "issue-reports",
  accounts: "accounts",
  sessions: "sessions"
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

let databasePool = null;
let databaseSchemaReady = false;
let databaseEnabled = Boolean(DATABASE_URL);
let storageBackend = databaseEnabled ? "database" : "file";

// A session cookie will not travel on a wildcard origin, and it must not: the CORS spec makes
// Access-Control-Allow-Origin: * and Allow-Credentials mutually exclusive precisely so that a
// public API cannot be talked into acting as a logged-in user. The map's read-only endpoints stay
// open to anyone, and a request from an origin we actually run on gets that origin echoed with
// credentials allowed instead. Adding an origin here grants it the ability to act as a signed-in
// user from the browser, so add only origins this app is served from.
const CREDENTIALED_ORIGINS = new Set([
  "https://denver-curb-alerts-2.onrender.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]);

function setApiCorsHeaders(request, response) {
  const origin = String(request.headers.origin || "");

  if (origin && CREDENTIALED_ORIGINS.has(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader("Vary", "Origin");
  } else {
    response.setHeader("Access-Control-Allow-Origin", "*");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

// Reads that return other people's data. The token is optional in the environment and absent by
// default, which means these listings are closed unless an operator deliberately opens them.
function hasAdminAccess(request) {
  if (!ISSUE_REPORT_ADMIN_TOKEN) {
    return false;
  }

  const authorization = request.headers.authorization || "";
  return authorization === `Bearer ${ISSUE_REPORT_ADMIN_TOKEN}`;
}

function hasIssueReportAdminAccess(request) {
  return hasAdminAccess(request);
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function ensureJsonFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(filePath, "[]\n", "utf8");
  }
}

async function ensureDataFiles() {
  await Promise.all([
    ensureJsonFile(SUBSCRIPTIONS_FILE),
    ensureJsonFile(PUSH_SUBSCRIPTIONS_FILE),
    ensureJsonFile(REMINDER_PLANS_FILE),
    ensureJsonFile(ISSUE_REPORTS_FILE),
    ensureJsonFile(ACCOUNTS_FILE),
    ensureJsonFile(SESSIONS_FILE)
  ]);
}

function isDatabaseConfigured() {
  return databaseEnabled;
}

function getPgLibrary() {
  try {
    return require("pg");
  } catch {
    return null;
  }
}

function getDatabasePool() {
  if (!isDatabaseConfigured()) {
    return null;
  }

  if (!databasePool) {
    const pg = getPgLibrary();
    if (!pg) {
      throw new Error("DATABASE_URL is set, but the pg package is not installed.");
    }

    databasePool = new pg.Pool({
      connectionString: DATABASE_URL
    });
  }

  return databasePool;
}

async function ensureDatabaseSchema() {
  if (!isDatabaseConfigured() || databaseSchemaReady) {
    return;
  }

  const pool = getDatabasePool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_collections (
      name TEXT PRIMARY KEY,
      items JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await Promise.all(
    Object.values(COLLECTION_KEYS).map((name) =>
      pool.query(
        `
          INSERT INTO app_collections (name, items)
          VALUES ($1, '[]'::jsonb)
          ON CONFLICT (name) DO NOTHING
        `,
        [name]
      )
    )
  );

  databaseSchemaReady = true;
}

async function readCollectionFromFile(filePath) {
  await ensureJsonFile(filePath);
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeCollectionToFile(filePath, items) {
  await fs.writeFile(filePath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

async function readCollectionFromDatabase(name) {
  await ensureDatabaseSchema();
  const pool = getDatabasePool();
  const result = await pool.query("SELECT items FROM app_collections WHERE name = $1", [name]);

  if (!result.rows[0]) {
    return [];
  }

  return Array.isArray(result.rows[0].items) ? result.rows[0].items : [];
}

async function writeCollectionToDatabase(name, items) {
  await ensureDatabaseSchema();
  const pool = getDatabasePool();
  await pool.query(
    `
      INSERT INTO app_collections (name, items, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (name)
      DO UPDATE SET
        items = EXCLUDED.items,
        updated_at = NOW()
    `,
    [name, JSON.stringify(items)]
  );
}

async function maybeMigrateFileCollectionToDatabase(name, filePath) {
  const existingItems = await readCollectionFromDatabase(name);
  if (existingItems.length > 0) {
    return;
  }

  const fileItems = await readCollectionFromFile(filePath);
  if (fileItems.length === 0) {
    return;
  }

  await writeCollectionToDatabase(name, fileItems);
}

async function initStorage() {
  if (!isDatabaseConfigured()) {
    await ensureDataFiles();
    storageBackend = "file";
    return;
  }

  try {
    await ensureDatabaseSchema();
    await Promise.all([
      maybeMigrateFileCollectionToDatabase(COLLECTION_KEYS.subscriptions, SUBSCRIPTIONS_FILE),
      maybeMigrateFileCollectionToDatabase(COLLECTION_KEYS.pushSubscriptions, PUSH_SUBSCRIPTIONS_FILE),
      maybeMigrateFileCollectionToDatabase(COLLECTION_KEYS.reminderPlans, REMINDER_PLANS_FILE),
      maybeMigrateFileCollectionToDatabase(COLLECTION_KEYS.issueReports, ISSUE_REPORTS_FILE),
      maybeMigrateFileCollectionToDatabase(COLLECTION_KEYS.accounts, ACCOUNTS_FILE),
      maybeMigrateFileCollectionToDatabase(COLLECTION_KEYS.sessions, SESSIONS_FILE)
    ]);
    storageBackend = "database";
  } catch (error) {
    databaseEnabled = false;
    databasePool = null;
    databaseSchemaReady = false;
    storageBackend = "file";
    await ensureDataFiles();
    console.error(`Database unavailable at startup, falling back to file storage: ${error.message}`);
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        let body = "";

        response.on("data", (chunk) => {
          body += chunk;
        });

        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Request failed with status ${response.statusCode}: ${body}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large."));
      }
    });

    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function readSubscriptions() {
  if (isDatabaseConfigured()) {
    return readCollectionFromDatabase(COLLECTION_KEYS.subscriptions);
  }

  return readCollectionFromFile(SUBSCRIPTIONS_FILE);
}

async function writeSubscriptions(subscriptions) {
  if (isDatabaseConfigured()) {
    await writeCollectionToDatabase(COLLECTION_KEYS.subscriptions, subscriptions);
    return;
  }

  await writeCollectionToFile(SUBSCRIPTIONS_FILE, subscriptions);
}

async function readPushSubscriptions() {
  if (isDatabaseConfigured()) {
    return readCollectionFromDatabase(COLLECTION_KEYS.pushSubscriptions);
  }

  return readCollectionFromFile(PUSH_SUBSCRIPTIONS_FILE);
}

async function writePushSubscriptions(subscriptions) {
  if (isDatabaseConfigured()) {
    await writeCollectionToDatabase(COLLECTION_KEYS.pushSubscriptions, subscriptions);
    return;
  }

  await writeCollectionToFile(PUSH_SUBSCRIPTIONS_FILE, subscriptions);
}

async function readReminderPlans() {
  if (isDatabaseConfigured()) {
    return readCollectionFromDatabase(COLLECTION_KEYS.reminderPlans);
  }

  return readCollectionFromFile(REMINDER_PLANS_FILE);
}

async function writeReminderPlans(plans) {
  if (isDatabaseConfigured()) {
    await writeCollectionToDatabase(COLLECTION_KEYS.reminderPlans, plans);
    return;
  }

  await writeCollectionToFile(REMINDER_PLANS_FILE, plans);
}

async function readIssueReports() {
  if (isDatabaseConfigured()) {
    return readCollectionFromDatabase(COLLECTION_KEYS.issueReports);
  }

  return readCollectionFromFile(ISSUE_REPORTS_FILE);
}

async function writeIssueReports(reports) {
  if (isDatabaseConfigured()) {
    await writeCollectionToDatabase(COLLECTION_KEYS.issueReports, reports);
    return;
  }

  await writeCollectionToFile(ISSUE_REPORTS_FILE, reports);
}

async function readAccounts() {
  if (isDatabaseConfigured()) {
    return readCollectionFromDatabase(COLLECTION_KEYS.accounts);
  }

  return readCollectionFromFile(ACCOUNTS_FILE);
}

async function writeAccounts(records) {
  if (isDatabaseConfigured()) {
    await writeCollectionToDatabase(COLLECTION_KEYS.accounts, records);
    return;
  }

  await writeCollectionToFile(ACCOUNTS_FILE, records);
}

async function readSessions() {
  if (isDatabaseConfigured()) {
    return readCollectionFromDatabase(COLLECTION_KEYS.sessions);
  }

  return readCollectionFromFile(SESSIONS_FILE);
}

async function writeSessions(records) {
  if (isDatabaseConfigured()) {
    await writeCollectionToDatabase(COLLECTION_KEYS.sessions, records);
    return;
  }

  await writeCollectionToFile(SESSIONS_FILE, records);
}

// Render terminates TLS in front of us, so the socket here is plain http even in production and
// request.socket.encrypted would drop the Secure attribute from every cookie we set. The proxy
// header is the only thing that knows. Locally there is no header and no TLS, which is what lets a
// session work over http://127.0.0.1:3000 during development.
function isSecureRequest(request) {
  const forwarded = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();

  if (forwarded) {
    return forwarded === "https";
  }

  return Boolean(request.socket && request.socket.encrypted);
}

function getRequestIp(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || (request.socket && request.socket.remoteAddress) || "unknown";
}

async function resolveSession(request) {
  const jar = accounts.parseCookies(request.headers.cookie);
  const token = jar[accounts.SESSION_COOKIE_NAME];

  if (!token) {
    return { account: null, session: null };
  }

  const tokenHash = accounts.hashSessionToken(token);
  const sessions = await readSessions();
  const session = sessions.find((item) => item.tokenHash === tokenHash);

  if (!session || accounts.isSessionExpired(session)) {
    return { account: null, session: null };
  }

  const accountList = await readAccounts();
  const account = accountList.find((item) => item.id === session.accountId);

  return account ? { account, session } : { account: null, session: null };
}

async function startSession(request, response, account) {
  const { token, tokenHash } = accounts.createSessionToken();
  const sessions = accounts.pruneExpiredSessions(await readSessions());
  const record = accounts.buildSessionRecord({
    accountId: account.id,
    tokenHash,
    userAgent: request.headers["user-agent"] || ""
  });

  await writeSessions([record, ...sessions]);
  response.setHeader("Set-Cookie", accounts.buildSessionCookie(token, { secure: isSecureRequest(request) }));
  return record;
}

// Sign-in throttling. In memory on purpose: this is one small Node process, a shared counter would
// mean a round trip to Postgres on every attempt, and the failure mode of losing the counters on
// deploy is that an attacker gets a fresh budget once a week. Both the email and the address are
// keyed so that neither guessing one account's password from many addresses nor spraying many
// accounts from one address gets an unlimited number of tries.
const SIGN_IN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const SIGN_IN_MAX_ATTEMPTS_PER_EMAIL = 8;
const SIGN_IN_MAX_ATTEMPTS_PER_ADDRESS = 30;
const signInAttempts = new Map();

function pruneSignInAttempts(now) {
  signInAttempts.forEach((entry, key) => {
    if (now - entry.firstAttemptAt > SIGN_IN_ATTEMPT_WINDOW_MS) {
      signInAttempts.delete(key);
    }
  });
}

function countSignInAttempts(key, now) {
  const entry = signInAttempts.get(key);

  if (!entry || now - entry.firstAttemptAt > SIGN_IN_ATTEMPT_WINDOW_MS) {
    return 0;
  }

  return entry.count;
}

function recordSignInFailure(key, now) {
  const entry = signInAttempts.get(key);

  if (!entry || now - entry.firstAttemptAt > SIGN_IN_ATTEMPT_WINDOW_MS) {
    signInAttempts.set(key, { count: 1, firstAttemptAt: now });
    return;
  }

  entry.count += 1;
}

function clearSignInFailures(keys) {
  keys.forEach((key) => signInAttempts.delete(key));
}

function isSignInThrottled(emailKey, addressKey, now) {
  pruneSignInAttempts(now);

  return (
    countSignInAttempts(emailKey, now) >= SIGN_IN_MAX_ATTEMPTS_PER_EMAIL ||
    countSignInAttempts(addressKey, now) >= SIGN_IN_MAX_ATTEMPTS_PER_ADDRESS
  );
}

function getWebPushLibrary() {
  try {
    return require("web-push");
  } catch {
    return null;
  }
}

function getPushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || "";
  const privateKey = process.env.VAPID_PRIVATE_KEY || "";
  const subject = process.env.VAPID_SUBJECT || "";
  const webPush = getWebPushLibrary();
  const libraryInstalled = Boolean(webPush);
  const hasKeys = Boolean(publicKey && privateKey && subject);
  const enabled = Boolean(libraryInstalled && hasKeys);

  if (enabled) {
    webPush.setVapidDetails(subject, publicKey, privateKey);
  }

  return {
    enabled,
    libraryInstalled,
    publicKey,
    subject,
    hasKeys,
    webPush
  };
}

function normalizeReminderJob(job) {
  return {
    id: String(job.id || ""),
    title: String(job.title || "Denver Curb Alerts"),
    body: String(job.body || "Street sweeping reminder"),
    scheduledAt: String(job.scheduledAt || ""),
    setName: String(job.setName || ""),
    url: String(job.url || "/"),
    segmentLabels: Array.isArray(job.segmentLabels) ? job.segmentLabels.map((label) => String(label)) : [],
    triggerLabels: Array.isArray(job.triggerLabels) ? job.triggerLabels.map((label) => String(label)) : [],
    sentAt: job.sentAt ? String(job.sentAt) : null
  };
}

function isDeliverableJob(job) {
  return Boolean(job.id && job.scheduledAt && !Number.isNaN(new Date(job.scheduledAt).getTime()));
}

function mergeReminderJobs(existingJobs, nextJobs) {
  const existingJobsById = new Map((existingJobs || []).map((job) => [job.id, job]));
  return nextJobs.map((job) => {
    const previous = existingJobsById.get(job.id);
    return previous ? { ...job, sentAt: previous.sentAt || null } : { ...job, sentAt: null };
  });
}

function buildReminderPlanRecord(existingPlan, subscriptionRecord, endpoint, savedSets, jobs, accountId = null) {
  const now = new Date().toISOString();
  return {
    id: existingPlan?.id || `plan_${Date.now()}`,
    endpoint,
    accountId: accountId || subscriptionRecord.accountId || existingPlan?.accountId || null,
    subscriptionId: subscriptionRecord.id,
    deviceLabel: subscriptionRecord.deviceLabel || "",
    updatedAt: now,
    savedSets,
    jobs: mergeReminderJobs(existingPlan?.jobs || [], jobs)
  };
}

function cleanText(value, maxLength = 300) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeIssueReport(body, request) {
  const selectedSegments = Array.isArray(body.selectedSegments)
    ? body.selectedSegments.slice(0, 25).map((segment) => ({
        id: cleanText(segment.id, 120),
        street: cleanText(segment.street, 160),
        sideKey: cleanText(segment.sideKey, 40),
        sideLabel: cleanText(segment.sideLabel, 80),
        nextSweep: cleanText(segment.nextSweep, 80),
        rule: cleanText(segment.rule, 240),
        source: cleanText(segment.source, 160)
      }))
    : [];

  return {
    id: `issue_${Date.now()}`,
    createdAt: new Date().toISOString(),
    createdAtClient: cleanText(body.createdAtClient, 80),
    type: cleanText(body.type || "Something else", 120),
    note: cleanText(body.note, 1500),
    selectedSegments,
    selectionCount: Number(body.selectionCount || selectedSegments.length) || selectedSegments.length,
    savedSetCount: Number(body.savedSetCount || 0) || 0,
    jobCount: Number(body.jobCount || 0) || 0,
    pushConnected: Boolean(body.pushConnected),
    hasUserLocation: Boolean(body.hasUserLocation),
    activeAreaLabel: cleanText(body.activeAreaLabel, 200),
    activeSourceLabel: cleanText(body.activeSourceLabel, 200),
    pageUrl: cleanText(body.pageUrl, 600),
    viewport: {
      width: Number(body.viewport?.width || 0) || 0,
      height: Number(body.viewport?.height || 0) || 0
    },
    userAgent: cleanText(body.userAgent || request.headers["user-agent"], 600)
  };
}

function buildDenverSweepUrl(address) {
  const url = new URL("Streets/Sweeping", DENVER_API_BASE);
  url.searchParams.set("address", address);
  return url.toString();
}

function buildDenverSweepUrlFromCoordinates(latitude, longitude) {
  const url = new URL("Streets/Sweeping", DENVER_API_BASE);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  return url.toString();
}

function parseStaticMapGeometry(staticMapUrl) {
  if (!staticMapUrl) {
    return { center: null, path: [] };
  }

  try {
    const url = new URL(staticMapUrl);
    const center = url.searchParams.get("center");
    const pathValue = url.searchParams.get("path");

    return {
      center: center
        ? center.split(",").map((value) => Number(value.trim()))
        : null,
      path: pathValue
        ? pathValue.split("|").map((pair) => {
            const [lat, lng] = pair.split(",");
            return [Number(lat), Number(lng)];
          })
        : []
    };
  } catch {
    return { center: null, path: [] };
  }
}

function normalizeRoute(route) {
  const geometry = parseStaticMapGeometry(route.StaticMapUrl);
  return {
    id: route.Id,
    streetId: route.StreetId,
    streetName: route.StreetName,
    from: route.From,
    to: route.To,
    sweepType: route.SweepType,
    leftSweepDirection: route.LeftSweepDirection,
    rightSweepDirection: route.RightSweepDirection,
    leftSweepingRule: route.LeftSweepingRule,
    rightSweepingRule: route.RightSweepingRule,
    schedules: route.Schedules || [],
    isPosted: Boolean(route.IsPosted),
    subscriptions: {
      emailLeft: Boolean(route.IsSubEmailLeft),
      emailRight: Boolean(route.IsSubEmailRight),
      textLeft: Boolean(route.IsSubTextLeft),
      textRight: Boolean(route.IsSubTextRight),
      pushLeft: Boolean(route.IsSubPushLeft),
      pushRight: Boolean(route.IsSubPushRight)
    },
    map: {
      staticMapUrl: route.StaticMapUrl,
      center: geometry.center,
      path: geometry.path
    }
  };
}

function summarizeRoutes(queryLabel, routes) {
  const normalizedRoutes = routes.map(normalizeRoute);
  const scheduledCount = normalizedRoutes.filter((route) => route.sweepType === "Scheduled").length;

  return {
    address: queryLabel,
    routeCount: normalizedRoutes.length,
    scheduledCount,
    routes: normalizedRoutes
  };
}

async function handleDenverLookup(response, url) {
  const address = url.searchParams.get("address");
  const latitude = Number(url.searchParams.get("latitude"));
  const longitude = Number(url.searchParams.get("longitude"));
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);

  if (!address && !hasCoordinates) {
    sendJson(response, 400, { error: "Address or latitude/longitude is required." });
    return;
  }

  try {
    const denverResponse = await fetchJson(
      hasCoordinates ? buildDenverSweepUrlFromCoordinates(latitude, longitude) : buildDenverSweepUrl(address)
    );
    const queryLabel = hasCoordinates ? `${latitude.toFixed(6)}, ${longitude.toFixed(6)}` : address;
    const summary = summarizeRoutes(queryLabel, denverResponse.Routes || []);
    sendJson(response, 200, summary);
  } catch (error) {
    sendJson(response, 502, {
      error: "Unable to reach the Denver street sweeping service right now.",
      details: error.message
    });
  }
}

async function handleSubscriptions(request, response, url) {
  if (request.method === "GET") {
    if (!hasAdminAccess(request)) {
      sendJson(response, 403, { error: "Not authorized." });
      return;
    }

    const subscriptions = await readSubscriptions();
    sendJson(response, 200, subscriptions);
    return;
  }

  if (request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const subscriptions = await readSubscriptions();
      const record = {
        id: `sub_${Date.now()}`,
        createdAt: new Date().toISOString(),
        address: body.address || "",
        routeId: body.routeId || null,
        streetName: body.streetName || "",
        side: body.side || "",
        sweepType: body.sweepType || "",
        selectedDate: body.selectedDate || "",
        reminders: Array.isArray(body.reminders) ? body.reminders : [],
        pushPreference: body.pushPreference || "planned",
        note: body.note || ""
      };

      subscriptions.unshift(record);
      await writeSubscriptions(subscriptions);
      sendJson(response, 201, record);
    } catch (error) {
      sendJson(response, 400, { error: "Invalid subscription payload.", details: error.message });
    }
    return;
  }

  if (request.method === "DELETE") {
    const id = url.pathname.split("/").pop();
    const subscriptions = await readSubscriptions();
    const nextSubscriptions = subscriptions.filter((item) => item.id !== id);

    if (nextSubscriptions.length === subscriptions.length) {
      sendJson(response, 404, { error: "Subscription not found." });
      return;
    }

    await writeSubscriptions(nextSubscriptions);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function handlePushConfig(response) {
  const config = getPushConfig();
  sendJson(response, 200, {
    enabled: config.enabled,
    libraryInstalled: config.libraryInstalled,
    hasKeys: config.hasKeys,
    publicKey: config.publicKey || null
  });
}

async function handlePushSubscriptions(request, response, url) {
  if (request.method === "GET") {
    if (!hasAdminAccess(request)) {
      sendJson(response, 403, { error: "Not authorized." });
      return;
    }

    const subscriptions = await readPushSubscriptions();
    sendJson(response, 200, {
      count: subscriptions.length,
      subscriptions
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const subscription = body.subscription;

      if (!subscription || !subscription.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) {
        sendJson(response, 400, { error: "A valid Push API subscription is required." });
        return;
      }

      const { account } = await resolveSession(request);
      const subscriptions = await readPushSubscriptions();
      const existing = subscriptions.find((item) => item.endpoint === subscription.endpoint);
      const now = new Date().toISOString();
      const record = {
        id: existing?.id || `push_${Date.now()}`,
        endpoint: subscription.endpoint,
        accountId: account?.id || existing?.accountId || null,
        keys: subscription.keys,
        userAgent: body.userAgent || request.headers["user-agent"] || "",
        deviceLabel: body.deviceLabel || "",
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };

      const nextSubscriptions = existing
        ? subscriptions.map((item) => (item.endpoint === subscription.endpoint ? record : item))
        : [record, ...subscriptions];

      await writePushSubscriptions(nextSubscriptions);
      sendJson(response, 201, {
        ok: true,
        subscriptionId: record.id
      });
    } catch (error) {
      sendJson(response, 400, {
        error: "Invalid push subscription payload.",
        details: error.message
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    const endpoint = url.searchParams.get("endpoint");
    if (!endpoint) {
      sendJson(response, 400, { error: "An endpoint query parameter is required." });
      return;
    }

    const subscriptions = await readPushSubscriptions();
    const nextSubscriptions = subscriptions.filter((item) => item.endpoint !== endpoint);
    await writePushSubscriptions(nextSubscriptions);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function handleReminderPlans(request, response, url) {
  if (request.method === "GET") {
    const endpoint = url.searchParams.get("endpoint");
    const plans = await readReminderPlans();

    if (!endpoint) {
      if (!hasAdminAccess(request)) {
        sendJson(response, 403, { error: "Not authorized." });
        return;
      }

      sendJson(response, 200, {
        count: plans.length,
        plans
      });
      return;
    }

    const plan = plans.find((item) => item.endpoint === endpoint);
    sendJson(response, 200, {
      plan: plan || null
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const endpoint = String(body.endpoint || "");
      const jobs = Array.isArray(body.jobs) ? body.jobs.map(normalizeReminderJob).filter(isDeliverableJob) : [];
      const savedSets = Array.isArray(body.savedSets)
        ? body.savedSets.map((set) => ({
            id: String(set.id || ""),
            name: String(set.name || ""),
            segmentIds: Array.isArray(set.segmentIds) ? set.segmentIds.map((segmentId) => String(segmentId)) : [],
            createdAt: String(set.createdAt || "")
          }))
        : [];

      if (!endpoint) {
        sendJson(response, 400, { error: "A push subscription endpoint is required." });
        return;
      }

      const subscriptions = await readPushSubscriptions();
      const subscriptionRecord = subscriptions.find((item) => item.endpoint === endpoint);
      if (!subscriptionRecord) {
        sendJson(response, 404, { error: "Push subscription not found for that device." });
        return;
      }

      const { account } = await resolveSession(request);
      const plans = await readReminderPlans();
      const existing = plans.find((item) => item.endpoint === endpoint);
      const nextPlan = buildReminderPlanRecord(existing, subscriptionRecord, endpoint, savedSets, jobs, account?.id || null);
      const nextPlans = existing
        ? plans.map((item) => (item.endpoint === endpoint ? nextPlan : item))
        : [nextPlan, ...plans];

      await writeReminderPlans(nextPlans);
      sendJson(response, 200, {
        ok: true,
        planId: nextPlan.id,
        queuedJobCount: nextPlan.jobs.filter((job) => !job.sentAt).length
      });
    } catch (error) {
      sendJson(response, 400, {
        error: "Invalid reminder plan payload.",
        details: error.message
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    const endpoint = url.searchParams.get("endpoint");
    if (!endpoint) {
      sendJson(response, 400, { error: "An endpoint query parameter is required." });
      return;
    }

    const plans = await readReminderPlans();
    const nextPlans = plans.filter((item) => item.endpoint !== endpoint);
    await writeReminderPlans(nextPlans);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function handleIssueReports(request, response, url) {
  if (request.method === "GET") {
    if (!hasIssueReportAdminAccess(request)) {
      sendJson(response, 403, { error: "Issue report access is private." });
      return;
    }

    const reports = await readIssueReports();
    sendJson(response, 200, {
      count: reports.length,
      reports
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = JSON.parse(await readRequestBody(request));
      const record = normalizeIssueReport(body, request);

      if (!record.note) {
        sendJson(response, 400, { error: "A quick note is required." });
        return;
      }

      const reports = await readIssueReports();
      const nextReports = [record, ...reports].slice(0, 500);
      await writeIssueReports(nextReports);
      sendJson(response, 201, {
        ok: true,
        reportId: record.id
      });
    } catch (error) {
      sendJson(response, 400, {
        error: "Invalid issue report payload.",
        details: error.message
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    if (!hasIssueReportAdminAccess(request)) {
      sendJson(response, 403, { error: "Issue report access is private." });
      return;
    }

    const id = url.pathname.split("/").pop();
    const reports = await readIssueReports();
    const nextReports = reports.filter((item) => item.id !== id);

    if (nextReports.length === reports.length) {
      sendJson(response, 404, { error: "Issue report not found." });
      return;
    }

    await writeIssueReports(nextReports);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function updateAccount(accountId, mutate) {
  const records = await readAccounts();
  const existing = records.find((item) => item.id === accountId);

  if (!existing) {
    return null;
  }

  const next = {
    ...mutate(existing),
    updatedAt: new Date().toISOString()
  };

  await writeAccounts(records.map((item) => (item.id === accountId ? next : item)));
  return next;
}

// Signing in against an address with no account still costs a full scrypt verification, so the
// response time does not tell an attacker which addresses are registered. The decoy hash is derived
// from a random string generated at boot and never matches anything.
let timingDecoyHashPromise = null;

function getTimingDecoyHash() {
  if (!timingDecoyHashPromise) {
    timingDecoyHashPromise = accounts.hashPassword(accounts.createSessionToken().token);
  }

  return timingDecoyHashPromise;
}

async function handleAccounts(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch (error) {
    sendJson(response, 400, { error: "Invalid sign-up payload.", details: error.message });
    return;
  }

  const email = accounts.normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!accounts.isValidEmail(email)) {
    sendJson(response, 400, { error: "Enter a valid email address." });
    return;
  }

  const passwordCheck = accounts.validatePassword(password, email);
  if (!passwordCheck.ok) {
    sendJson(response, 400, { error: passwordCheck.error });
    return;
  }

  // Creating accounts is throttled by address for the same reason signing in is: without it, one
  // script can fill the accounts collection.
  const addressKey = `signup:${getRequestIp(request)}`;
  const now = Date.now();
  if (isSignInThrottled("signup:none", addressKey, now)) {
    sendJson(response, 429, { error: "Too many attempts. Try again in a few minutes." });
    return;
  }

  const existingAccounts = await readAccounts();
  if (existingAccounts.some((item) => item.email === email)) {
    // This does confirm the address is registered, which sign-in deliberately refuses to do. There
    // is no way around it on a sign-up form without email verification gating account creation, and
    // that trade is worth revisiting when verification lands.
    recordSignInFailure(addressKey, now);
    sendJson(response, 409, { error: "An account with that email already exists. Try signing in." });
    return;
  }

  const passwordHash = await accounts.hashPassword(password);
  const record = accounts.buildAccountRecord({ email, passwordHash });
  record.library = { savedSets: [], updatedAt: record.createdAt };

  await writeAccounts([record, ...existingAccounts]);
  await startSession(request, response, record);
  await attachSessionToDevices(record.id, body.pushEndpoint);

  sendJson(response, 201, { account: accounts.toPublicAccount(record) });
}

async function handleSessions(request, response) {
  if (request.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readRequestBody(request));
    } catch (error) {
      sendJson(response, 400, { error: "Invalid sign-in payload.", details: error.message });
      return;
    }

    const email = accounts.normalizeEmail(body.email);
    const password = String(body.password || "");
    const now = Date.now();
    const emailKey = `signin:${email}`;
    const addressKey = `signin:${getRequestIp(request)}`;

    if (isSignInThrottled(emailKey, addressKey, now)) {
      sendJson(response, 429, { error: "Too many sign-in attempts. Try again in a few minutes." });
      return;
    }

    const accountList = await readAccounts();
    const account = accountList.find((item) => item.email === email);
    const passwordMatches = account
      ? await accounts.verifyPassword(password, account.passwordHash)
      : await accounts.verifyPassword(password, await getTimingDecoyHash());

    if (!account || !passwordMatches) {
      recordSignInFailure(emailKey, now);
      recordSignInFailure(addressKey, now);
      // One message for both failures. Telling the user which half was wrong tells an attacker
      // which addresses have accounts.
      sendJson(response, 401, { error: "That email and password don't match an account." });
      return;
    }

    clearSignInFailures([emailKey, addressKey]);
    await startSession(request, response, account);
    await attachSessionToDevices(account.id, body.pushEndpoint);

    sendJson(response, 200, { account: accounts.toPublicAccount(account) });
    return;
  }

  if (request.method === "DELETE") {
    const jar = accounts.parseCookies(request.headers.cookie);
    const token = jar[accounts.SESSION_COOKIE_NAME];

    if (token) {
      const tokenHash = accounts.hashSessionToken(token);
      const sessions = accounts.pruneExpiredSessions(await readSessions());
      await writeSessions(sessions.filter((item) => item.tokenHash !== tokenHash));
    }

    response.setHeader("Set-Cookie", accounts.buildExpiredSessionCookie({ secure: isSecureRequest(request) }));
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

// A device is still identified to the push service by its endpoint; signing in is what ties that
// endpoint to a person. Without this, a paid account on a new phone would have no way to say which
// push subscription belongs to it, and the reminder dispatcher would have nothing to bill against.
async function attachSessionToDevices(accountId, pushEndpoint) {
  const endpoint = String(pushEndpoint || "");
  if (!endpoint) {
    return;
  }

  const subscriptions = await readPushSubscriptions();
  if (subscriptions.some((item) => item.endpoint === endpoint && item.accountId !== accountId)) {
    await writePushSubscriptions(
      subscriptions.map((item) => (item.endpoint === endpoint ? { ...item, accountId } : item))
    );
  }

  const plans = await readReminderPlans();
  if (plans.some((item) => item.endpoint === endpoint && item.accountId !== accountId)) {
    await writeReminderPlans(plans.map((item) => (item.endpoint === endpoint ? { ...item, accountId } : item)));
  }
}

async function handleCurrentAccount(request, response) {
  const { account } = await resolveSession(request);

  if (request.method === "GET") {
    // A signed-out visitor is not an error here. The whole app works without an account, so the
    // client asks this on every load and renders whichever answer it gets.
    sendJson(response, 200, { account: accounts.toPublicAccount(account) });
    return;
  }

  if (!account) {
    sendJson(response, 401, { error: "Sign in first." });
    return;
  }

  if (request.method === "DELETE") {
    let body;
    try {
      body = JSON.parse(await readRequestBody(request));
    } catch {
      body = {};
    }

    const confirmed = await accounts.verifyPassword(String(body.password || ""), account.passwordHash);
    if (!confirmed) {
      sendJson(response, 403, { error: "Enter your current password to delete the account." });
      return;
    }

    // Deleting the account takes the reminders with it. Leaving orphaned push subscriptions behind
    // would keep sending notifications to a phone whose owner just asked to be forgotten.
    const [accountList, sessions, plans, pushSubscriptions] = await Promise.all([
      readAccounts(),
      readSessions(),
      readReminderPlans(),
      readPushSubscriptions()
    ]);

    await Promise.all([
      writeAccounts(accountList.filter((item) => item.id !== account.id)),
      writeSessions(sessions.filter((item) => item.accountId !== account.id)),
      writeReminderPlans(plans.filter((item) => item.accountId !== account.id)),
      writePushSubscriptions(pushSubscriptions.filter((item) => item.accountId !== account.id))
    ]);

    response.setHeader("Set-Cookie", accounts.buildExpiredSessionCookie({ secure: isSecureRequest(request) }));
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function handleAccountPassword(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const { account, session } = await resolveSession(request);
  if (!account) {
    sendJson(response, 401, { error: "Sign in first." });
    return;
  }

  let body;
  try {
    body = JSON.parse(await readRequestBody(request));
  } catch (error) {
    sendJson(response, 400, { error: "Invalid password payload.", details: error.message });
    return;
  }

  const currentMatches = await accounts.verifyPassword(String(body.currentPassword || ""), account.passwordHash);
  if (!currentMatches) {
    sendJson(response, 403, { error: "Your current password is not correct." });
    return;
  }

  const check = accounts.validatePassword(String(body.newPassword || ""), account.email);
  if (!check.ok) {
    sendJson(response, 400, { error: check.error });
    return;
  }

  const passwordHash = await accounts.hashPassword(String(body.newPassword));
  await updateAccount(account.id, (existing) => ({ ...existing, passwordHash }));

  // Changing a password is how someone reacts to thinking it was stolen, so every other session has
  // to go. The one making this request survives, or the user is signed out of the page they are on.
  const sessions = accounts.pruneExpiredSessions(await readSessions());
  await writeSessions(sessions.filter((item) => item.accountId !== account.id || item.id === session.id));

  sendJson(response, 200, { ok: true });
}

// The upgrade path off device-local storage. Saved curb sets live in localStorage for anonymous
// users and always will; this is where they go once there is an account to hang them on, so a new
// phone or a cleared browser does not lose them.
async function handleAccountLibrary(request, response) {
  const { account } = await resolveSession(request);

  if (!account) {
    sendJson(response, 401, { error: "Sign in first." });
    return;
  }

  if (request.method === "GET") {
    sendJson(response, 200, { library: account.library || { savedSets: [], updatedAt: null } });
    return;
  }

  if (request.method === "POST") {
    let body;
    try {
      body = JSON.parse(await readRequestBody(request));
    } catch (error) {
      sendJson(response, 400, { error: "Invalid library payload.", details: error.message });
      return;
    }

    const savedSets = Array.isArray(body.savedSets)
      ? body.savedSets.slice(0, 200).map((set) => ({
          id: String(set.id || ""),
          name: cleanText(set.name, 120),
          sourceLabel: cleanText(set.sourceLabel, 200),
          lookupAddress: cleanText(set.lookupAddress, 200),
          segmentIds: Array.isArray(set.segmentIds)
            ? set.segmentIds.slice(0, 200).map((segmentId) => String(segmentId))
            : [],
          createdAt: String(set.createdAt || "")
        }))
      : [];

    const library = { savedSets, updatedAt: new Date().toISOString() };
    await updateAccount(account.id, (existing) => ({ ...existing, library }));

    sendJson(response, 200, { ok: true, library });
    return;
  }

  sendJson(response, 405, { error: "Method not allowed." });
}

async function handleScheduledPushTest(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const config = getPushConfig();
  if (!config.enabled) {
    sendJson(response, 503, {
      error: "Web push is not configured yet.",
      details: "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT, then install the web-push package."
    });
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request));
    const endpoint = String(body.endpoint || "");
    const requestedDelay = Number(body.delayMinutes || 2);
    const delayMinutes = Number.isFinite(requestedDelay) ? Math.min(Math.max(Math.round(requestedDelay), 1), 15) : 2;

    if (!endpoint) {
      sendJson(response, 400, { error: "A push subscription endpoint is required." });
      return;
    }

    const subscriptions = await readPushSubscriptions();
    const subscriptionRecord = subscriptions.find((item) => item.endpoint === endpoint);
    if (!subscriptionRecord) {
      sendJson(response, 404, { error: "Push subscription not found for that device." });
      return;
    }

    const plans = await readReminderPlans();
    const existing = plans.find((item) => item.endpoint === endpoint);
    const scheduledAt = new Date(Date.now() + delayMinutes * 60 * 1000);
    const testJob = normalizeReminderJob({
      id: `job-scheduled-test-${Date.now()}`,
      title: "Denver Curb Alerts scheduled test",
      body: `This is a live ${delayMinutes}-minute test of your automatic reminder delivery.`,
      scheduledAt: scheduledAt.toISOString(),
      setName: "Scheduled test",
      url: "/",
      segmentLabels: ["Hosted push test"],
      triggerLabels: [`${delayMinutes}-minute automatic test`]
    });
    const nextPlan = buildReminderPlanRecord(
      existing,
      subscriptionRecord,
      endpoint,
      existing?.savedSets || [],
      [...(existing?.jobs || []), testJob]
    );
    const nextPlans = existing
      ? plans.map((item) => (item.endpoint === endpoint ? nextPlan : item))
      : [nextPlan, ...plans];

    await writeReminderPlans(nextPlans);
    sendJson(response, 200, {
      ok: true,
      jobId: testJob.id,
      scheduledAt: testJob.scheduledAt,
      delayMinutes
    });
  } catch (error) {
    sendJson(response, 400, {
      error: "Unable to schedule the hosted push test.",
      details: error.message
    });
  }
}

async function handlePushTest(request, response) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  const config = getPushConfig();
  if (!config.enabled) {
    sendJson(response, 503, {
      error: "Web push is not configured yet.",
      details: "Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT, then install the web-push package."
    });
    return;
  }

  try {
    const body = JSON.parse(await readRequestBody(request));
    const endpoint = body.endpoint || "";
    const subscriptions = await readPushSubscriptions();
    const subscriptionRecord = subscriptions.find((item) => item.endpoint === endpoint);

    if (!subscriptionRecord) {
      sendJson(response, 404, { error: "Push subscription not found for that device." });
      return;
    }

    const payload = JSON.stringify({
      title: body.title || "Denver Curb Alerts",
      body: body.body || "Test alert from your Sloan's Lake pilot.",
      url: body.url || "/",
      tag: body.tag || `test-${Date.now()}`
    });

    await config.webPush.sendNotification(
      {
        endpoint: subscriptionRecord.endpoint,
        keys: subscriptionRecord.keys
      },
      payload
    );

    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 502, {
      error: "Unable to send the test push right now.",
      details: error.message
    });
  }
}

async function dispatchDueReminderPlans() {
  const config = getPushConfig();
  if (!config.enabled) {
    return;
  }

  const [plans, subscriptions] = await Promise.all([readReminderPlans(), readPushSubscriptions()]);
  const subscriptionsByEndpoint = new Map(subscriptions.map((subscription) => [subscription.endpoint, subscription]));
  const now = Date.now();
  let changed = false;

  for (const plan of plans) {
    const subscription = subscriptionsByEndpoint.get(plan.endpoint);
    if (!subscription) {
      continue;
    }

    for (const job of plan.jobs || []) {
      if (job.sentAt) {
        continue;
      }

      const scheduledTime = new Date(job.scheduledAt).getTime();
      if (Number.isNaN(scheduledTime) || scheduledTime > now) {
        continue;
      }

      try {
        await config.webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys
          },
          JSON.stringify({
            title: job.title,
            body: job.body,
            url: job.url || "/",
            tag: job.id
          })
        );
        job.sentAt = new Date().toISOString();
        changed = true;
      } catch (error) {
        console.error(`Unable to deliver reminder job ${job.id}: ${error.message}`);
      }
    }

    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
    const originalLength = plan.jobs.length;
    plan.jobs = (plan.jobs || []).filter((job) => {
      const scheduledTime = new Date(job.scheduledAt).getTime();
      return !job.sentAt || Number.isNaN(scheduledTime) || scheduledTime >= thirtyDaysAgo;
    });
    if (plan.jobs.length !== originalLength) {
      changed = true;
    }
  }

  if (changed) {
    await writeReminderPlans(plans);
  }
}

// Compressible text assets. The inventory payload is ~12 MB of JSON that gzips to about a
// tenth of that, which is the single largest thing standing between a visitor and a drawn map.
const COMPRESSIBLE_TYPES = new Set([
  "text/html",
  "text/css",
  "application/javascript",
  "text/javascript",
  "application/json",
  "image/svg+xml",
  "application/manifest+json"
]);

// Compressing 12 MB on every request would trade transfer time for server CPU, and public/ is
// static for the life of the process, so each (file, encoding) pair is compressed once and kept.
// The cache is keyed on mtime so a rebuilt payload is never served from a stale entry.
const compressedAssetCache = new Map();

// Reads and compresses only on a miss. The stat comes first so a cache hit never touches the
// 11 MB payload at all -- reading it into memory to then discard it would cost more than the
// compression does, and the free Render instance this runs on has 512 MB to work with.
async function readCompressedAsset(filePath, encoding) {
  const { mtimeMs } = await fs.stat(filePath);
  const key = `${filePath}:${encoding}`;
  const cached = compressedAssetCache.get(key);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.body;
  }

  const file = await fs.readFile(filePath);
  const compress = encoding === "br" ? zlib.brotliCompress : zlib.gzip;
  const options = encoding === "br"
    ? { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }
    : { level: 6 };
  const body = await new Promise((resolve, reject) => {
    compress(file, options, (error, result) => (error ? reject(error) : resolve(result)));
  });

  compressedAssetCache.set(key, { mtimeMs, body });
  return body;
}

// Brotli first, gzip second, uncompressed if the client offers neither. A bare substring test
// would read "br;q=0" -- a client explicitly refusing brotli -- as an offer of it, so parse the
// tokens and drop anything weighted to zero.
function pickEncoding(acceptEncoding) {
  const offered = new Set();
  for (const part of String(acceptEncoding || "").toLowerCase().split(",")) {
    const [token, ...parameters] = part.trim().split(";");
    const quality = parameters
      .map((parameter) => /^\s*q=([\d.]+)\s*$/.exec(parameter))
      .find(Boolean);
    if (quality && Number(quality[1]) <= 0) {
      continue;
    }
    if (token.trim()) {
      offered.add(token.trim());
    }
  }

  if (offered.has("br")) return "br";
  if (offered.has("gzip")) return "gzip";
  return null;
}

async function serveStaticFile(response, pathname, { acceptEncoding = "", versioned = false } = {}) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    const headers = { "Content-Type": contentType };

    if (extension === ".html") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    } else if (path.basename(filePath) === "sw.js") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
    } else if (versioned) {
      // A "?v=" URL is immutable by construction: data/asset-version-lock.json and
      // test/static-cache-version.test.js make it a build failure for an asset's bytes to move
      // without its version moving too, so a year-long cache can never serve stale content.
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else if (extension === ".js" || extension === ".css" || extension === ".webmanifest" || extension === ".svg") {
      headers["Cache-Control"] = "public, max-age=300";
    }

    const baseType = contentType.split(";")[0].trim();
    const encoding = COMPRESSIBLE_TYPES.has(baseType) ? pickEncoding(acceptEncoding) : null;
    if (encoding) {
      // Read this before writing the head: a missing file has to reach the 404 below, not a
      // half-sent 200. fs.stat inside throws for one, the same way fs.readFile used to.
      const body = await readCompressedAsset(filePath, encoding);
      headers["Content-Encoding"] = encoding;
      headers.Vary = "Accept-Encoding";
      response.writeHead(200, headers);
      response.end(body);
      return;
    }

    // Read before writing the head, for the same reason as the compressed branch above: if this
    // throws for a missing file the catch has to be able to send a 404, and it cannot once a 200
    // has gone out. Getting this backwards crashed the process on any request for a missing
    // non-compressible asset -- a stray favicon.ico was enough.
    const file = await fs.readFile(filePath);
    response.writeHead(200, headers);
    response.end(file);
  } catch {
    // Belt and braces: a throw after the head is out cannot become a 404, and must not take the
    // process down with it either.
    if (response.headersSent) {
      response.end();
      return;
    }
    sendText(response, 404, "Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    setApiCorsHeaders(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
  }

  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "denver-curb-alerts",
      date: new Date().toISOString()
    });
    return;
  }

  if (url.pathname === "/api/denver/sweeping") {
    await handleDenverLookup(response, url);
    return;
  }

  if (url.pathname === "/api/subscriptions" || url.pathname.startsWith("/api/subscriptions/")) {
    await handleSubscriptions(request, response, url);
    return;
  }

  if (url.pathname === "/api/accounts") {
    await handleAccounts(request, response);
    return;
  }

  if (url.pathname === "/api/accounts/me") {
    await handleCurrentAccount(request, response);
    return;
  }

  if (url.pathname === "/api/accounts/me/password") {
    await handleAccountPassword(request, response);
    return;
  }

  if (url.pathname === "/api/accounts/me/library") {
    await handleAccountLibrary(request, response);
    return;
  }

  if (url.pathname === "/api/sessions") {
    await handleSessions(request, response);
    return;
  }

  if (url.pathname === "/api/push/config") {
    await handlePushConfig(response);
    return;
  }

  if (url.pathname === "/api/push/subscriptions") {
    await handlePushSubscriptions(request, response, url);
    return;
  }

  if (url.pathname === "/api/reminder-plans") {
    await handleReminderPlans(request, response, url);
    return;
  }

  if (url.pathname === "/api/issue-reports" || url.pathname.startsWith("/api/issue-reports/")) {
    await handleIssueReports(request, response, url);
    return;
  }

  if (url.pathname === "/api/push/schedule-test") {
    await handleScheduledPushTest(request, response);
    return;
  }

  if (url.pathname === "/api/push/test") {
    await handlePushTest(request, response);
    return;
  }

  await serveStaticFile(response, url.pathname, {
    acceptEncoding: request.headers["accept-encoding"],
    versioned: url.searchParams.has("v")
  });
});

server.listen(PORT, HOST, async () => {
  await initStorage();
  console.log(`Denver Curb Alerts running at http://${HOST}:${PORT} using ${storageBackend} storage`);
  dispatchDueReminderPlans().catch((error) => {
    console.error(`Reminder dispatch failed during startup: ${error.message}`);
  });
  setInterval(() => {
    dispatchDueReminderPlans().catch((error) => {
      console.error(`Reminder dispatch failed: ${error.message}`);
    });
  }, REMINDER_DISPATCH_INTERVAL_MS);
});
