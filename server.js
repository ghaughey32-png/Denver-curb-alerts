const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "subscriptions.json");
const PUSH_SUBSCRIPTIONS_FILE = path.join(DATA_DIR, "push-subscriptions.json");
const DENVER_API_BASE = "https://www.denvergov.org/api/";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
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
  await Promise.all([ensureJsonFile(SUBSCRIPTIONS_FILE), ensureJsonFile(PUSH_SUBSCRIPTIONS_FILE)]);
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
  await ensureJsonFile(SUBSCRIPTIONS_FILE);
  const raw = await fs.readFile(SUBSCRIPTIONS_FILE, "utf8");
  return JSON.parse(raw);
}

async function writeSubscriptions(subscriptions) {
  await fs.writeFile(SUBSCRIPTIONS_FILE, `${JSON.stringify(subscriptions, null, 2)}\n`, "utf8");
}

async function readPushSubscriptions() {
  await ensureJsonFile(PUSH_SUBSCRIPTIONS_FILE);
  const raw = await fs.readFile(PUSH_SUBSCRIPTIONS_FILE, "utf8");
  return JSON.parse(raw);
}

async function writePushSubscriptions(subscriptions) {
  await fs.writeFile(PUSH_SUBSCRIPTIONS_FILE, `${JSON.stringify(subscriptions, null, 2)}\n`, "utf8");
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

function buildDenverSweepUrl(address) {
  const url = new URL("Streets/Sweeping", DENVER_API_BASE);
  url.searchParams.set("address", address);
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

function summarizeRoutes(address, routes) {
  const normalizedRoutes = routes.map(normalizeRoute);
  const scheduledCount = normalizedRoutes.filter((route) => route.sweepType === "Scheduled").length;

  return {
    address,
    routeCount: normalizedRoutes.length,
    scheduledCount,
    routes: normalizedRoutes
  };
}

async function handleDenverLookup(response, url) {
  const address = url.searchParams.get("address");

  if (!address) {
    sendJson(response, 400, { error: "Address is required." });
    return;
  }

  try {
    const denverResponse = await fetchJson(buildDenverSweepUrl(address));
    const summary = summarizeRoutes(address, denverResponse.Routes || []);
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

      const subscriptions = await readPushSubscriptions();
      const existing = subscriptions.find((item) => item.endpoint === subscription.endpoint);
      const now = new Date().toISOString();
      const record = {
        id: existing?.id || `push_${Date.now()}`,
        endpoint: subscription.endpoint,
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

async function serveStaticFile(response, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(file);
  } catch {
    sendText(response, 404, "Not found");
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

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

  if (url.pathname === "/api/push/config") {
    await handlePushConfig(response);
    return;
  }

  if (url.pathname === "/api/push/subscriptions") {
    await handlePushSubscriptions(request, response, url);
    return;
  }

  if (url.pathname === "/api/push/test") {
    await handlePushTest(request, response);
    return;
  }

  await serveStaticFile(response, url.pathname);
});

server.listen(PORT, HOST, async () => {
  await ensureDataFiles();
  console.log(`Denver Curb Alerts running at http://${HOST}:${PORT}`);
});
