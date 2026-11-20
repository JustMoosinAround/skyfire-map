/* SkyFire offline support.
 * The page itself (shell) is cached ahead and served cache-first, refreshed in the background.
 * Forecast data is network-first, falling back to the last copy, so the last map opens with no signal.
 * Never cached: grid.json (12 MB, only for the alert runner), map tiles (OpenStreetMap's policy) and the
 * per-spot forecast the light check downloads from Open-Meteo (another site; fetched fresh). */
var VERSION = "skyfire-v2";
var SHELL = ["./", "index.html", "lightcheck.js", "app.js", "style.css", "manifest.webmanifest", "logo.png",
  "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js",
  "assets/basemap.json", "assets/hillshade.png", "assets/denali_los.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/favicon-32.png"];
var SHELL_CACHE = VERSION + "-shell", DATA_CACHE = VERSION + "-data";

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(VERSION) !== 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (/\/data\/grid\.json$/.test(url.pathname)) return;
  if (/\/data\/[^/]+\.json$/.test(url.pathname)) {
    // network first; keep the last good copy for offline use
    e.respondWith(fetch(req).then(function (res) {
      if (res.ok) { var copy = res.clone(); caches.open(DATA_CACHE).then(function (c) { c.put(url.pathname, copy); }); }
      return res;
    }).catch(function () {
      return caches.open(DATA_CACHE).then(function (c) { return c.match(url.pathname); })
        .then(function (hit) { return hit || Response.error(); });
    }));
    return;
  }
  // shell: cache first, refresh in the background
  e.respondWith(caches.open(SHELL_CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) { if (res.ok) c.put(req, res.clone()); return res; });
      if (hit) { net.catch(function () {}); return hit; }
      return net;
    });
  }));
});
