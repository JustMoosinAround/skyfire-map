/* SkyFire Pro on the page: the licence on this device, its status, and where Pro's forecasts come from.
 * With Pro switched off (index.json "pro": {"enabled": false}) everything is free and SkyFire calls
 * Open-Meteo's free API directly, as before. Exposed as window.SkyPro.
 */
(function (root) {
  "use strict";
  var KEY = "skyfire.pro.key", STATUS = "skyfire.pro.status";
  var DAY = 86400000, GRACE_DAYS = 7;
  var store = {
    get: function (k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v === null) root.localStorage.removeItem(k); else root.localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };
  var cfg = { enabled: false }, listeners = [];

  function key() { return store.get(KEY); }
  function cached() { try { return JSON.parse(store.get(STATUS) || "null"); } catch (e) { return null; } }

  // Pro features available? Off = everyone; on = an active licence, checked within the last week.
  function active() {
    if (!cfg.enabled) return true;
    var st = cached();
    return !!(key() && st && st.active && Date.now() - st.checked < GRACE_DAYS * DAY);
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = { "Content-Type": "application/json" };
    if (opts.auth && key()) headers.Authorization = "Bearer " + key();
    return fetch(cfg.api + path, { method: opts.method || "GET", headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) { var e = new Error(j.error || ("HTTP " + r.status)); e.status = r.status; throw e; }
          return j;
        });
      });
  }
  function save(result) {
    if (result.key) store.set(KEY, result.key);
    store.set(STATUS, JSON.stringify({ active: !!result.active, status: result.status, period_end: result.period_end,
                                       email: result.email, plan: result.plan, checked: Date.now() }));
    listeners.forEach(function (fn) { fn(active()); });
    return result;
  }

  // Re-check the licence once a day; a failed check (offline) keeps the last answer within the grace week.
  function refresh(force) {
    if (!cfg.enabled || !key()) return Promise.resolve(active());
    var st = cached();
    if (!force && st && Date.now() - st.checked < DAY) return Promise.resolve(active());
    return api("/status", { auth: true }).then(save, function (e) {
      if (e.status === 401) { store.set(KEY, null); store.set(STATUS, null); listeners.forEach(function (fn) { fn(false); }); }
      return active();
    }).then(function () { return active(); });
  }

  // Where Pro's forecasts and terrain come from: the Pro server (with the licence) when Pro is on.
  function forecastSource() {
    if (!cfg.enabled) return null;   // free Open-Meteo, as before
    return {
      forecast: cfg.api + "/forecast", elevation: cfg.api + "/elevation",
      fetch: function (url) { return fetch(url, { headers: { Authorization: "Bearer " + (key() || "") } }); },
    };
  }

  root.SkyPro = {
    configure: function (c) { cfg = c && c.enabled && c.api ? c : { enabled: false }; return cfg; },
    config: function () { return cfg; },
    enabled: function () { return !!cfg.enabled; },
    active: active, key: key, status: cached, refresh: refresh, forecastSource: forecastSource,
    onChange: function (fn) { listeners.push(fn); },
    checkout: function (plan) { return api("/checkout", { method: "POST", body: { plan: plan } }); },
    activate: function (session) { return api("/activate?session=" + encodeURIComponent(session)).then(save); },
    restore: function (email, k) { return api("/restore", { method: "POST", body: { email: email, key: k } }).then(save); },
    portal: function () { return api("/portal", { method: "POST", auth: true }); },
    forget: function () { store.set(KEY, null); store.set(STATUS, null); listeners.forEach(function (fn) { fn(active()); }); },
  };
})(typeof window !== "undefined" ? window : globalThis);
