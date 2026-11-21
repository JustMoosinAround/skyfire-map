/* SkyFire Panorama: a PeakFinder-style skyline from the pin, with the sun's path and the forecast cloud.
 *
 * Terrain: SkyFire's 1 km grid (assets/terrain.bin, int16 metres, rows south to north). For each azimuth the
 * ray is marched outward; every point that rises above everything nearer is visible, and the crests among
 * them are drawn as ridge lines, lighter with distance. Peaks come from OpenStreetMap (assets/peaks.json).
 * Exposed as window.SkyPano (and module.exports for tests). Units are handled by the caller's formatters.
 */
(function (root) {
  "use strict";

  var R_M = 6371000, K = 0.13, RAD = Math.PI / 180;
  var MAX_KM = 260, AZ_STEP = 0.5;

  // ---- terrain grid ------------------------------------------------------------------------------
  function Grid(meta, data) {
    this.lat0 = meta.lat0; this.lat1 = meta.lat1; this.lon0 = meta.lon0; this.lon1 = meta.lon1;
    this.rows = meta.rows; this.cols = meta.cols; this.data = data;
    this.dlat = (this.lat1 - this.lat0) / (this.rows - 1); this.dlon = (this.lon1 - this.lon0) / (this.cols - 1);
  }
  // Bilinear elevation (m), or null outside the grid.
  Grid.prototype.at = function (lat, lon) {
    var r = (lat - this.lat0) / this.dlat, c = (lon - this.lon0) / this.dlon;
    if (r < 0 || c < 0 || r > this.rows - 1 || c > this.cols - 1) return null;
    var r0 = Math.min(this.rows - 2, Math.floor(r)), c0 = Math.min(this.cols - 2, Math.floor(c)), fr = r - r0, fc = c - c0;
    var d = this.data, i = r0 * this.cols + c0;
    return (d[i] * (1 - fc) + d[i + 1] * fc) * (1 - fr) + (d[i + this.cols] * (1 - fc) + d[i + this.cols + 1] * fc) * fr;
  };
  function loadGrid(fetchFn) {
    fetchFn = fetchFn || root.fetch.bind(root);
    return Promise.all([
      fetchFn("assets/terrain.json").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
      fetchFn("assets/terrain.bin").then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); }),
    ]).then(function (g) { return new Grid(g[0], new Int16Array(g[1])); });
  }

  // ---- geometry ----------------------------------------------------------------------------------
  function dest(lat, lon, az, km) {
    var d = km * 1000 / R_M, la = lat * RAD, lo = lon * RAD, b = az * RAD;
    var la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    var lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
    return [la2 / RAD, lo2 / RAD];
  }
  function bearingKm(lat1, lon1, lat2, lon2) {
    var p1 = lat1 * RAD, p2 = lat2 * RAD, dl = (lon2 - lon1) * RAD;
    var y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    var a = Math.pow(Math.sin((p2 - p1) / 2), 2) + Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin(dl / 2), 2);
    return { az: (Math.atan2(y, x) / RAD + 360) % 360, km: 2 * R_M / 1000 * Math.asin(Math.sqrt(a)) };
  }
  // Elevation angle (degrees) of a point h metres high, km away, seen from eye metres (curvature + refraction).
  function angle(h, km, eye) {
    var d = km * 1000;
    return Math.atan2(h - eye - d * d * (1 - K) / (2 * R_M), d) / RAD;
  }
  function distances() {
    var out = [];
    for (var d = 0.3; d <= MAX_KM; d += Math.max(0.25, d * 0.015)) out.push(d);
    return out;
  }
  var DISTS = distances();

  // For every azimuth: the skyline angle, and the visible crests [{km, ang}] (nearest first).
  function skyline(grid, lat, lon, eyeM) {
    var n = Math.round(360 / AZ_STEP), rays = new Array(n);
    for (var i = 0; i < n; i++) {
      var az = i * AZ_STEP, best = -90, crests = [], prev = null;
      for (var k = 0; k < DISTS.length; k++) {
        var d = DISTS[k], p = dest(lat, lon, az, d), h = grid.at(p[0], p[1]);
        if (h === null) break;
        var a = angle(h, d, eyeM);
        if (a > best) {
          best = a;
          prev = { km: d, ang: a, h: h, lat: p[0], lon: p[1] };
        } else if (prev) {
          crests.push(prev);   // the last visible point before the terrain dropped away: a crest
          prev = null;
        }
      }
      if (prev) crests.push(prev);
      rays[i] = { az: az, max: best, crests: crests };
    }
    return { lat: lat, lon: lon, eye: eyeM, rays: rays };
  }
  function rayAt(sky, az) {
    var n = sky.rays.length, i = Math.round((((az % 360) + 360) % 360) / AZ_STEP) % n;
    return sky.rays[i];
  }
  // Skyline angle at az counting only terrain nearer than km (for peaks: is anything in front of it?).
  function blockedBefore(grid, sky, az, km) {
    var best = -90;
    for (var k = 0; k < DISTS.length && DISTS[k] < km * 0.97; k++) {
      var p = dest(sky.lat, sky.lon, az, DISTS[k]), h = grid.at(p[0], p[1]);
      if (h === null) break;
      best = Math.max(best, angle(h, DISTS[k], sky.eye));
    }
    return best;
  }
  // Named peaks you can see from here: [{name, ele, km, az, ang}], most prominent first.
  function visiblePeaks(grid, sky, peaks, maxKm) {
    var out = [];
    (peaks || []).forEach(function (pk) {
      var b = bearingKm(sky.lat, sky.lon, pk[1], pk[2]);
      if (b.km < 1 || b.km > (maxKm || MAX_KM)) return;
      var ele = pk[3] != null ? pk[3] : grid.at(pk[1], pk[2]);
      if (ele == null) return;
      var a = angle(ele, b.km, sky.eye);
      if (a < blockedBefore(grid, sky, b.az, b.km) - 0.03) return;   // hidden behind nearer terrain
      out.push({ name: pk[0], ele: ele, km: b.km, az: b.az, ang: a });
    });
    return out.sort(function (x, y) { return y.ang - x.ang; });
  }

  // ---- drawing -----------------------------------------------------------------------------------
  // opts: { sky, peaks, centerAz, fov, exag, sunPath: [{az, alt}], sun: {az, alt}, clouds(az, km, layer) -> %,
  //         layers: [{id, bottom, top}], shadow(km, depDeg) -> m, fmtHeight(m), fmtDist(km), litColour }
  function draw(canvas, o) {
    var dpr = root.devicePixelRatio || 1, W = canvas.clientWidth, H = canvas.clientHeight;
    if (!W || !H) return null;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var pxDeg = W / o.fov, base = H * 0.8, ex = o.exag;
    // stretch heights up to o.exag, but never so much that the skyline in view rises past ~2/3 of the height
    var topAng = 0.3;
    for (var sx0 = 0; sx0 <= W; sx0 += 4) topAng = Math.max(topAng, rayAt(o.sky, o.centerAz + (sx0 - W / 2) / pxDeg).max);
    ex = Math.max(1, Math.min(o.exag, (base * 0.8) / (topAng * pxDeg)));
    var X = function (az) { var d = ((az - o.centerAz + 540) % 360) - 180; return W / 2 + d * pxDeg; };
    var Y = function (ang) { return base - ang * pxDeg * ex; };
    var inView = function (az) { var d = Math.abs(((az - o.centerAz + 540) % 360) - 180); return d <= o.fov / 2 + 1; };
    // sky
    var g = ctx.createLinearGradient(0, 0, 0, base);
    var low = o.sun && o.sun.alt < 3 && o.sun.alt > -10;
    g.addColorStop(0, "#0b1424"); g.addColorStop(0.55, low ? "#2c2a4a" : "#1d3354"); g.addColorStop(1, low ? "#6a4a68" : "#3e5f86");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // forecast cloud: each layer where it meets your horizon, shaded by cover (lit pink after sunset if in sunlight)
    if (o.clouds && o.layers) {
      var colPx = Math.max(3, Math.round(pxDeg));   // whole-pixel columns: no seams
      for (var cx = 0; cx < W; cx += colPx) {
        var az = o.centerAz + (cx + colPx / 2 - W / 2) / pxDeg;
        o.layers.forEach(function (Lr) {
          for (var km = 15; km <= 420; km += 15) {
            var c = o.clouds(az, km, Lr.id);
            if (!(c > 5)) continue;
            var y1 = Math.round(Y(angle(Lr.top, km, o.sky.eye))), y0 = Math.round(Y(angle(Lr.bottom, km, o.sky.eye)));
            if (y0 < 0 || y1 > H) continue;
            var lit = o.sun && o.sun.alt < 0 && o.shadow && Lr.top > o.shadow(km, -o.sun.alt);
            ctx.fillStyle = (lit ? "rgba(255,143,176," : "rgba(230,234,242,") + (0.06 * c / 100) + ")";
            ctx.fillRect(cx, Math.max(0, y1), Math.min(colPx, W - cx), Math.max(1, y0 - Math.max(0, y1)));
          }
        });
      }
    }
    // sun path for the day, and the sun now
    if (o.sunPath && o.sunPath.length) {
      ctx.strokeStyle = "rgba(255,210,122,0.55)"; ctx.setLineDash([3, 4]); ctx.lineWidth = 1.2; ctx.beginPath();
      var started = false, lastX = null;
      o.sunPath.forEach(function (s) {
        var x = X(s.az), y = Y(s.alt);
        if (!inView(s.az) || (lastX !== null && Math.abs(x - lastX) > W / 2)) { started = false; lastX = null; return; }
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        lastX = x;
      });
      ctx.stroke(); ctx.setLineDash([]);
    }
    // terrain: silhouette fill, then crests far to near (lighter = further)
    ctx.beginPath(); ctx.moveTo(0, H);
    for (var px = 0; px <= W; px += 1) {
      var a1 = o.centerAz + (px - W / 2) / pxDeg, r1 = rayAt(o.sky, a1);
      ctx.lineTo(px, Math.min(H, Y(Math.max(r1.max, -2))));
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fillStyle = "#070b12"; ctx.fill();
    // ridge lines: join each crest to the matching crest (similar distance) in the column before,
    // brighter and thicker when near, fainter when far, as in PeakFinder
    var step = Math.max(2, Math.round(AZ_STEP * pxDeg)), prev = null;
    var BUCKETS = [[15, "rgba(236,241,248,0.95)", 1.6], [50, "rgba(198,210,228,0.85)", 1.3], [120, "rgba(150,166,192,0.75)", 1.1], [1e9, "rgba(112,128,156,0.65)", 1]];
    var segs = BUCKETS.map(function () { return []; }), glow = [];   // glow: sunlit crests (alpenglow)
    for (var px2 = 0; px2 <= W + step; px2 += step) {
      var r2 = rayAt(o.sky, o.centerAz + (px2 - W / 2) / pxDeg), cur = [];
      r2.crests.forEach(function (cr) {
        var pt = { x: px2, y: Y(cr.ang), km: cr.km };
        cur.push(pt);
        if (!prev) return;
        var best = null, bd = Infinity;
        prev.forEach(function (q) { var dd = Math.abs(q.km - cr.km); if (dd < bd) { bd = dd; best = q; } });
        if (best && bd <= Math.max(1.5, cr.km * 0.12)) {
          var tint = o.lit ? o.lit(cr, r2.az) : null;
          if (tint) glow.push([best, pt, tint, cr.km]);
          else for (var b = 0; b < BUCKETS.length; b++) if (cr.km <= BUCKETS[b][0]) { segs[b].push([best, pt]); break; }
        }
      });
      prev = cur;
    }
    for (var bi = BUCKETS.length - 1; bi >= 0; bi--) {   // far first, near on top
      ctx.strokeStyle = BUCKETS[bi][1]; ctx.lineWidth = BUCKETS[bi][2]; ctx.beginPath();
      segs[bi].forEach(function (sg) { ctx.moveTo(sg[0].x, sg[0].y); ctx.lineTo(sg[1].x, sg[1].y); });
      ctx.stroke();
    }
    // alpenglow: sunlit ridges in warm colour, with a soft wash on the slope below each crest
    glow.sort(function (a, b) { return b[3] - a[3]; }).forEach(function (sg) {
      var c = sg[2], x0 = sg[0].x, x1 = sg[1].x, y = Math.min(sg[0].y, sg[1].y);
      var wash = ctx.createLinearGradient(0, y, 0, y + 14);
      wash.addColorStop(0, "rgba(" + c.r + "," + c.g + "," + c.b + "," + (0.45 * c.a) + ")");
      wash.addColorStop(1, "rgba(" + c.r + "," + c.g + "," + c.b + ",0)");
      ctx.fillStyle = wash; ctx.fillRect(Math.min(x0, x1), y, Math.abs(x1 - x0) + 1, 14);
      ctx.strokeStyle = "rgba(" + c.r + "," + c.g + "," + c.b + "," + c.a + ")"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, sg[0].y); ctx.lineTo(x1, sg[1].y); ctx.stroke();
    });
    // the sun now (dimmed when it is behind terrain or below the horizon)
    if (o.sun && inView(o.sun.az)) {
      var sx = X(o.sun.az), sy = Y(o.sun.alt), hidden = o.sun.alt < rayAt(o.sky, o.sun.az).max;
      ctx.globalAlpha = hidden ? 0.35 : 1;
      ctx.fillStyle = "#ffd27a"; ctx.beginPath(); ctx.arc(sx, sy, 6, 0, 2 * Math.PI); ctx.fill();
      ctx.globalAlpha = 1;
    }
    // peak labels, highest-looking first, skipping ones that would overlap
    var placed = [];
    ctx.font = "600 10px system-ui, sans-serif"; ctx.textBaseline = "middle";
    (o.peaks || []).forEach(function (pk) {
      if (!inView(pk.az)) return;
      var x = X(pk.az), y = Y(pk.ang);
      var len = ctx.measureText(pk.name + " 00,000 ft").width;
      if (y - 16 - len * 0.87 < 2 || placed.some(function (q) { return Math.abs(q - x) < 13; })) return;   // room for the label
      placed.push(x);
      ctx.strokeStyle = "rgba(233,237,243,0.6)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x, y - 14); ctx.stroke();
      ctx.save(); ctx.translate(x + 3, y - 16); ctx.rotate(-Math.PI / 3);
      ctx.fillStyle = "#e9edf3"; ctx.fillText(pk.name, 0, 0);
      ctx.fillStyle = "#9aa6b8"; ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(" " + o.fmtHeight(pk.ele), ctx.measureText(pk.name).width + 2, 0);
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.restore();
    });
    // compass along the bottom
    ctx.fillStyle = "#9aa6b8"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    var names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    for (var d = 0; d < 360; d += 15) {
      if (!inView(d)) continue;
      var xx = X(d);
      ctx.fillRect(xx, H - 14, 1, d % 45 ? 3 : 6);
      if (d % 45 === 0) ctx.fillText(names[d / 45], xx, H - 2);
    }
    ctx.textAlign = "left";
    return { placed: placed.length, glow: glow.length, exag: ex };
  }

  var api = { Grid: Grid, loadGrid: loadGrid, skyline: skyline, rayAt: rayAt, visiblePeaks: visiblePeaks, angle: angle,
    bearingKm: bearingKm, draw: draw, MAX_KM: MAX_KM };
  root.SkyPano = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
