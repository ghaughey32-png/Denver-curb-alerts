const CACHE_NAME = "curb-alerts-shell-v95";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=20260816-special-curbs",
  "/denver-west-routes.js?v=20260819-marion-downing-parkway",
  "/curb-geometry.js?v=20260813b",
  "/app.js?v=20260819-marion-downing-parkway",
  "/denver-west-routes.json?v=49",
  "/manifest.webmanifest?v=20260808d",
  "/icon.svg?v=20260808d"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", clone));
          return response;
        })
        .catch(async () => {
          const cachedIndex = await caches.match("/index.html");
          return cachedIndex || caches.match("/");
        })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Denver Curb Alerts",
    body: "Street sweeping reminder",
    url: "/",
    tag: `curb-alert-${Date.now()}`
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: {
        url: payload.url || "/"
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const matchingClient = clients.find((client) => client.url === targetUrl || client.url.startsWith(self.location.origin));
      if (matchingClient) {
        return matchingClient.focus();
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});
