const CACHE_NAME = "curb-alerts-shell-v162";
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css?v=20260829-account-view",
  "/curb-geometry.js?v=20260813b",
  "/denver-city-limits.js?v=20260825-enclave-pink-withdrawn",
  "/app.js?v=20260830-sw-cache-first",
  "/denver-west-routes.json?v=96",
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

  // A versioned URL is immutable by contract: the build bumps its "?v=" whenever the bytes move,
  // and data/asset-version-lock.json makes it a test failure for an asset to change without its
  // version changing too. So a hit in Cache Storage here can never be stale, and answering from it
  // without touching the network is what keeps the map usable on a phone.
  //
  // This used to be network-first for every asset, including the 12 MB inventory, with no timeout
  // on the fetch -- the cached copy was only consulted if the request *rejected*. A slow or flaky
  // mobile connection does not reject, it hangs, so the map sat empty for as long as the request
  // took while a complete copy of the inventory was already on disk and untouched. Cache Storage
  // is the durable half of that pair: Safari drops a resource this large from the HTTP cache long
  // before it evicts a cache entry, which is why the HTTP cache alone is not enough.
  if (url.searchParams.has("v")) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(event.request).then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Everything unversioned stays network-first, because nothing guarantees it has not changed.
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
