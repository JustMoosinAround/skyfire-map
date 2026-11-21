/* SkyFire moon: position, phase, rise/set and the next main phases. Low-precision formulae (about a
 * quarter degree, a minute or two), checked against the Skyfield ephemeris in the tests.
 * Exposed as window.SkyMoon (and module.exports for tests). Angles in degrees, times in ms.
 */
(function (root) {
  "use strict";

  var RAD = Math.PI / 180, DAY = 86400000, J2000 = 946728000000;   // 2000-01-01 12:00 UTC
  var E = 23.4397 * RAD;   // obliquity of the ecliptic
  var EARTH_R_KM = 6378.14;

  function days(ms) { return (ms - J2000) / DAY; }
  function ra(l, b) { return Math.atan2(Math.sin(l) * Math.cos(E) - Math.tan(b) * Math.sin(E), Math.cos(l)); }
  function dec(l, b) { return Math.asin(Math.sin(b) * Math.cos(E) + Math.cos(b) * Math.sin(E) * Math.sin(l)); }
  function sidereal(d, lw) { return RAD * (280.16 + 360.9856235 * d) - lw; }

  function sunCoords(d) {
    var M = RAD * (357.5291 + 0.98560028 * d);
    var C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + C + RAD * 102.9372 + Math.PI;
    return { ra: ra(L, 0), dec: dec(L, 0), dist: 149598000 };
  }
  // Mean elements plus the largest periodic terms (Meeus, ch. 47: equation of centre, evection, variation,
  // annual equation...), good to a few tenths of a degree.
  function moonCoords(d) {
    var Lp = RAD * (218.316 + 13.176396 * d), Mp = RAD * (134.963 + 13.064993 * d), F = RAD * (93.272 + 13.229350 * d);
    var D = RAD * (297.8502 + 12.190749 * d), Ms = RAD * (357.5291 + 0.98560028 * d), S = Math.sin, C = Math.cos;
    var l = Lp + RAD * (6.289 * S(Mp) + 1.274 * S(2 * D - Mp) + 0.658 * S(2 * D) + 0.214 * S(2 * Mp)
      - 0.186 * S(Ms) - 0.114 * S(2 * F) + 0.059 * S(2 * D - 2 * Mp) + 0.057 * S(2 * D - Ms - Mp)
      + 0.053 * S(2 * D + Mp) + 0.046 * S(2 * D - Ms) - 0.041 * S(Ms - Mp) - 0.035 * S(D) - 0.031 * S(Ms + Mp));
    var b = RAD * (5.128 * S(F) + 0.281 * S(Mp + F) + 0.278 * S(Mp - F) + 0.173 * S(2 * D - F)
      + 0.055 * S(2 * D - Mp + F) + 0.046 * S(2 * D - Mp - F) + 0.033 * S(2 * D + F));
    var dist = 385000.56 - 20905.36 * C(Mp) - 3699.11 * C(2 * D - Mp) - 2955.97 * C(2 * D) - 569.93 * C(2 * Mp)
      + 48.89 * C(Ms) - 3.15 * C(2 * F) + 246.16 * C(2 * D - 2 * Mp) - 205.96 * C(2 * D - Ms - Mp)
      - 170.73 * C(2 * D + Mp) - 152.14 * C(2 * D - Ms);
    return { ra: ra(l, b), dec: dec(l, b), dist: dist };
  }

  // Where the moon is from (lat, lon): apparent altitude (parallax and refraction included) and azimuth
  // from north, both in degrees; distance in km.
  function position(ms, lat, lon) {
    var d = days(ms), lw = RAD * -lon, phi = RAD * lat, c = moonCoords(d);
    var H = sidereal(d, lw) - c.ra;
    var h = Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
    h -= Math.asin(EARTH_R_KM / c.dist * Math.cos(h));                       // parallax: topocentric
    var hd = h / RAD;
    if (hd > -2) hd += 1.02 / Math.tan((hd + 10.3 / (hd + 5.11)) * RAD) / 60;   // refraction near the horizon
    var az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(c.dec) * Math.cos(phi)) / RAD + 180;
    return { alt: hd, az: (az + 360) % 360, dist: c.dist };
  }

  // Lit fraction (0-1), phase (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter) and waxing.
  function illumination(ms) {
    var d = days(ms), s = sunCoords(d), m = moonCoords(d);
    var phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
    var inc = Math.atan2(s.dist * Math.sin(phi), m.dist - s.dist * Math.cos(phi));
    var angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra),
      Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
    var phase = 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI;
    return { fraction: (1 + Math.cos(inc)) / 2, phase: phase, waxing: phase < 0.5 };
  }

  function phaseName(p) {
    if (p < 0.03 || p > 0.97) return "New moon";
    if (p < 0.22) return "Waxing crescent";
    if (p < 0.28) return "First quarter";
    if (p < 0.47) return "Waxing gibbous";
    if (p < 0.53) return "Full moon";
    if (p < 0.72) return "Waning gibbous";
    if (p < 0.78) return "Last quarter";
    return "Waning crescent";
  }

  // Moonrise and moonset between from and to (ms): the moon's upper edge on a level horizon.
  // Returns { rise, set } (ms or null) and up/down all the time.
  function riseSet(lat, lon, from, to) {
    var h0 = -0.27, step = 5 * 60000, rise = null, set = null, prev = position(from, lat, lon).alt - h0, anyUp = prev > 0;
    for (var t = from + step; t <= to; t += step) {
      var cur = position(t, lat, lon).alt - h0;
      if (cur > 0) anyUp = true;
      if (prev <= 0 && cur > 0 && rise === null) rise = t - step + step * prev / (prev - cur);
      if (prev > 0 && cur <= 0 && set === null) set = t - step + step * prev / (prev - cur);
      prev = cur;
    }
    return { rise: rise, set: set, alwaysUp: rise === null && set === null && anyUp, alwaysDown: rise === null && set === null && !anyUp };
  }

  // The next new, first-quarter, full and last-quarter moons after `ms`, in order: [{name, ms}].
  function nextPhases(ms, count) {
    var targets = [[0, "New moon"], [0.25, "First quarter"], [0.5, "Full moon"], [0.75, "Last quarter"]];
    var out = [], step = 6 * 3600000, t = ms, prev = illumination(t).phase;
    while (out.length < (count || 4) && t < ms + 40 * DAY) {
      var t2 = t + step, cur = illumination(t2).phase;
      targets.forEach(function (tg) {
        var a = prev, b = cur, x = tg[0];
        if (b < a) { b += 1; if (x < a) x += 1; }          // wrapped past new moon
        if (a < x && x <= b) {
          var lo = t, hi = t2;                              // refine to within a minute
          for (var i = 0; i < 20; i++) {
            var mid = (lo + hi) / 2, pm = illumination(mid).phase;
            if (pm < a - 0.5) pm += 1;
            if (pm < x) lo = mid; else hi = mid;
          }
          out.push({ name: tg[1], ms: (lo + hi) / 2 });
        }
      });
      prev = cur; t = t2;
    }
    return out.sort(function (a, b) { return a.ms - b.ms; }).slice(0, count || 4);
  }

  var api = { position: position, illumination: illumination, phaseName: phaseName, riseSet: riseSet, nextPhases: nextPhases };
  root.SkyMoon = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
