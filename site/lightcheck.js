/* SkyFire light check: will the sun's light reach your spot, minute by minute?
 *
 * For each minute around sunrise or sunset, follow the sun's ray from the pin toward the sun. Because the Earth
 * curves away, the ray climbs: it passes through the low cloud layer first, then mid, then high. If a layer has a
 * thick bank where the ray crosses it, the light is blocked. (The Clouds-Horizon-Distance idea, run per minute.)
 *
 * Pure functions plus one fetch; no DOM. Exposed as window.SkyLight (and module.exports for tests).
 */
(function (root) {
  "use strict";

  var R_KM = 6371, RAD = Math.PI / 180, K = 0.13;          // Earth radius; standard refraction coefficient
  var GRID = 0.25;                                          // forecast grid step (degrees), as in SkyFire
  // Cloud layers by height (m), following the models' pressure levels (~800 and ~450 hPa).
  var LAYERS = [
    { id: "low", label: "Low clouds", bottom: 0, top: 2000 },
    { id: "mid", label: "Mid clouds", bottom: 2000, top: 6500 },
    { id: "high", label: "High clouds", bottom: 6500, top: 11000 },
  ];
  var MAX_KM = 450;          // furthest the ray is followed (the high layer meets the horizon ~300-380 km out)
  var STEP_KM = 10;          // ray sample spacing
  var BLOCK = 70, PARTIAL = 40;   // cover (%) along a layer's stretch: blocks / thins the light
  var MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"];
  var MODEL_NAMES = { auto: "Auto", ecmwf_ifs025: "European", gfs_seamless: "US", icon_seamless: "German" };
  var WEIGHTS = { ecmwf_ifs025: 2, gfs_seamless: 1, icon_seamless: 1 };   // Auto blend, as in SkyFire's %
  var API = "https://api.open-meteo.com/v1/forecast";
  var ELEV_API = "https://api.open-meteo.com/v1/elevation";   // 90 m Copernicus DEM, up to 100 points a call
  // Open-Meteo's free tier counts every point (600 a minute per user), so terrain is sampled sparingly:
  // three profiles across the window's azimuths, every 5 km out to 300 km (~180 points).
  var PROFILE_STEP_KM = 5, PROFILE_MAX_KM = 300, PROFILES = 3;

  // ---- sun -------------------------------------------------------------------------------------
  function sunPos(ms, lat, lon) {   // low-precision solar position (~0.1°); alt is geometric
    var n = (ms - 946728000000) / 86400000;
    var L0 = (280.460 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * RAD;
    var lam = (L0 + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD, eps = (23.439 - 0.0000004 * n) * RAD;
    var ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    var gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    var H = (gmst * 15 + lon) * RAD - ra, la = lat * RAD;
    var alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la)) / RAD + 180;
    return { alt: alt / RAD, az: (az + 360) % 360 };
  }
  // Refraction lifts the sun near the horizon (Bennett's formula, degrees).
  function apparent(alt) { return alt + 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * RAD) / 60; }

  // Sunrise or sunset nearest `iso` (within ±4 h) at a spot: { ms, az } or null.
  function sunEvent(lat, lon, iso, rising) {
    var t0 = Date.parse(iso), best = null;
    var h = function (m) { return sunPos(t0 + m * 60000, lat, lon).alt + 0.833; };
    var prev = h(-240);
    for (var m = -240; m < 240; m++) {
      var next = h(m + 1);
      if ((rising ? prev < 0 && next >= 0 : prev > 0 && next <= 0) && (best === null || Math.abs(m) < Math.abs(best))) {
        best = m + prev / (prev - next);
      }
      prev = next;
    }
    if (best === null) return null;
    var ms = t0 + best * 60000;
    return { ms: ms, az: sunPos(ms, lat, lon).az };
  }

  // ---- geometry --------------------------------------------------------------------------------
  function dest(lat, lon, az, km) {
    var d = km / R_KM, la = lat * RAD, lo = lon * RAD, b = az * RAD;
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 / RAD, lo2 / RAD];
  }
  // Height (m above sea level) of the sun's ray `km` from the observer, the sun at apparent altitude `alt`.
  function rayHeight(km, altDeg, eyeM) {
    var d = km * 1000;
    return eyeM + d * Math.tan(altDeg * RAD) + d * d * (1 - K) / (2 * R_KM * 1000);
  }
  // Distance (km) where the ray reaches height h (or null if it never does within MAX_KM).
  function distanceAt(h, altDeg, eyeM) {
    if (rayHeight(0, altDeg, eyeM) >= h) return 0;
    var lo = 0, hi = MAX_KM;
    if (rayHeight(hi, altDeg, eyeM) < h) return null;
    for (var i = 0; i < 40; i++) { var mid = (lo + hi) / 2; if (rayHeight(mid, altDeg, eyeM) < h) lo = mid; else hi = mid; }
    return hi;
  }
  // The stretch of the ray inside each cloud layer: [{layer, from, to}] in km (to may be MAX_KM).
  function layerStretches(altDeg, eyeM) {
    var out = [];
    LAYERS.forEach(function (L) {
      var a = distanceAt(Math.max(L.bottom, eyeM), altDeg, eyeM);
      if (a === null) return;
      var b = distanceAt(L.top, altDeg, eyeM);
      out.push({ layer: L.id, from: a, to: b === null ? MAX_KM : b });
    });
    return out;
  }

  // ---- forecast ---------------------------------------------------------------------------------
  function node(v) { return Math.round(v / GRID) * GRID; }
  // Every forecast grid node needed to read cloud along the rays for azimuths az0..az1.
  function nodesFor(lat, lon, az0, az1) {
    var seen = {}, out = [];
    var span = ((az1 - az0) + 360) % 360, n = Math.max(1, Math.ceil(span / 2));
    for (var i = 0; i <= n; i++) {
      var az = az0 + span * i / n;
      for (var d = 0; d <= MAX_KM; d += STEP_KM) {
        var p = dest(lat, lon, az, d);
        var la0 = Math.floor(p[0] / GRID) * GRID, lo0 = Math.floor(p[1] / GRID) * GRID;
        [[la0, lo0], [la0 + GRID, lo0], [la0, lo0 + GRID], [la0 + GRID, lo0 + GRID]].forEach(function (q) {
          var key = q[0].toFixed(2) + "," + q[1].toFixed(2);
          if (!seen[key]) { seen[key] = 1; out.push([+q[0].toFixed(2), +q[1].toFixed(2)]); }
        });
      }
    }
    return out;
  }

  // GET JSON from Open-Meteo, one batch after another (not all at once), retrying once after a pause if
  // the free per-minute limit is hit. Errors carry Open-Meteo's own reason.
  function getJson(url, fetchFn) {
    var attempt = function (n) {
      return fetchFn(url).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.ok) return j;
          if (r.status === 429 && n === 0) return new Promise(function (res) { setTimeout(res, 20000); }).then(function () { return attempt(1); });
          var e = new Error((j && j.reason) || ("HTTP " + r.status));
          e.status = r.status;
          throw e;
        });
      });
    };
    return attempt(0);
  }
  function inSequence(urls, fetchFn) {
    var out = [];
    return urls.reduce(function (chain, u) {
      return chain.then(function () { return getJson(u, fetchFn).then(function (j) { out.push(j); }); });
    }, Promise.resolve()).then(function () { return out; });
  }

  // Open-Meteo, same request as the SkyFire forecast runs, in batches. Resolves to a Forecast.
  function fetchForecast(nodes, dayIso, fetchFn) {
    fetchFn = fetchFn || root.fetch.bind(root);
    var day = dayIso.slice(0, 10), next = new Date(Date.parse(day + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    var batches = [];
    for (var i = 0; i < nodes.length; i += 100) batches.push(nodes.slice(i, i + 100));
    var urls = batches.map(function (b) {
      return API + "?latitude=" + b.map(function (p) { return p[0]; }).join(",") +
        "&longitude=" + b.map(function (p) { return p[1]; }).join(",") +
        "&hourly=cloud_cover_low,cloud_cover_mid,cloud_cover_high&models=" + MODELS.join(",") +
        "&start_date=" + day + "&end_date=" + next + "&timezone=GMT";
    });
    return inSequence(urls, fetchFn).then(function (parts) {
      var f = new Forecast();
      parts.forEach(function (j, i) {
        var entries = Array.isArray(j) ? j : [j];
        batches[i].forEach(function (pt, k) { f.add(pt[0], pt[1], entries[k]); });
      });
      return f;
    });
  }

  function Forecast() { this.nodes = {}; }
  Forecast.prototype.add = function (lat, lon, entry) {
    var h = entry && entry.hourly;
    if (!h || !h.time) return;
    var times = h.time.map(function (t) { return Date.parse(t + "Z"); }), models = {};
    MODELS.forEach(function (m) {
      var cols = ["low", "mid", "high"].map(function (l) { return h["cloud_cover_" + l + "_" + m]; });
      if (cols.every(Array.isArray)) models[m] = { low: cols[0], mid: cols[1], high: cols[2] };
    });
    this.nodes[lat.toFixed(2) + "," + lon.toFixed(2)] = { times: times, models: models };
  };
  Forecast.prototype.models = function () {
    var seen = {};
    Object.keys(this.nodes).forEach(function (k) { Object.keys(this.nodes[k].models).forEach(function (m) { seen[m] = 1; }); }, this);
    return MODELS.filter(function (m) { return seen[m]; });
  };
  // Cover (%) of one layer at one node and time for a model ("auto" = weighted blend), or -1.
  Forecast.prototype.nodeCover = function (key, layer, ms, model) {
    var n = this.nodes[key];
    if (!n) return -1;
    var i = 0;
    while (i < n.times.length - 2 && n.times[i + 1] <= ms) i++;
    var f = Math.max(0, Math.min(1, (ms - n.times[i]) / (n.times[i + 1] - n.times[i] || 1)));
    var one = function (m) {
      var s = n.models[m] && n.models[m][layer];
      if (!s || s[i] == null || s[i + 1] == null) return -1;
      return s[i] + (s[i + 1] - s[i]) * f;
    };
    if (model !== "auto") return one(model);
    var sum = 0, w = 0;
    MODELS.forEach(function (m) { var v = one(m); if (v >= 0) { sum += v * WEIGHTS[m]; w += WEIGHTS[m]; } });
    return w ? sum / w : -1;
  };
  // Bilinear between the four surrounding nodes.
  Forecast.prototype.cover = function (lat, lon, layer, ms, model) {
    var la0 = Math.floor(lat / GRID) * GRID, lo0 = Math.floor(lon / GRID) * GRID;
    var fy = (lat - la0) / GRID, fx = (lon - lo0) / GRID, sum = 0, w = 0;
    for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) {
      var key = (la0 + dy * GRID).toFixed(2) + "," + (lo0 + dx * GRID).toFixed(2);
      var v = this.nodeCover(key, layer, ms, model);
      if (v < 0) continue;
      var ww = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
      sum += v * ww; w += ww;
    }
    return w > 1e-9 ? sum / w : -1;
  };

  // ---- terrain ----------------------------------------------------------------------------------
  // Ground elevation along the ray for azimuths az0..az1 (every PROFILE_AZ_STEP degrees), plus the pin itself.
  function fetchProfiles(lat, lon, az0, az1, fetchFn) {
    fetchFn = fetchFn || root.fetch.bind(root);
    var span = ((az1 - az0) + 360) % 360, n = PROFILES - 1, azs = [], dists = [];
    for (var i = 0; i <= n; i++) azs.push(az0 + span * i / n);
    for (var d = PROFILE_STEP_KM; d <= PROFILE_MAX_KM; d += PROFILE_STEP_KM) dists.push(d);
    var pts = [[lat, lon]];
    azs.forEach(function (az) { dists.forEach(function (d) { pts.push(dest(lat, lon, az, d)); }); });
    var batches = [];
    for (var j = 0; j < pts.length; j += 100) batches.push(pts.slice(j, j + 100));
    var urls = batches.map(function (b) {
      return ELEV_API + "?latitude=" + b.map(function (p) { return p[0].toFixed(4); }).join(",") +
        "&longitude=" + b.map(function (p) { return p[1].toFixed(4); }).join(",");
    });
    return inSequence(urls, fetchFn).then(function (js) {
      var parts = js.map(function (j) { return j.elevation || []; });
      var all = [].concat.apply([], parts);
      var elev = azs.map(function (_, a) { return dists.map(function (_, k) { return Math.max(0, +all[1 + a * dists.length + k] || 0); }); });
      return new Terrain(Math.max(0, +all[0] || 0), azs, dists, elev);
    });
  }
  function Terrain(ground, azs, dists, elev) { this.ground = ground; this.azs = azs; this.dists = dists; this.elev = elev; }
  // Elevation (m) at distance km along azimuth az: nearest profile, linear along it.
  Terrain.prototype.at = function (az, km) {
    var best = 0, bd = Infinity;
    for (var i = 0; i < this.azs.length; i++) {
      var dd = Math.abs(((az - this.azs[i]) + 540) % 360 - 180);
      if (dd < bd) { bd = dd; best = i; }
    }
    var row = this.elev[best], step = PROFILE_STEP_KM;
    if (!row || !row.length) return this.ground;
    if (km < step) return this.ground + (row[0] - this.ground) * Math.max(0, km) / step;   // pin to first sample
    var f = km / step - 1, k = Math.floor(f);
    if (k >= row.length - 1) return row[row.length - 1];
    return row[k] + (row[k + 1] - row[k]) * (f - k);
  };
  // The first place the ground rises above the ray (km), or null.
  function hillsBlock(terrain, az, alt, eyeM) {
    if (!terrain) return null;
    for (var d = 2; d <= MAX_KM; d += 1) {
      var h = terrain.at(az, d);
      if (h > rayHeight(d, alt, eyeM)) return { at: d, height: h };
    }
    return null;
  }

  // ---- verdicts ---------------------------------------------------------------------------------
  // One minute: follow the ray through each layer; the nearest stretch with a thick bank blocks the light.
  function minute(forecast, lat, lon, ms, model, eyeM, terrain) {
    var s = sunPos(ms, lat, lon), alt = apparent(s.alt);
    var out = { ms: ms, az: s.az, alt: alt, stretches: [], state: "clear", by: null, at: null, cover: 0, hills: null };
    // Below the horizon: without terrain, the sea-level horizon; with it, where the ray meets the sea.
    if (alt < (terrain ? -0.3 - dip(eyeM) : -0.3)) { out.state = "down"; return out; }
    out.hills = hillsBlock(terrain, s.az, alt, eyeM);
    if (out.hills && out.hills.height < 5) { out.hills = null; out.state = "down"; return out; }   // that's the sea
    var worstPartial = null;
    layerStretches(alt, eyeM).forEach(function (st) {
      var peak = -1, peakKm = null;
      for (var d = Math.max(st.from, STEP_KM / 2); d <= st.to; d += STEP_KM / 2) {
        var p = dest(lat, lon, s.az, d), c = forecast.cover(p[0], p[1], st.layer, ms, model);
        if (c > peak) { peak = c; peakKm = d; }
      }
      st.cover = peak; st.peakKm = peakKm;
      st.state = peak >= BLOCK ? "blocked" : peak >= PARTIAL ? "partial" : peak < 0 ? "unknown" : "clear";
      out.stretches.push(st);
      if (st.state === "blocked" && out.state !== "blocked") { out.state = "blocked"; out.by = st.layer; out.at = peakKm; out.cover = peak; }
      if (st.state === "partial" && !worstPartial) worstPartial = st;
    });
    if (out.state === "clear" && worstPartial) {
      out.state = "partial"; out.by = worstPartial.layer; out.at = worstPartial.peakKm; out.cover = worstPartial.cover;
    }
    if (out.state === "clear" && out.stretches.every(function (st) { return st.state === "unknown"; })) out.state = "unknown";
    // Hills nearer than the blocking cloud (or with nothing else in the way) hide the sun.
    if (out.hills && (out.state !== "blocked" || out.hills.at < out.at)) {
      out.state = "hills"; out.by = "hills"; out.at = out.hills.at; out.cover = 0;
    }
    return out;
  }
  // How far below level the sea horizon sits from eyeM up (degrees).
  function dip(eyeM) { return Math.acos(R_KM * 1000 / (R_KM * 1000 + Math.max(0, eyeM))) / RAD * 0.92; }

  // The window around sunrise/sunset, one verdict per minute.
  function windowFor(event, rising) {
    var m = 60000;
    return rising ? [event.ms - 10 * m, event.ms + 90 * m] : [event.ms - 90 * m, event.ms + 10 * m];
  }
  function timeline(forecast, lat, lon, from, to, model, eyeM, terrain) {
    var out = [];
    for (var t = Math.ceil(from / 60000) * 60000; t <= to; t += 60000) out.push(minute(forecast, lat, lon, t, model, eyeM, terrain));
    return out;
  }
  // Minutes with the light getting through, and the last (sunset) / first (sunrise) of them.
  function summary(tl, rising) {
    var lit = tl.filter(function (x) { return x.state === "clear" || x.state === "partial"; });
    var key = lit.length ? (rising ? lit[0] : lit[lit.length - 1]) : null;
    return { minutesLit: lit.length, minutesClear: tl.filter(function (x) { return x.state === "clear"; }).length,
             edge: key ? key.ms : null };
  }

  var api = { LAYERS: LAYERS, MODELS: MODELS, MODEL_NAMES: MODEL_NAMES, MAX_KM: MAX_KM, BLOCK: BLOCK, PARTIAL: PARTIAL,
    sunPos: sunPos, apparent: apparent, sunEvent: sunEvent, dest: dest, rayHeight: rayHeight, distanceAt: distanceAt,
    layerStretches: layerStretches, nodesFor: nodesFor, fetchForecast: fetchForecast, Forecast: Forecast,
    fetchProfiles: fetchProfiles, Terrain: Terrain, hillsBlock: hillsBlock, PROFILE_STEP_KM: PROFILE_STEP_KM,
    minute: minute, windowFor: windowFor, timeline: timeline, summary: summary };
  root.SkyLight = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
