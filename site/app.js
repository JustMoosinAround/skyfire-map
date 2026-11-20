/* SkyFire public map. Plain script, no build step.
 * Every piece of text from data/ is set with textContent (or as DOM nodes
 * handed to Leaflet), never parsed as HTML. */
(function () {
  "use strict";

  var ZONE = "America/Anchorage";
  var EXTENT = { south: 59.4, north: 64.1, west: -153.3, east: -145.8 };
  var PAD = 0.5;
  var START = [[60.85, -150.75], [61.75, -148.85]];   // Anchorage, the Mat-Su and upper Turnagain Arm
  var HOME = [61.2181, -149.9003];                      // default sun pin: downtown Anchorage
  var TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  var OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  var DETAIL_ZOOM = 9;          // OpenStreetMap detail (roads, place names) from this zoom in
  var STORE_KEY = "skymap.tab";
  var PIN_KEY = "skymap.pin";
  var FIELD_OPACITY = 0.92;
  var STALE_OPACITY = 0.4;
  var R_KM = 6371;
  var RAD = Math.PI / 180;

  // Colour layer per forecast kind: [r, g, b, base alpha, alpha added at the best quality].
  // Cloud is drawn white-grey like Windy's cloud layer; colour kinds get stronger as they get better.
  var STYLE = {
    blocked:   [236, 239, 244, 0.52, 0.00],
    partly:    [190, 197, 208, 0.38, 0.00],
    plain:     [242, 196, 48, 0.42, 0.40],
    alpenglow: [255, 122, 61, 0.45, 0.50],
    lit:       [236, 72, 128, 0.47, 0.50],
    ceiling:   [150, 128, 255, 0.47, 0.50],
    cloudy:    [236, 239, 244, 0.50, 0.00],
    patchy:    [190, 197, 208, 0.38, 0.00],
    north:     [40, 190, 140, 0.30, 0.50],
    twilight:  [76, 155, 232, 0.28, 0.45],
    dark:      [70, 226, 156, 0.40, 0.55],
    nlc:       [90, 200, 255, 0.40, 0.55],
    // Denali View: chance the mountain shows
    hidden:    [5, 8, 13, 0.50, 0.00],
    d0:        [214, 84, 96, 0.55, 0.00],
    d50:       [242, 178, 60, 0.62, 0.00],
    d100:      [62, 224, 140, 0.80, 0.00],
  };
  var KEYS = {
    sky: [["blocked", "Cloud in the way"], ["partly", "Partly"], ["plain", "Clear, plain"], ["alpenglow", "Alpenglow"],
          ["lit", "Lit clouds"], ["ceiling", "Fire"]],
    aurora: [["cloudy", "Cloudy"], ["patchy", "Patchy"], ["twilight", "Twilight"], ["north", "Clear north"],
             ["dark", "Clear and dark"]],
    nlc: [["cloudy", "Cloudy"], ["nlc", "Northern sky clear"]],
  };
  KEYS.meteor = KEYS.aurora;
  KEYS.denali = [["hidden", "Hills in the way"], ["d0", "0%: cloud in the way"], ["d50", "50%"], ["d100", "100%: clear view"]];
  var NIGHT_HINT = {
    aurora: "Look north. Green and blue show clear, dark sky; white is cloud.",
    meteor: "Green and blue show clear, dark sky; white is cloud.",
    nlc: "Look low in the north after sunset. Blue shows a clear northern sky; white is cloud.",
  };

  // A missing element (e.g. a cached page from another version) gives a harmless stand-in, never a crash.
  var STUB = { hidden: true, dataset: {}, style: {}, textContent: "", value: "", disabled: false,
    addEventListener: function () {}, setAttribute: function () {}, getAttribute: function () { return null; },
    appendChild: function () {}, querySelector: function () { return null; }, focus: function () {} };
  var $ = function (id) { return document.getElementById(id) || STUB; };

  // localStorage can throw (private browsing, blocked storage): never let it stop the page.
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
  };

  // ---- Alaska-time formatting ------------------------------------------------
  var parts = (function () {
    var f = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    return function (iso) {
      var out = {};
      f.formatToParts(new Date(iso)).forEach(function (p) { out[p.type] = p.value; });
      return out;
    };
  })();
  function clock(p) { return p.hour + ":" + p.minute + " " + p.dayPeriod; }
  function dayTime(iso) { var p = parts(iso); return p.weekday + " " + p.month + " " + p.day + ", " + clock(p); }
  function weekdayTime(iso) { var p = parts(iso); return p.weekday + " " + clock(p); }
  function timeOnly(iso) { return clock(parts(iso)); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // ---- State ----------------------------------------------------------------
  var index, map, tabFiles = {}, current = null, loadToken = 0;
  var fieldLayer = null, sunLayer, detailLayers, pin;
  var opacity = FIELD_OPACITY, showSun = true, dragging = false;

  // ---- Start ----------------------------------------------------------------
  fetch("data/index.json", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(start, unavailable);

  function unavailable() {
    $("unavailable").hidden = false;
    $("tabs").hidden = true;
    $("when").hidden = true;
    document.body.classList.add("is-unavailable");
  }

  function start(data) {
    index = data;
    var title = data.title || "SkyFire";
    $("title").textContent = title;
    document.title = title;

    setupContact(data);
    $("footer").hidden = false;
    document.querySelector(".site-credits").textContent = data.credits || "";

    var age = Date.now() - Date.parse(data.updated);
    if (age > data.stale_hours * 3600e3) {
      opacity = STALE_OPACITY;
      var stale = $("stale");
      stale.textContent = "This forecast is out of date (last updated " + dayTime(data.updated) + " Alaska time)";
      stale.hidden = false;
    }

    // Everything above the map is laid out before the map exists: the map box is flex:1,
    // and Leaflet fits the view to the size it measures when it is created.
    var tabs = data.tabs || [];
    var nav = $("tabs");
    tabs.forEach(function (tab) {
      var b = el("button", "tab", tab.label);
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", "false");
      b.dataset.id = tab.id;
      b.addEventListener("click", function () { showTab(tab.id, true); });
      nav.appendChild(b);
    });
    nav.addEventListener("keydown", function (e) {
      var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step || !current) return;
      var ids = tabs.map(function (t) { return t.id; });
      var next = ids[(ids.indexOf(current.id) + step + ids.length) % ids.length];
      showTab(next, true);
      nav.querySelector('[data-id="' + CSS.escape(next) + '"]').focus();
      e.preventDefault();
    });
    var remembered = store.get(STORE_KEY);
    var chosen = !tabs.length ? null
      : tabs.some(function (t) { return t.id === remembered; }) ? remembered : tabs[0].id;
    if (chosen) setWhen(tabs.filter(function (t) { return t.id === chosen; })[0]);

    $("map-wrap").hidden = false;
    setupMap();
    setupControls();
    addSpots(data.spots || []);
    if (!chosen) { showNote("No forecast maps are available right now."); return; }
    showTab(chosen, false);
  }

  function setWhen(tab) {
    $("when").textContent = tab.label + " " + dayTime(tab.when) + " · updated " + timeOnly(index.updated) + " Alaska time";
  }

  function setupContact(data) {
    var link = $("contact");
    if (data.contact_label) link.textContent = data.contact_label;
    if (/^https:\/\//.test(data.contact_url || "")) link.href = data.contact_url;
    var root = null;
    try { root = new URL(link.href).origin + "/"; } catch (e) { /* keep none */ }
    if (data.logo) {
      var img = $("logo");
      var logoLink = $("logo-link");
      if (root) logoLink.href = root;
      img.addEventListener("load", function () { logoLink.hidden = false; });
      img.addEventListener("error", function () { logoLink.hidden = true; });
      img.src = data.logo;
    }
  }

  // ---- Map and base map --------------------------------------------------------
  function setupMap() {
    var bounds = L.latLngBounds([EXTENT.south, EXTENT.west], [EXTENT.north, EXTENT.east]);
    var maxBounds = L.latLngBounds([EXTENT.south - PAD, EXTENT.west - PAD], [EXTENT.north + PAD, EXTENT.east + PAD]);
    map = L.map("map", {
      minZoom: 0, maxZoom: 12, zoomSnap: 0.25, zoomDelta: 1,
      maxBounds: maxBounds, maxBoundsViscosity: 1, preferCanvas: true,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    map.zoomControl.setPosition("bottomright");
    // Panes, bottom to top: our land, OSM detail tiles (close zoom), hillshade, coast/roads, colour layer,
    // points, base labels, spots (marker pane), sun line.
    [["land", 150], ["shade", 250], ["lines", 260], ["field", 410], ["labels", 430], ["sun", 650], ["pin", 660]]
      .forEach(function (p) { map.createPane(p[0]).style.zIndex = p[1]; });
    ["land", "shade", "lines", "field", "labels", "sun"].forEach(function (p) { map.getPane(p).style.pointerEvents = "none"; });

    // Whole area at the lowest zoom (a phone is narrower than zoom 6); start close to Anchorage.
    map.setMinZoom(Math.min(6, map.getBoundsZoom(bounds)));
    map.fitBounds(START, { animate: false });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { map.invalidateSize({ animate: false }); }).observe($("map"));
    }
    L.tileLayer(TILES, { minZoom: DETAIL_ZOOM, maxZoom: 12, attribution: OSM_CREDIT }).addTo(map);
    L.imageOverlay("assets/hillshade.png", bounds, { pane: "shade", interactive: false, opacity: 0.85 }).addTo(map);
    detailLayers = L.layerGroup();   // our own coast, roads and labels: hidden once OSM detail shows
    fetch("assets/basemap.json").then(function (r) { return r.json(); }).then(drawBase, function () { /* sea + hillshade only */ });

    sunLayer = L.layerGroup().addTo(map);
    map.on("click", onTap);
    map.on("zoomend", toggleDetail);
    window.skyMap = map;   // handy for tests and debugging
  }

  function drawBase(base) {
    var layer = function (name) {
      return { type: "FeatureCollection", features: (base.features || []).filter(function (f) { return f.properties && f.properties.layer === name; }) };
    };
    var css = getComputedStyle(document.documentElement);
    L.geoJSON(layer("land"), { pane: "land", interactive: false,
      style: { stroke: false, fillColor: css.getPropertyValue("--land").trim(), fillOpacity: 1 } }).addTo(map);
    L.geoJSON(layer("lake"), { pane: "land", interactive: false,
      style: { stroke: false, fillColor: css.getPropertyValue("--sea").trim(), fillOpacity: 1 } }).addTo(map);
    L.geoJSON(layer("land"), { pane: "lines", interactive: false, style: { color: "#4b5d77", weight: 0.8, fill: false } }).addTo(detailLayers);
    L.geoJSON(layer("road"), { pane: "lines", interactive: false, style: { color: "#8a6f52", weight: 1.2, opacity: 0.7 } }).addTo(detailLayers);
    (base.towns || TOWNS).forEach(function (t) { label(t[0], t[1], t[2], "town", [3, 7]); });
    PEAKS.forEach(function (p) { label("▲ " + p[0], p[1], p[2], "peak", [5, 7]); });
    toggleDetail();
  }
  function label(text, lat, lon, cls, anchor) {
    var node = el("span", null, text);
    L.marker([lat, lon], { pane: "labels", interactive: false, keyboard: false,
      icon: L.divIcon({ className: cls, html: node, iconSize: null, iconAnchor: anchor }) }).addTo(detailLayers);
  }
  function toggleDetail() {
    var close = map.getZoom() >= DETAIL_ZOOM;
    if (close && map.hasLayer(detailLayers)) map.removeLayer(detailLayers);
    if (!close && !map.hasLayer(detailLayers)) detailLayers.addTo(map);
  }
  var TOWNS = [["Healy", 63.86, -148.97], ["Talkeetna", 62.32, -150.11], ["Wasilla", 61.58, -149.44],
    ["Palmer", 61.60, -149.11], ["Anchorage", 61.22, -149.90], ["Whittier", 60.77, -148.68], ["Valdez", 61.13, -146.35],
    ["Glennallen", 62.10, -145.60], ["Seward", 60.10, -149.44], ["Soldotna", 60.49, -151.06], ["Homer", 59.64, -151.55]];
  var PEAKS = [["Denali", 63.07, -151.00], ["Foraker", 62.96, -151.40], ["Spurr", 61.30, -152.25],
    ["Redoubt", 60.49, -152.74], ["Iliamna", 60.03, -153.09], ["Marcus Baker", 61.44, -147.75]];

  // ---- Controls: full screen, sun line, points ----------------------------------
  function setupControls() {
    ["btn-install", "btn-full", "btn-sun", "sunbox"].forEach(function (id) {
      L.DomEvent.disableClickPropagation($(id));
      L.DomEvent.disableScrollPropagation($(id));
    });
    $("btn-full").addEventListener("click", toggleFull);
    setupInstall();
    $("btn-sun").addEventListener("click", function () {
      showSun = !showSun; this.setAttribute("aria-pressed", String(showSun)); drawSun();
    });
    document.addEventListener("fullscreenchange", function () { if (!document.fullscreenElement) setFull(false); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("full") && !document.fullscreenElement) setFull(false);
    });
    var saved = null;
    try { saved = JSON.parse(store.get(PIN_KEY) || "null"); } catch (e) { /* ignore */ }
    var ok = saved && saved.length === 2 && isFinite(saved[0]) && isFinite(saved[1]);
    pin = L.marker(ok ? saved : HOME, {
      draggable: true, pane: "pin", autoPan: true, title: "Drag to move the sun line", alt: "Sun pin",
      icon: L.divIcon({ className: "", html: el("div", "pin"), iconSize: [26, 26], iconAnchor: [13, 13] }),
    });
    pin.on("dragstart", function () { dragging = true; })
      .on("drag", drawSun)
      .on("dragend", function () {
        dragging = false;
        movePin(pin.getLatLng());
      });
    setupLight();
  }

  // ---- Installable app ------------------------------------------------------------
  // Android (Chrome) offers "Install app" through beforeinstallprompt; inside the website's frame the
  // browser won't, so the button opens the map in its own tab where it can be installed.
  var installPrompt = null;
  function setupInstall() {
    var btn = $("btn-install");
    var standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    if (standalone) return;
    if ("serviceWorker" in navigator && window.isSecureContext) {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline support is optional */ });
    }
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      installPrompt = e;
      btn.hidden = false;
    });
    window.addEventListener("appinstalled", function () { btn.hidden = true; installPrompt = null; });
    // Phones always get the button: Chrome stops offering its own prompt for a while after an uninstall,
    // and iPhones never offer one, so then the button says how to install from the browser menu.
    var phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (phone) btn.hidden = false;
    btn.addEventListener("click", function () {
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt.userChoice.then(function () { installPrompt = null; }, function () {});
      } else if (inFrame()) {
        var a = el("a"); a.href = location.href; a.target = "_blank"; a.rel = "noopener"; a.click();
      } else {
        showInstallHelp();
      }
    });
  }

  function showInstallHelp() {
    var ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    var note = $("map-note");
    note.textContent = ios
      ? "To install SkyFire: tap the Share button, then “Add to Home Screen”."
      : "To install SkyFire: tap ⋮ at the top right of Chrome, then “Install app” or “Add to Home screen”.";
    note.hidden = false;
    clearTimeout(showInstallHelp.timer);
    showInstallHelp.timer = setTimeout(function () { note.hidden = true; }, 9000);
  }

  function setFull(on) {
    document.body.classList.toggle("full", on);
    var b = $("btn-full");
    b.setAttribute("aria-pressed", String(on));
    var label = b.querySelector("span");
    if (label) label.textContent = on ? "Exit full screen" : "Full screen";
    b.title = on ? "Exit full screen" : "Full screen";
    if (map) setTimeout(function () { map.invalidateSize({ animate: false }); }, 60);
  }
  function inFrame() { try { return window.self !== window.top; } catch (e) { return true; } }
  function toggleFull() {
    var on = !document.body.classList.contains("full");
    if (!on) {
      if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
      setFull(false);
      return;
    }
    var root = document.documentElement;
    var fallback = function () {
      // Inside the website's frame without full-screen permission: open the map in its own tab instead.
      if (inFrame()) { var a = el("a"); a.href = location.href; a.target = "_blank"; a.rel = "noopener"; a.click(); }
      else setFull(true);
    };
    if (root.requestFullscreen) root.requestFullscreen().then(function () { setFull(true); }, fallback);
    else fallback();
  }

  // ---- Tabs ------------------------------------------------------------------
  function showTab(id, remember) {
    var tab = index.tabs.filter(function (t) { return t.id === id; })[0];
    if (!tab) return;
    current = tab;
    if (remember) store.set(STORE_KEY, id);
    Array.prototype.forEach.call($("tabs").children, function (b) {
      var on = b.dataset.id === id;
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    setWhen(tab);

    var mapEl = $("map");
    delete mapEl.dataset.dots;
    mapEl.dataset.tab = id;
    map.closePopup();
    clearField();
    hideNote();

    if (!tab.file) { showNote(tab.error || "This map could not be drawn."); drawSun(); return; }
    var token = ++loadToken;
    loadTab(tab).then(function (file) {
      if (token !== loadToken) return;
      drawTab(tab, file);
    }, function () {
      if (token !== loadToken) return;
      showNote("This map could not be loaded. Please try again later.");
    });
  }

  function loadTab(tab) {
    if (!tabFiles[tab.file]) {
      tabFiles[tab.file] = fetch("data/" + tab.file, { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
      tabFiles[tab.file].catch(function () { delete tabFiles[tab.file]; });
    }
    return tabFiles[tab.file];
  }

  function showNote(text) {
    var note = $("map-note");
    note.textContent = text;
    note.hidden = false;
    $("legend").hidden = true;
  }
  function hideNote() { $("map-note").hidden = true; }

  function clearField() {
    if (fieldLayer) { map.removeLayer(fieldLayer); fieldLayer = null; }
    $("hours").hidden = true;
  }

  // The explainer under the map, for the kind of map on show.
  var HOW = {
    sky: "Colours show the % chance of a colourful sky, from grey (little chance) through yellow and orange to red and magenta (best). Tap the map to move the sun pin there and see the chance: the panel under the map checks, minute by minute until dark, whether the sun's light gets through the clouds to you and which clouds stay lit after sunset, and the rings show where low, mid and high clouds meet your horizon.",
    aurora: "Colours show where the night sky should be clear for the northern lights: green is clear and dark, blue is clear but still in twilight, teal is clear toward the north, and white-grey is cloud. Look north. Tap the map for the cloud overhead and to the north.",
    meteor: "Colours show where the night sky should be clear for meteors: green is clear and dark, blue is clear but still in twilight, and white-grey is cloud. Tap the map for the cloud overhead.",
    nlc: "Noctilucent clouds glow low in the northern sky an hour or two after sunset in summer. Blue shows where the northern sky should be clear; white-grey is cloud. Tap the map for the cloud to the north.",
    denali: "Colours show the chance of seeing Denali from each spot at the hour you pick, from red (cloud in the way) through amber to green (clear view); dark is where hills hide the mountain. Tap the map to move the pin: the line to Denali is green where the way is clear and red where cloud sits on it, and the box gives the % chance, how much of the mountain clears the hills, and the best hour in the next 2 days.",
  };
  // ---- Space weather now (Aurora tab): NOAA SWPC, refreshed every 5 minutes while showing ----------
  var SWPC = "https://services.swpc.noaa.gov";
  var space = { timer: null, last: 0 };
  function getJ(url) { return fetch(url, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }); }
  function newest(rows, field) {   // newest row with a number in `field` (feeds come oldest- or newest-first)
    var best = null;
    (rows || []).forEach(function (r) {
      var v = r && r[field];
      if (v === null || v === undefined || v === "" || isNaN(+v)) return;
      if (r.active === false) return;
      if (!best || r.time_tag > best.time_tag) best = r;
    });
    return best;
  }
  function spaceShow(on) {
    $("space").hidden = !on;
    clearInterval(space.timer);
    if (!on) return;
    if (Date.now() - space.last > 4 * 60000) loadSpace();
    space.timer = setInterval(function () { if (!document.hidden) loadSpace(); }, 5 * 60000);
  }
  function loadSpace() {
    space.last = Date.now();
    var kp = getJ(SWPC + "/json/planetary_k_index_1m.json").then(function (rows) { return newest(rows, "estimated_kp"); }).catch(function () { return null; });
    var fc = getJ(SWPC + "/products/noaa-planetary-k-index-forecast.json").catch(function () { return null; });
    // small "latest value" summaries first; the 1-minute files (large) only if those fail
    var mag = getJ(SWPC + "/products/summary/solar-wind-mag-field.json").then(function (j) {
      if (j && j.Bz !== undefined) return { bz: +j.Bz, bt: +j.Bt, time: j.TimeStamp };
      throw new Error("no Bz");
    }).catch(function () {
      return getJ(SWPC + "/json/rtsw/rtsw_mag_1m.json").then(function (rows) { var r = newest(rows, "bz_gsm"); return r && { bz: +r.bz_gsm, bt: +r.bt, time: r.time_tag }; });
    }).catch(function () { return null; });
    var wind = getJ(SWPC + "/products/summary/solar-wind-speed.json").then(function (j) {
      if (j && j.WindSpeed !== undefined) return { speed: +j.WindSpeed, time: j.TimeStamp };
      throw new Error("no speed");
    }).catch(function () {
      return getJ(SWPC + "/json/rtsw/rtsw_wind_1m.json").then(function (rows) { var r = newest(rows, "proton_speed"); return r && { speed: +r.proton_speed, time: r.time_tag }; });
    }).catch(function () { return null; });
    Promise.all([kp, fc, mag, wind]).then(function (g) { renderSpace(g[0], g[1], g[2], g[3]); });
  }
  function utc(t) { return Date.parse(String(t).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(t)) ? "" : "Z")); }
  function swItem(label, value, unit, grade, sub) {
    var box = el("div", "sw-item " + grade);
    box.appendChild(el("b", null, value + (unit ? " " + unit : "")));
    box.appendChild(el("span", null, label + (sub ? " · " + sub : "")));
    return box;
  }
  function ago(ms) {
    if (!isFinite(ms)) return "";
    var m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
  }
  function renderSpace(kp, fc, mag, wind) {
    var now = $("space-now");
    now.textContent = "";
    if (!kp && !mag && !wind) {
      now.appendChild(el("p", "space-note", "Live space weather couldn't be loaded. Check your connection; it retries every 5 minutes."));
    }
    if (kp) {
      var k = +kp.estimated_kp;
      now.appendChild(swItem("Kp now", k.toFixed(1), "", k >= 4 ? "good" : k >= 2.5 ? "ok" : "poor", ago(utc(kp.time_tag))));
    }
    if (mag && isFinite(mag.bz)) {
      now.appendChild(swItem("Bz " + (mag.bz < 0 ? "south" : "north"), (mag.bz > 0 ? "+" : "") + mag.bz.toFixed(1), "nT",
        mag.bz <= -5 ? "good" : mag.bz < 0 ? "ok" : "poor", ago(utc(mag.time))));
    }
    if (wind && isFinite(wind.speed)) {
      now.appendChild(swItem("Solar wind", Math.round(wind.speed), "km/s", wind.speed >= 500 ? "good" : wind.speed >= 400 ? "ok" : "poor", ago(utc(wind.time))));
    }
    // the next few 3-hour Kp forecast periods, Alaska time
    var line = $("space-fc");
    line.textContent = "";
    var rows = (fc || []).filter(function (r) { return r && r.observed !== "observed" && utc(r.time_tag) + 3 * 3600e3 > Date.now(); }).slice(0, 4);
    if (rows.length) {
      line.appendChild(document.createTextNode("Kp forecast: "));
      rows.forEach(function (r, i) {
        var t0 = utc(r.time_tag);
        line.appendChild(el("b", null, (+r.kp).toFixed(1)));
        line.appendChild(document.createTextNode(" " + timeOnly(new Date(t0).toISOString()) + "–" + timeOnly(new Date(t0 + 3 * 3600e3).toISOString()) + (i < rows.length - 1 ? " · " : "")));
      });
    }
    $("space-note").textContent = "Around Anchorage, Kp 2–3 can show low in the north on a dark, clear night; Kp 4+ is a good chance. " +
      "Bz pointing south (negative), especially below −5 nT for a while, makes aurora much more likely. NOAA SWPC, updated " +
      timeOnly(new Date().toISOString()) + ".";
    $("map").dataset.space = [kp ? "kp" : "", mag ? "bz" : "", wind ? "wind" : ""].join(",");
  }

  function setHow(mapType) {
    spaceShow(mapType === "aurora");
    var how = document.querySelector(".site-footer .how");
    if (how && HOW[mapType]) how.textContent = HOW[mapType];
  }

  function drawTab(tab, file) {
    current.data = file;
    setHow(file.map_type);
    if (file.map_type === "denali") { drawDenaliTab(tab, file); return; }
    $("hours").hidden = true;
    if (!file.grid) file.grid = buildGrid(file.dots);
    if (!file.image) file.image = renderField(file);
    if (file.image) {
      fieldLayer = L.imageOverlay(file.image, [[EXTENT.south, EXTENT.west], [EXTENT.north, EXTENT.east]],
        { pane: "field", className: "field", interactive: false, opacity: opacity }).addTo(map);
    }
    showKey(file.map_type);
    drawSun();
    var mapEl = $("map");
    mapEl.dataset.opacity = String(opacity);
    mapEl.dataset.dots = String(file.dots.length);
  }

  // ---- The colour layer --------------------------------------------------------
  // The forecast points sit on a hex lattice: rows of equal latitude, odd rows shifted east.
  // Recover rows and columns from the points themselves so any spacing works.
  function median(xs) { xs = xs.slice().sort(function (a, b) { return a - b; }); return xs.length ? xs[xs.length >> 1] : 0; }
  function buildGrid(dots) {
    if (!dots.length) return null;
    var byLat = {};
    dots.forEach(function (d, i) { (byLat[d[0].toFixed(4)] = byLat[d[0].toFixed(4)] || []).push(i); });
    var lats = Object.keys(byLat).map(Number).sort(function (a, b) { return a - b; });
    var gaps = [], lonGaps = [];
    for (var i = 1; i < lats.length; i++) gaps.push(lats[i] - lats[i - 1]);
    var dlat = gaps.length ? Math.min.apply(null, gaps) : 0.05;
    var lat0 = lats[0], rows = Math.round((lats[lats.length - 1] - lat0) / dlat) + 1;
    lats.forEach(function (la) {
      var lons = byLat[la.toFixed(4)].map(function (j) { return dots[j][1]; }).sort(function (a, b) { return a - b; });
      for (var k = 1; k < lons.length; k++) lonGaps.push(lons[k] - lons[k - 1]);
    });
    var dlon = lonGaps.length ? Math.min.apply(null, lonGaps.filter(function (g) { return g > 1e-6; })) : 0.1;
    var start = [Infinity, Infinity];   // western-most lon of even / odd rows
    dots.forEach(function (d) {
      var r = Math.round((d[0] - lat0) / dlat);
      start[r % 2] = Math.min(start[r % 2], d[1]);
    });
    if (!isFinite(start[1])) start[1] = start[0];
    // Snap the odd-row start onto the even-row lattice (half a step east is the usual shift).
    var cols = 0, cells;
    var colOf = function (r, lon) { return Math.round((lon - start[r % 2]) / dlon); };
    dots.forEach(function (d) { cols = Math.max(cols, colOf(Math.round((d[0] - lat0) / dlat), d[1]) + 1); });
    cells = new Int32Array(rows * cols).fill(-1);
    dots.forEach(function (d, j) {
      var r = Math.round((d[0] - lat0) / dlat), c = colOf(r, d[1]);
      if (r >= 0 && r < rows && c >= 0 && c < cols) cells[r * cols + c] = j;
    });
    return { lat0: lat0, dlat: dlat, dlon: dlon, start: start, rows: rows, cols: cols, cells: cells, median: median(gaps) };
  }

  // Sunrise/sunset: one scale by the % chance of colour (grey, yellow, orange, red, magenta).
  var CHANCE_STOPS = [[0, [175, 183, 196, 0.40]], [25, [242, 196, 48, 0.55]], [50, [255, 140, 50, 0.68]],
                      [75, [236, 64, 96, 0.78]], [100, [190, 70, 220, 0.88]]];
  function chanceRGBA(pct) {
    var i = 1;
    while (i < CHANCE_STOPS.length - 1 && pct > CHANCE_STOPS[i][0]) i++;
    var a = CHANCE_STOPS[i - 1], b = CHANCE_STOPS[i], f = Math.max(0, Math.min(1, (pct - a[0]) / (b[0] - a[0])));
    return [0, 1, 2, 3].map(function (k) { return a[1][k] + (b[1][k] - a[1][k]) * f; });
  }
  function rgbaOf(d) {
    var chance = d[7] && d[7].chance;
    if (typeof chance === "number") {
      var c = chanceRGBA(chance);
      return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
    }
    var s = STYLE[d[2]];
    if (!s) {   // a kind this page has no colour for: use its legend colour, half see-through
      var hex = /^#([0-9a-f]{6})$/i.exec(d[3] || "");
      var n = hex ? parseInt(hex[1], 16) : 0x888888;
      s = [n >> 16, (n >> 8) & 255, n & 255, 0.45, 0];
    }
    var a = Math.min(0.95, s[3] + s[4] * (d[4] || 0));
    return [s[0] * a, s[1] * a, s[2] * a, a];   // premultiplied
  }

  // Blend between neighbouring points (premultiplied, so colour never bleeds out of see-through areas),
  // drawn in Web Mercator so it lines up with the map. Rendered small; the browser smooths it when scaled up.
  function renderField(file) {
    var g = file.grid;
    if (!g) return null;
    var cells = new Float32Array(g.rows * g.cols * 4);
    for (var i = 0; i < g.cells.length; i++) if (g.cells[i] >= 0) cells.set(rgbaOf(file.dots[g.cells[i]]), i * 4);
    var merc = function (la) { return Math.log(Math.tan(Math.PI / 4 + la * RAD / 2)); };
    var y0 = merc(EXTENT.north), y1 = merc(EXTENT.south);
    var lonSpan = EXTENT.east - EXTENT.west;
    var W = Math.max(120, Math.min(900, Math.round(3 * lonSpan / g.dlon)));
    var H = Math.round(W * (y0 - y1) / (lonSpan * RAD));
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), px = img.data;
    var a = [0, 0, 0, 0], b = [0, 0, 0, 0];
    function rowSample(r, lon, out) {
      out[0] = out[1] = out[2] = out[3] = 0;
      if (r < 0 || r >= g.rows) return;
      var cc = (lon - g.start[r % 2]) / g.dlon, c0 = Math.floor(cc), f = cc - c0;
      for (var k = 0; k < 2; k++) {
        var c = c0 + k, w = k ? f : 1 - f;
        if (c < 0 || c >= g.cols || w === 0) continue;
        var o = (r * g.cols + c) * 4;
        out[0] += cells[o] * w; out[1] += cells[o + 1] * w; out[2] += cells[o + 2] * w; out[3] += cells[o + 3] * w;
      }
    }
    for (var y = 0; y < H; y++) {
      var lat = (2 * Math.atan(Math.exp(y0 + (y1 - y0) * (y + 0.5) / H)) - Math.PI / 2) / RAD;
      var rr = (lat - g.lat0) / g.dlat, r0 = Math.floor(rr), fr = rr - r0;
      if (rr < -0.5 || rr > g.rows - 0.5) continue;
      for (var x = 0; x < W; x++) {
        var lon = EXTENT.west + lonSpan * (x + 0.5) / W;
        rowSample(r0, lon, a); rowSample(r0 + 1, lon, b);
        if (r0 < 0) { a = b.slice(); } else if (r0 + 1 >= g.rows) { b = a.slice(); }
        var al = a[3] * (1 - fr) + b[3] * fr, o = (y * W + x) * 4;
        if (al > 0.003) {
          px[o] = (a[0] * (1 - fr) + b[0] * fr) / al;
          px[o + 1] = (a[1] * (1 - fr) + b[1] * fr) / al;
          px[o + 2] = (a[2] * (1 - fr) + b[2] * fr) / al;
          px[o + 3] = al * 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    if ("filter" in ctx) {   // soften the row steps a little more where canvas filters exist
      var out = document.createElement("canvas");
      out.width = W; out.height = H;
      var octx = out.getContext("2d");
      octx.filter = "blur(1px)";
      octx.drawImage(cv, 0, 0);
      cv = out;
    }
    return cv.toDataURL("image/png");
  }

  // ---- Tap anywhere: the forecast at the nearest point ------------------------
  function nearestDot(file, lat, lon) {
    var g = file.grid;
    if (g) {
      var r = Math.round((lat - g.lat0) / g.dlat);
      if (r >= 0 && r < g.rows) {
        var c = Math.round((lon - g.start[r % 2]) / g.dlon);
        if (c >= 0 && c < g.cols && g.cells[r * g.cols + c] >= 0) return file.dots[g.cells[r * g.cols + c]];
      }
    }
    var k = Math.cos(lat * RAD), best = null, bestD = Infinity;
    file.dots.forEach(function (d) {
      var dy = d[0] - lat, dx = (d[1] - lon) * k, dist = dx * dx + dy * dy;
      if (dist < bestD) { bestD = dist; best = d; }
    });
    var limit = g ? 2 * Math.max(g.dlat, g.dlon * k) : 0.2;
    return bestD <= limit * limit ? best : null;
  }

  // Put the pin somewhere new (tap or drag): remember it and redraw the line and light check.
  function movePin(ll) {
    if (!pin) return;
    pin.setLatLng(ll);
    store.set(PIN_KEY, JSON.stringify([ll.lat, ll.lng]));
    light.key = null;
    drawSun();
  }

  function onTap(e) {
    var tab = current, file = tab && tab.data;
    var pinTab = file && tab.file && showSun && (file.map_type === "sky" || file.map_type === "denali");
    if (pinTab) movePin(e.latlng);
    if (file && tab.file && file.map_type === "denali") { denaliPopup(file, e.latlng); return; }
    if (!file || !tab.file || !file.dots || !file.dots.length) return;
    var d = nearestDot(file, e.latlng.lat, e.latlng.lng);
    if (!d) return;
    L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(dotPopup(tab, file, d, null)).openOn(map);
  }

  function kindLabel(mapType, kind) {
    var rows = (index.legend && index.legend[mapType]) || [];
    for (var i = 0; i < rows.length; i++) if (rows[i][0] === kind) return rows[i][2];
    return kind;
  }

  function swatchColour(d) {
    var s = STYLE[d[2]];
    return s ? "rgb(" + s.slice(0, 3).join(",") + ")" : d[3];
  }

  function dotPopup(tab, file, d, heading) {
    var box = el("div", "pop");
    if (heading) box.appendChild(el("p", "pop-name", heading));
    var m = d[7] || {};
    if (typeof m.chance === "number") box.appendChild(el("p", "pop-chance", tab.label + ": " + m.chance + "% chance"));
    var head = el("p", "pop-head");
    var swatch = el("span", "pop-swatch");
    swatch.style.background = swatchColour(d);
    head.appendChild(swatch);
    var words = [kindLabel(file.map_type, d[2])];
    if (d[5]) words.push(capital(d[5]));
    if (d[6]) words.push("models disagree");
    head.appendChild(document.createTextNode(words.join(" · ")));
    box.appendChild(head);
    box.appendChild(el("p", "pop-when", tab.label + " " + weekdayTime(file.when || tab.when)));
    var metrics = "block" in m
      ? "Light blocked " + m.block + "% · Cloud canvas " + m.canvas + "%"
      : "Cloud overhead " + m.overhead + "% · to the north " + m.north + "%";
    box.appendChild(el("p", "pop-metrics", metrics));
    return box;
  }

  // ---- Public spots ----------------------------------------------------------
  function addSpots(spots) {
    spots.forEach(function (s) {
      var icon = el("span", "spot-inner");
      icon.appendChild(el("span", "spot-star", "★"));
      icon.appendChild(el("span", "spot-label", s.name));
      var marker = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: "spot-marker", html: icon, iconSize: null, iconAnchor: [7, 9] }),
        title: s.name, alt: s.name, riseOnHover: true, zIndexOffset: 1000,
      }).addTo(map);
      marker.bindPopup(function () { return spotPopup(s); }, { maxWidth: 260 });
    });
  }

  function spotPopup(s) {
    var tab = current, file = tab && tab.data;
    var d = file && tab.file && file.dots && file.dots.length ? nearestDot(file, s.lat, s.lon) : null;
    if (!d) {
      var box = el("div", "pop");
      box.appendChild(el("p", "pop-name", s.name));
      return box;
    }
    return dotPopup(tab, file, d, s.name);
  }

  // ---- Colour key ---------------------------------------------------------------
  function showKey(mapType) {
    var key = KEYS[mapType];
    var bar = $("key-bar"), ticks = $("key-ticks");
    ticks.textContent = "";
    if (mapType === "sky") {   // the % chance scale
      bar.style.background = "linear-gradient(90deg," + CHANCE_STOPS.map(function (st) {
        var c = st[1]; return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.min(1, c[3] + 0.15) + ") " + st[0] + "%";
      }).join(",") + ")";
      ["0%", "25%", "50%", "75%", "100% chance of colour"].forEach(function (t) { ticks.appendChild(el("span", null, t)); });
      $("legend").hidden = false;
      return;
    }
    if (!key) {   // unknown map type: fall back to the legend's own colours
      key = ((index.legend && index.legend[mapType]) || []).map(function (row) { return [row[0], row[2], row[1]]; });
    }
    var stops = key.map(function (k, i) {
      var s = STYLE[k[0]];
      var colour = s ? "rgba(" + s.slice(0, 3).join(",") + "," + Math.min(1, s[3] + s[4] + 0.2) + ")" : (k[2] || "#888");
      return colour + " " + Math.round(100 * i / Math.max(1, key.length - 1)) + "%";
    });
    bar.style.background = stops.length > 1 ? "linear-gradient(90deg," + stops.join(",") + ")" : (stops[0] || "none");
    key.forEach(function (k) { ticks.appendChild(el("span", null, k[1])); });
    $("legend").hidden = !key.length;
  }

  // ---- Denali View ---------------------------------------------------------------
  // denali.json: hourly low/mid/high cloud on 0.25° nodes. assets/denali_los.json: metres of the mountain that
  // clear the terrain and the Earth's curve from each place. The % is worked out here for any spot.
  var DENALI_MIN_M = 300;     // less than this showing over the hills counts as hidden
  var denaliHour = 0, losGrid = null, losLoading = null;

  function loadLos() {
    if (!losLoading) {
      losLoading = fetch("assets/denali_los.json").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (g) { losGrid = g; return g; }, function () { losLoading = null; return null; });
    }
    return losLoading;
  }
  function losAt(lat, lon) {   // metres of Denali showing, or null when unknown (outside the grid / not loaded)
    var g = losGrid;
    if (!g) return null;
    var r = Math.round((lat - g.lat0) / g.dlat), c = Math.round((lon - g.lon0) / g.dlon);
    if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) return null;
    return g.visible[r * g.cols + c] * g.unit_m;
  }
  function coverAt(file, layer, hi, lat, lon) {   // bilinear over the cloud nodes; -1 = no data
    var n = file.nodes, vals = file[layer][hi];
    var rr = (lat - n.lat0) / n.step, cc = (lon - n.lon0) / n.step;
    var r0 = Math.floor(rr), c0 = Math.floor(cc), fy = rr - r0, fx = cc - c0, sum = 0, wsum = 0;
    for (var dy = 0; dy < 2; dy++) for (var dx = 0; dx < 2; dx++) {
      var r = r0 + dy, c = c0 + dx;
      if (r < 0 || r >= n.rows || c < 0 || c >= n.cols) continue;
      var v = vals[r * n.cols + c];
      if (v < 0) continue;
      var w = (dy ? fy : 1 - fy) * (dx ? fx : 1 - fx);
      sum += v * w; wsum += w;
    }
    return wsum > 0 ? sum / wsum : -1;
  }
  function p80(xs) {
    xs = xs.filter(function (x) { return x >= 0; }).sort(function (a, b) { return a - b; });
    return xs.length ? xs[Math.min(xs.length - 1, Math.floor(0.8 * xs.length))] : 0;
  }
  function distKm(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    var a = Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
    return 2 * R_KM * Math.asin(Math.sqrt(a));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    var y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  // Follow the sightline to the summit: while it is under LOW_TOP_M, low cloud on the way blocks it; above
  // that, mid cloud does. Mid cloud over the mountain (a cloud cap) hides the summit; high cloud only dims it.
  // Each layer counts at its 80th percentile along the way.
  var LOW_TOP_M = 2000, EYE_M = 50, REFRACTION_K = 0.13;
  function curveDrop(km) { return Math.pow(km * 1000, 2) * (1 - REFRACTION_K) / (2 * R_KM * 1000); }
  function denaliView(file, hi, lat, lon) {
    var t = file.target, shows = losAt(lat, lon);
    var dist = distKm(lat, lon, t.lat, t.lon), n = Math.max(6, Math.ceil(dist / 12));
    var rise = t.elev_m - EYE_M - curveDrop(dist);
    var lows = [], mids = [], segs = [];
    for (var i = 0; i < n; i++) {
      var f = (i + 0.5) / n, la = lat + (t.lat - lat) * f, lo = lon + (t.lon - lon) * f;
      var height = EYE_M + rise * f + curveDrop(f * dist);   // sightline above sea level here
      var layer = height < LOW_TOP_M ? "low" : "mid", cover = coverAt(file, layer, hi, la, lo);
      if (cover >= 0) (layer === "low" ? lows : mids).push(cover);
      segs.push(Math.max(0, cover));
    }
    var cap = Math.max(0, coverAt(file, "mid", hi, t.lat, t.lon));
    mids.push(cap);
    var high = Math.max(0, coverAt(file, "high", hi, t.lat, t.lon));
    var L1 = p80(lows), M = p80(mids);
    var chance = 5 * Math.round(20 * (1 - L1 / 100) * (1 - M / 100) * (1 - 0.3 * high / 100));
    return { chance: chance, hidden: shows !== null && shows < DENALI_MIN_M, shows: shows, dist: dist,
             az: bearing(lat, lon, t.lat, t.lon), segs: segs, cap: cap, low: L1, mid: M, high: high };
  }
  function denaliRGBA(v) {   // premultiplied colour for one place
    var pick = function (k) { var s = STYLE[k]; return [s[0], s[1], s[2], s[3]]; };
    var a = pick("d0"), m = pick("d50"), b = pick("d100"), x = v.chance / 100, lo = x < 0.5 ? a : m, hi = x < 0.5 ? m : b;
    var f = x < 0.5 ? x / 0.5 : (x - 0.5) / 0.5;
    var c = [0, 1, 2, 3].map(function (k) { return lo[k] + (hi[k] - lo[k]) * f; });
    // fade to "hills in the way" as less of the mountain clears the terrain
    var open = v.shows == null ? 1 : Math.max(0, Math.min(1, (v.shows - 100) / 700)), h = pick("hidden");
    c = [0, 1, 2, 3].map(function (k) { return h[k] + (c[k] - h[k]) * open; });
    return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]];
  }
  function hourLabel(iso) { var p = parts(iso); return { day: p.weekday, time: p.hour + (p.minute === "00" ? "" : ":" + p.minute) + " " + p.dayPeriod }; }

  function drawDenaliTab(tab, file) {
    loadLos().then(function () {
      if (current !== tab) return;
      if (denaliHour >= file.hours.length) denaliHour = 0;
      drawHours(file);
      drawDenaliField(file);
      showKey("denali");
      drawSun();
      var mapEl = $("map");
      mapEl.dataset.opacity = String(opacity);
      mapEl.dataset.dots = String(file.hours.length);
    });
  }
  function drawHours(file) {
    var box = $("hours");
    box.textContent = "";
    var lastDay = null;
    file.hours.forEach(function (iso, i) {
      var h = hourLabel(iso), b = el("button", "hour");
      b.type = "button";
      b.setAttribute("aria-pressed", String(i === denaliHour));
      if (h.day !== lastDay) { b.appendChild(el("b", null, h.day)); lastDay = h.day; }
      b.appendChild(document.createTextNode(h.time));
      b.addEventListener("click", function () {
        denaliHour = i;
        Array.prototype.forEach.call(box.children, function (x, j) { x.setAttribute("aria-pressed", String(j === i)); });
        drawDenaliField(file);
        drawSun();
        map.closePopup();
      });
      box.appendChild(b);
    });
    box.hidden = false;
  }
  function drawDenaliField(file) {
    if (fieldLayer) { map.removeLayer(fieldLayer); fieldLayer = null; }
    file.images = file.images || {};
    if (!file.images[denaliHour] && losGrid) {
      var g = losGrid, cells = new Float32Array(g.rows * g.cols * 4);
      for (var r = 0; r < g.rows; r++) for (var c = 0; c < g.cols; c++) {
        cells.set(denaliRGBA(denaliView(file, denaliHour, g.lat0 + r * g.dlat, g.lon0 + c * g.dlon)), (r * g.cols + c) * 4);
      }
      file.images[denaliHour] = renderRegular(g, cells);
    }
    if (file.images[denaliHour]) {
      fieldLayer = L.imageOverlay(file.images[denaliHour], [[EXTENT.south, EXTENT.west], [EXTENT.north, EXTENT.east]],
        { pane: "field", className: "field", interactive: false, opacity: opacity }).addTo(map);
    }
  }
  // Regular lat/lon grid (rows south to north) to a Web Mercator image, blended between cells.
  function renderRegular(g, cells) {
    var merc = function (la) { return Math.log(Math.tan(Math.PI / 4 + la * RAD / 2)); };
    var y0 = merc(EXTENT.north), y1 = merc(EXTENT.south), lonSpan = EXTENT.east - EXTENT.west;
    var W = Math.min(900, g.cols * 4), H = Math.round(W * (y0 - y1) / (lonSpan * RAD));
    var cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), px = img.data;
    for (var y = 0; y < H; y++) {
      var lat = (2 * Math.atan(Math.exp(y0 + (y1 - y0) * (y + 0.5) / H)) - Math.PI / 2) / RAD;
      var rr = Math.max(0, Math.min(g.rows - 1.0001, (lat - g.lat0) / g.dlat)), r0 = Math.floor(rr), fy = rr - r0;
      for (var x = 0; x < W; x++) {
        var lon = EXTENT.west + lonSpan * (x + 0.5) / W;
        var cc = Math.max(0, Math.min(g.cols - 1.0001, (lon - g.lon0) / g.dlon)), c0 = Math.floor(cc), fx = cc - c0;
        var o = (y * W + x) * 4, acc = [0, 0, 0, 0];
        for (var k = 0; k < 4; k++) {
          var r = r0 + (k >> 1), c = c0 + (k & 1), w = ((k >> 1) ? fy : 1 - fy) * ((k & 1) ? fx : 1 - fx), q = (r * g.cols + c) * 4;
          acc[0] += cells[q] * w; acc[1] += cells[q + 1] * w; acc[2] += cells[q + 2] * w; acc[3] += cells[q + 3] * w;
        }
        if (acc[3] > 0.003) {
          px[o] = acc[0] / acc[3]; px[o + 1] = acc[1] / acc[3]; px[o + 2] = acc[2] / acc[3]; px[o + 3] = acc[3] * 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    if ("filter" in ctx) {
      var out = document.createElement("canvas");
      out.width = W; out.height = H;
      var octx = out.getContext("2d");
      octx.filter = "blur(2px)";
      octx.drawImage(cv, 0, 0);
      cv = out;
    }
    return cv.toDataURL("image/png");
  }
  // The Denali scale as a CSS colour, x from 0 (no chance) to 1 (clear).
  function scaleColour(x) {
    var a = STYLE.d0, m = STYLE.d50, b = STYLE.d100, lo = x < 0.5 ? a : m, hi = x < 0.5 ? m : b, f = x < 0.5 ? x / 0.5 : (x - 0.5) / 0.5;
    return "rgb(" + [0, 1, 2].map(function (k) { return Math.round(lo[k] + (hi[k] - lo[k]) * f); }).join(",") + ")";
  }
  function denaliWords(v) {
    if (v.hidden) return "Hills hide Denali from here";
    return "Denali: " + v.chance + "% chance";
  }
  function denaliPopup(file, ll) {
    var v = denaliView(file, denaliHour, ll.lat, ll.lng), box = el("div", "pop");
    box.appendChild(el("p", "pop-chance", denaliWords(v)));
    var h = hourLabel(file.hours[denaliHour]);
    box.appendChild(el("p", "pop-when", h.day + " " + h.time + " · " + Math.round(v.dist) + " km away"));
    if (!v.hidden) {
      box.appendChild(el("p", "pop-metrics", "Low cloud on the way " + Math.round(v.low) + "% · mid cloud " +
        Math.round(v.mid) + "% · cloud on the mountain " + Math.round(v.cap) + "%"));
    }
    L.popup({ maxWidth: 260 }).setLatLng(ll).setContent(box).openOn(map);
  }
  function drawDenaliLine(file) {
    var box = $("sunbox"), t = file.target;
    L.marker([t.lat, t.lon], { pane: "sun", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "denali-mark", html: el("span", null, "▲ Denali"), iconSize: null, iconAnchor: [6, 8] }) }).addTo(sunLayer);
    if (!showSun) {
      if (pin && map.hasLayer(pin)) map.removeLayer(pin);
      box.hidden = true;
      return;
    }
    if (!map.hasLayer(pin)) pin.addTo(map);
    box.hidden = false;
    var p = pin.getLatLng(), v = denaliView(file, denaliHour, p.lat, p.lng), n = v.segs.length;
    for (var i = 0; i < n; i++) {
      var a = [p.lat + (t.lat - p.lat) * i / n, p.lng + (t.lon - p.lng) * i / n];
      var b = [p.lat + (t.lat - p.lat) * (i + 1) / n, p.lng + (t.lon - p.lng) * (i + 1) / n];
      var col = scaleColour(1 - v.segs[i] / 100);   // green where the way is clear, red where cloud sits on it
      L.polyline([a, b], { pane: "sun", color: v.hidden ? "#7d8796" : col, weight: 4, opacity: 0.95, lineCap: "butt", interactive: false }).addTo(sunLayer);
    }
    L.circleMarker([t.lat, t.lon], { pane: "sun", radius: 7, weight: 2, color: "#0d1420", fillOpacity: 1, interactive: false,
      fillColor: v.hidden ? "#7d8796" : scaleColour(1 - v.cap / 100) }).addTo(sunLayer);
    var h = hourLabel(file.hours[denaliHour]);
    box.appendChild(el("p", "sun-head", denaliWords(v) + " · " + h.day + " " + h.time));
    if (!v.hidden) box.appendChild(el("p", "sun-help", "Cloud on the way " + Math.round(Math.max(v.low, v.mid)) + "% · on the mountain " + Math.round(v.cap) + "%"));
    var shows = v.shows == null ? "" : v.hidden ? " · hills block the view" : " · top " + (Math.round(v.shows / 100) * 100).toLocaleString("en-US") + " m clears the hills";
    box.appendChild(el("p", "sun-help", Math.round(v.dist) + " km · " + Math.round(v.az) + "° " + compass(v.az) + shows));
    if (!v.hidden) {
      var best = 0, bestI = 0;
      file.hours.forEach(function (iso, i) { var c = denaliView(file, i, p.lat, p.lng).chance; if (c > best) { best = c; bestI = i; } });
      var bh = hourLabel(file.hours[bestI]);
      box.appendChild(el("p", "sun-key", "Best in the next 2 days: " + bh.day + " " + bh.time + " (" + best + "%)"));
    }
    box.appendChild(el("p", "sun-help", "Tap or drag the pin to any spot. The line is green where the way is clear, red where cloud sits on it."));
    $("map").dataset.denali = v.hidden ? "hidden" : String(v.chance);
  }

  // ---- Sun line ----------------------------------------------------------------
  // Solar position (NOAA-style low-precision formulae, ~0.1°).
  function sunPos(ms, lat, lon) {
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
  // The sunrise or sunset nearest the tab's time, for wherever the pin is.
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
    return { time: new Date(ms), az: sunPos(ms, lat, lon).az };
  }
  function dest(lat, lon, az, km) {
    var d = km / R_KM, la = lat * RAD, lo = lon * RAD, b = az * RAD;
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 / RAD, lo2 / RAD];
  }
  // How far away a cloud base meets your horizon (from sea level), as in SkyFire's own scoring.
  function horizonKm(cloudM) { return Math.sqrt(2 * R_KM * cloudM / 1000); }
  function compass(az) {
    return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(az / 22.5) % 16];
  }

  var BANDS = [[400, 1200, "#ff9b5c", "Low cloud"], [2000, 4000, "#c58bff", "Mid cloud"]];

  function drawSun() {
    sunLayer.clearLayers();
    var box = $("sunbox");
    box.textContent = "";
    var file = current && current.data, type = file ? file.map_type : null;
    $("line-label").textContent = type === "denali" ? "Denali line" : "Sun line";
    if (type !== "sky" || !current.file || !showSun) { lightOff(); if (rayLayer) rayLayer.clearLayers(); }
    if (type === "denali" && current.file) { drawDenaliLine(file); return; }
    var sky = type === "sky" && current.file;
    if (!sky || !showSun) {
      if (pin && map.hasLayer(pin)) map.removeLayer(pin);
      var hint = current && current.file && NIGHT_HINT[type];
      box.hidden = !hint;
      if (hint) box.appendChild(el("p", "sun-help", hint));
      return;
    }
    if (!map.hasLayer(pin)) pin.addTo(map);
    box.hidden = false;
    var p = pin.getLatLng(), rising = /sunrise/i.test(current.id + " " + current.label);
    var ev = sunEvent(p.lat, p.lng, file.when || current.when, rising);
    if (!ev) { box.appendChild(el("p", "sun-head", "No " + (rising ? "sunrise" : "sunset") + " here today")); return; }
    var far = dest(p.lat, p.lng, ev.az, 260), back = dest(p.lat, p.lng, ev.az + 180, 60);
    L.polyline([[p.lat, p.lng], far], { pane: "sun", color: "#ffd27a", weight: 2, opacity: 0.95, dashArray: "6 6", interactive: false }).addTo(sunLayer);
    L.polyline([[p.lat, p.lng], back], { pane: "sun", color: "#ffd27a", weight: 1.5, opacity: 0.5, dashArray: "2 6", interactive: false }).addTo(sunLayer);
    box.appendChild(el("p", "sun-head", (rising ? "Sunrise " : "Sunset ") + timeOnly(ev.time.toISOString()) + " · " + Math.round(ev.az) + "° " + compass(ev.az)));
    box.appendChild(el("p", "sun-help", "Drag the sun pin. Cloud on the coloured bands blocks the light; gaps there let it through."));
    BANDS.forEach(function (bd) {
      var a = horizonKm(bd[0]), b = horizonKm(bd[1]);
      L.polyline([dest(p.lat, p.lng, ev.az, a), dest(p.lat, p.lng, ev.az, b)],
        { pane: "sun", color: bd[2], weight: 7, opacity: 0.9, lineCap: "butt", interactive: false, band: true }).addTo(sunLayer);
      var range = Math.round(a) + "–" + Math.round(b) + " km";
      L.marker(dest(p.lat, p.lng, ev.az, (a + b) / 2), { pane: "sun", interactive: false, keyboard: false, band: true,
        icon: L.divIcon({ className: "hz", html: el("span", null, bd[3] + " " + range), iconSize: null, iconAnchor: [-8, 6] }) }).addTo(sunLayer);
      var row = el("p", "sun-key"), sw = el("i");
      sw.style.background = bd[2];
      row.appendChild(sw);
      row.appendChild(document.createTextNode(bd[3] + " on your horizon, " + range));
      box.appendChild(row);
    });
    $("map").dataset.sun = Math.round(ev.az) + "@" + ev.time.toISOString();
    lightFor(p, ev, rising);
  }

  // ---- Light check: minute by minute, will the sun's light reach the pin? ----------------------
  // Downloads the forecast along the sun's ray for this one spot straight from Open-Meteo (the same free
  // service SkyFire uses), then follows the ray through the low, mid and high cloud for every minute.
  var EYE_M = 10;
  var LAYER_COLOUR = { low: "#ff9b5c", mid: "#c58bff", high: "#7fc8ff" };
  var light = { key: null, state: "off", forecast: null, terrain: null, eye: EYE_M, tl: {}, model: "auto", idx: 0, win: null,
                ev: null, rising: false, p: null, timer: null, section: false };

  function lightOff() {
    light.state = "off";
    light.key = null;
    $("light").hidden = true;
    delete $("map").dataset.light;
  }

  function lightFor(p, ev, rising) {
    var key = p.lat.toFixed(3) + "," + p.lng.toFixed(3) + "," + (rising ? "r" : "s") + "," + new Date(ev.time).toISOString().slice(0, 13);
    light.p = p; light.ev = { ms: ev.time.getTime(), az: ev.az }; light.rising = rising;
    light.win = SkyLight.windowFor(light.ev, rising, p.lat, p.lng);
    $("light").hidden = false;
    $("sunbox").hidden = true;   // the panel under the map says it all; keep the map clear
    if (key !== light.key) {
      light.key = key;
      light.state = "loading";
      light.forecast = null;
      light.tl = {};
      // start 10 min before sunset / after sunrise
      light.idx = Math.round((light.ev.ms + (rising ? 10 : -10) * 60000 - Math.ceil(light.win[0] / 60000) * 60000) / 60000);
      clearTimeout(light.timer);
      light.timer = setTimeout(function () { loadLight(key); }, dragging ? 99999999 : 250);
    }
    renderLight();
  }

  function loadLight(key) {
    var w = light.win, p = light.p;
    var a0 = SkyLight.sunPos(w[0], p.lat, p.lng).az, a1 = SkyLight.sunPos(w[1], p.lat, p.lng).az;
    var nodes = SkyLight.nodesFor(p.lat, p.lng, Math.min(a0, a1) - 2, Math.max(a0, a1) + 2);
    // Forecast first, then terrain (one after the other keeps under the free per-minute limit). Terrain is
    // a bonus: without it the check still runs over a sea-level horizon.
    var forecast;
    SkyLight.fetchForecast(nodes, new Date(w[0]).toISOString()).then(function (f) {
      forecast = f;
      if (light.key !== key) return null;
      return SkyLight.fetchProfiles(p.lat, p.lng, Math.min(a0, a1) - 2, Math.max(a0, a1) + 2).catch(function () { return null; });
    }).then(function (t) {
      var f = forecast;
      if (light.key !== key) return;
      light.forecast = f;
      light.terrain = t;
      light.eye = t ? t.ground + 2 : EYE_M;
      light.state = "ready";
      ["auto"].concat(f.models()).forEach(function (m) {
        light.tl[m] = SkyLight.timeline(f, p.lat, p.lng, w[0], w[1], m, light.eye, t);
      });
      if (!light.tl[light.model]) light.model = "auto";
      renderLight();
    }, function (err) {
      if (light.key !== key) return;
      light.state = "error";
      light.error = err && err.message ? String(err.message).slice(0, 160) : "";
      renderLight();
    });
  }

  function layerName(id) { return { low: "low clouds", mid: "mid clouds", high: "high clouds" }[id]; }
  function verdictText(m) {
    if (m.state === "down") return light.rising ? "The sun isn't up yet" : "The sun has set";
    if (m.state === "dark") return "Dark";
    if (m.state === "twilight") return "Clear twilight: no cloud in sunlight";
    if (m.state === "afterglow") {
      var where = m.at < 25 ? "overhead" : Math.round(m.at) + "–" + Math.round(m.to) + " km toward the sun";
      return (light.rising ? "Dawn glow: " : "Afterglow: ") + layerName(m.by) + " " + where + " still in sunlight";
    }
    if (m.state === "unknown") return "No forecast for this minute";
    if (m.state === "clear") return "Nothing blocking";
    if (m.state === "hills") return "Behind hills " + Math.round(m.at) + " km away";
    if (m.state === "partial") return "Light through broken " + layerName(m.by) + " (" + Math.round(m.cover) + "%) " + Math.round(m.at) + " km away";
    return "Blocked by " + layerName(m.by) + " " + Math.round(m.at) + " km away";
  }

  function renderLight() {
    var mapEl = $("map"), verdict = $("light-verdict"), bar = $("light-bar"), slider = $("light-slider");
    mapEl.dataset.light = light.state;
    verdict.className = "light-verdict";
    verdict.textContent = "";
    if (light.state === "loading") { verdict.textContent = "Checking the forecast along the sun's ray…"; bar.textContent = ""; slider.disabled = true; return; }
    if (light.state === "error") {
      verdict.textContent = "Couldn't download the forecast for this spot. Check your connection and move the pin to try again." +
        (light.error ? " (Open-Meteo said: " + light.error + ")" : "");
      bar.textContent = ""; slider.disabled = true; return;
    }
    if (light.state !== "ready") return;
    var tl = light.tl[light.model];
    slider.disabled = false;
    slider.max = String(tl.length - 1);
    light.idx = Math.max(0, Math.min(tl.length - 1, light.idx));
    slider.value = String(light.idx);
    // timeline: one cell per minute, a tick at sunset/sunrise
    bar.textContent = "";
    tl.forEach(function (m) { bar.appendChild(el("i", m.state)); });
    var mark = el("span", "sunmark");
    mark.style.left = (100 * (light.ev.ms - tl[0].ms) / (tl[tl.length - 1].ms - tl[0].ms)) + "%";
    bar.appendChild(mark);
    var m = tl[light.idx];
    var t = el("span", "t", timeOnly(new Date(m.ms).toISOString()));
    verdict.appendChild(t);
    verdict.appendChild(document.createTextNode(verdictText(m)));
    verdict.className = "light-verdict is-" + m.state;
    mapEl.dataset.verdict = m.state + (m.by ? ":" + m.by : "");
    // details: sunset, last light, minutes of light; where each layer meets the ray now; models
    var sum = SkyLight.summary(tl, light.rising), word = light.rising ? "Sunrise" : "Sunset";
    var hm = function (ms) { return timeOnly(new Date(ms).toISOString()); };
    var info = word + " " + hm(light.ev.ms) + " · ";
    info += sum.edge ? (light.rising ? "first light " : "last light ") + hm(sum.edge) + " · " + sum.minutesLit + " min of light" : "no direct light";
    if (sum.minutesGlow) info += " · " + (light.rising ? "glow from " : "afterglow until ") + hm(sum.glowEdge);
    if (sum.dark) info += " · " + (light.rising ? "dark until " : "dark at ") + hm(sum.dark);
    $("light-info").textContent = info;
    var rings = $("light-rings");
    rings.textContent = "";
    if (m.stretches.length) {
      m.stretches.forEach(function (st) {
        var sw = el("i"); sw.style.background = LAYER_COLOUR[st.layer];
        rings.appendChild(sw);
        rings.appendChild(document.createTextNode(capital(st.layer) + " " + Math.round(st.from) + "–" + (st.to >= SkyLight.MAX_KM ? Math.round(st.to) + "+" : Math.round(st.to)) + " km"));
      });
    } else rings.textContent = "The sun is down: the Section view shows the Earth's shadow climbing through the clouds.";
    var models = $("light-models");
    models.textContent = "";
    Object.keys(light.tl).forEach(function (id) {
      var b = el("button", "model");
      b.type = "button";
      b.setAttribute("aria-pressed", String(id === light.model));
      b.appendChild(el("b", null, SkyLight.MODEL_NAMES[id] + " "));
      b.appendChild(document.createTextNode(SkyLight.summary(light.tl[id], light.rising).minutesLit + " min"));
      b.addEventListener("click", function () { light.model = id; renderLight(); });
      models.appendChild(b);
    });
    drawRay(m);
    if (light.section) drawSection(m);
  }

  // ---- Section: the ray from the side, over the terrain and through the cloud layers ----------
  var SECTION_TOP_M = 12000;
  function drawSection(m) {
    var cv = $("section"), wrap = $("section-wrap");
    if (wrap.hidden) return;
    var dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var p = light.p, f = light.forecast, t = light.terrain, eye = light.eye, alt = Math.max(m.alt, -1);
    var exit = m.alt < 0 ? null : SkyLight.distanceAt(SECTION_TOP_M - 500, alt, eye);
    var dMax = Math.min(SkyLight.MAX_KM, exit === null ? SkyLight.MAX_KM : Math.max(60, exit + 20));
    var padL = 34, padB = 18, padT = 6, padR = 8;
    var dMin = -Math.min(SkyLight.BEHIND_KM, Math.round(dMax * 0.25));   // a stretch behind you too
    var X = function (d) { return padL + (W - padL - padR) * (d - dMin) / (dMax - dMin); };
    var Y = function (h) { return padT + (H - padT - padB) * (1 - h / SECTION_TOP_M); };
    // sky
    var g = ctx.createLinearGradient(0, padT, 0, H - padB);
    g.addColorStop(0, "#0e1a2c"); g.addColorStop(1, "#1d2a3f");
    ctx.fillStyle = g; ctx.fillRect(padL, padT, W - padL - padR, H - padT - padB);
    // cloud layers: each column shaded by the forecast cover where the ray's line crosses it
    var COL = 3, x0 = Math.round(padL), x1 = Math.round(W - padR);   // whole-pixel columns: no seams
    SkyLight.LAYERS.forEach(function (Lr) {
      var top = Math.round(Y(Math.min(Lr.top, SECTION_TOP_M))), bottom = Math.round(Y(Lr.bottom));
      for (var x = x0; x < x1; x += COL) {
        var d = dMin + (dMax - dMin) * (x + COL / 2 - padL) / (W - padL - padR);
        var q = SkyLight.dest(p.lat, p.lng, d < 0 ? m.az + 180 : m.az, Math.abs(d)), c = f.cover(q[0], q[1], Lr.id, m.ms, light.model);
        if (c <= 0) continue;
        ctx.fillStyle = "rgba(236,239,244," + (0.12 + 0.68 * c / 100) * (c / 100) + ")";
        ctx.fillRect(x, top, Math.min(COL, x1 - x), bottom - top);
      }
      ctx.strokeStyle = LAYER_COLOUR[Lr.id]; ctx.globalAlpha = 0.5; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, Y(Lr.bottom)); ctx.lineTo(W - padR, Y(Lr.bottom)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = LAYER_COLOUR[Lr.id]; ctx.font = "600 10px system-ui, sans-serif"; ctx.textBaseline = "middle";
      ctx.fillText(capital(Lr.id), 2, Y((Lr.bottom + Math.min(Lr.top, SECTION_TOP_M)) / 2));
    });
    // ground: terrain if we have it, else the sea
    ctx.beginPath(); ctx.moveTo(X(dMin), Y(0));
    for (var d = dMin; d <= dMax; d += Math.max(1, (dMax - dMin) / 240)) ctx.lineTo(X(d), Y(t ? t.at(m.az, d) : 0));
    ctx.lineTo(X(dMax), Y(0)); ctx.closePath();
    ctx.fillStyle = "#4a3b2a"; ctx.fill();
    ctx.strokeStyle = "#8a6f52"; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = "#2f6fa8"; ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(W - padR, Y(0)); ctx.stroke();
    // the Earth's shadow, once the sun is down: everything below the line is in shadow
    if (m.alt < 0) {
      ctx.beginPath(); ctx.moveTo(X(dMin), Y(SECTION_TOP_M));
      for (var ds = dMin; ds <= dMax; ds += Math.max(1, dMax / 200)) ctx.lineTo(X(ds), Y(Math.min(SECTION_TOP_M, SkyLight.shadowHeight(ds, -m.alt))));
      ctx.lineTo(X(dMax), Y(0)); ctx.lineTo(X(dMin), Y(0)); ctx.closePath();
      ctx.fillStyle = "rgba(8,12,22,0.55)"; ctx.fill();
      ctx.strokeStyle = "#e0457b"; ctx.lineWidth = 1.5; ctx.beginPath();
      for (var ds2 = dMin; ds2 <= dMax; ds2 += Math.max(1, dMax / 200)) {
        var hs = Math.min(SECTION_TOP_M, SkyLight.shadowHeight(ds2, -m.alt));
        if (ds2 === dMin) ctx.moveTo(X(ds2), Y(hs)); else ctx.lineTo(X(ds2), Y(hs));
      }
      ctx.stroke();
    }
    // the ray
    if (m.alt >= 0 && m.state !== "afterglow" && m.state !== "twilight" && m.state !== "dark") {
      var stop = m.state === "blocked" || m.state === "hills" ? m.at : dMax;
      ctx.lineWidth = 2.5; ctx.strokeStyle = "#ffd27a"; ctx.beginPath();
      for (var d2 = 0; d2 <= stop; d2 += 1) { var h = SkyLight.rayHeight(d2, alt, eye); if (d2 === 0) ctx.moveTo(X(d2), Y(h)); else ctx.lineTo(X(d2), Y(h)); }
      ctx.stroke();
      if (stop < dMax) {
        ctx.setLineDash([4, 5]); ctx.strokeStyle = "rgba(255,210,122,0.45)"; ctx.lineWidth = 1.5; ctx.beginPath();
        for (var d3 = stop; d3 <= dMax; d3 += 1) { var h3 = SkyLight.rayHeight(d3, alt, eye); if (d3 === stop) ctx.moveTo(X(d3), Y(h3)); else ctx.lineTo(X(d3), Y(h3)); }
        ctx.stroke(); ctx.setLineDash([]);
        var bx = X(stop), by = Y(SkyLight.rayHeight(stop, alt, eye));
        ctx.strokeStyle = "#ff5a4f"; ctx.lineWidth = 2.5; ctx.beginPath();
        ctx.moveTo(bx - 5, by - 5); ctx.lineTo(bx + 5, by + 5); ctx.moveTo(bx + 5, by - 5); ctx.lineTo(bx - 5, by + 5); ctx.stroke();
      }
    }
    // you
    ctx.fillStyle = "#ff7a3d"; ctx.beginPath(); ctx.arc(X(0), Y(eye), 4, 0, 2 * Math.PI); ctx.fill();
    // distance ticks
    ctx.fillStyle = "#9aa6b8"; ctx.font = "10px system-ui, sans-serif"; ctx.textBaseline = "alphabetic"; ctx.textAlign = "center";
    var tick = dMax > 250 ? 100 : 50;
    for (var k = tick; k < dMax; k += tick) ctx.fillText(k + " km", X(k), H - 4);
    ctx.fillText("you", X(0), H - 4);
    ctx.strokeStyle = "rgba(233,237,243,0.25)"; ctx.setLineDash([2, 4]); ctx.beginPath();
    ctx.moveTo(X(0), padT); ctx.lineTo(X(0), H - padB); ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = "left"; ctx.fillText("← behind you", X(dMin) + 4, padT + 12);
    ctx.textAlign = "right"; ctx.fillText("toward the sun →", W - padR - 4, padT + 12);
    ctx.textAlign = "left";
    var dir = Math.round(m.az) + "° " + compass(m.az);
    $("section-caption").textContent = "Looking toward the sun, " + dir + ". " + (m.alt < 0
      ? "The sun is down: below the pink line is the Earth's shadow; cloud above it is still lit. Heights are stretched "
      : "The ray climbs as the Earth curves away; heights are stretched ") +
      Math.round(((dMax - dMin) * 1000 / (W - padL - padR)) / (SECTION_TOP_M / (H - padT - padB))) + "×." +
      (t ? "" : " Terrain unavailable: showing a sea-level horizon.");
    cv.dataset.drawn = String(m.ms);
  }

  // On the map: the ray for this minute, coloured where it crosses each cloud layer, rings where the
  // mid and high layers meet your horizon, and a cross at a blocking bank.
  var rayLayer = null;
  function drawRay(m) {
    if (!rayLayer) rayLayer = L.layerGroup().addTo(map);
    rayLayer.clearLayers();
    if (light.state === "ready") {   // the minute-by-minute ray replaces the fixed sunset-moment bands
      sunLayer.eachLayer(function (l) { if (l.options && l.options.band) sunLayer.removeLayer(l); });
    }
    if (light.state !== "ready" || !showSun || !current || !current.data || current.data.map_type !== "sky") return;
    var p = light.p;
    if (!m.stretches.length) return;   // sun down: no ray (the Section view shows the Earth's shadow)
    L.polyline([[p.lat, p.lng], SkyLight.dest(p.lat, p.lng, m.az, SkyLight.MAX_KM)],
      { pane: "sun", color: "#ffd27a", weight: 2, opacity: 0.9, dashArray: "6 6", interactive: false }).addTo(rayLayer);
    m.stretches.forEach(function (st) {
      var to = Math.min(st.to, SkyLight.MAX_KM);
      L.polyline([SkyLight.dest(p.lat, p.lng, m.az, st.from), SkyLight.dest(p.lat, p.lng, m.az, to)], {
        pane: "sun", color: LAYER_COLOUR[st.layer], weight: st.state === "blocked" ? 8 : 6,
        opacity: st.state === "blocked" ? 1 : st.state === "partial" ? 0.75 : 0.45, lineCap: "butt", interactive: false,
      }).addTo(rayLayer);
      if (st.from > 1) {
        L.circle([p.lat, p.lng], { pane: "sun", radius: st.from * 1000, color: LAYER_COLOUR[st.layer], weight: 1.6,
          opacity: 0.85, dashArray: "5 6", fill: false, interactive: false }).addTo(rayLayer);
      }
    });
    if (m.state === "blocked" || m.state === "partial") {
      var at = SkyLight.dest(p.lat, p.lng, m.az, m.at);
      L.marker(at, { pane: "sun", interactive: false, keyboard: false, icon: L.divIcon({ className: "ray-label",
        html: el("span", null, (m.state === "blocked" ? "✕ " : "◐ ") + capital(layerName(m.by)) + " · " + Math.round(m.at) + " km"),
        iconSize: null, iconAnchor: [6, 8] }) }).addTo(rayLayer);
    }
  }

  function setupLight() {
    var slider = $("light-slider");
    $("light-section-btn").addEventListener("click", function () {
      light.section = !light.section;
      this.setAttribute("aria-pressed", String(light.section));
      $("section-wrap").hidden = !light.section;
      renderLight();
    });
    slider.addEventListener("input", function () { light.idx = +slider.value; renderLight(); });
    $("light-more").addEventListener("click", function () {
      var open = this.getAttribute("aria-expanded") !== "true";
      this.setAttribute("aria-expanded", String(open));
      this.textContent = open ? "Less" : "Details";
      $("light-details").hidden = !open;
    });
  }
})();
