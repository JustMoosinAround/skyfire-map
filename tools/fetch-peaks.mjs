// Named peaks for the Panorama view, from OpenStreetMap (Overpass API). Writes site/assets/peaks.json as
// [[name, lat, lon, elevation_m or null], ...], highest first. Peak names © OpenStreetMap contributors (ODbL).
import { writeFileSync } from "node:fs";
const BOX = "58.5,-156.0,65.2,-143.0";   // South-central Alaska and the ranges seen from it
const q = `[out:json][timeout:180];node["natural"~"^(peak|volcano)$"]["name"](${BOX});out body;`;
const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(q),
  headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "skyfire-map-peaks/1.0" } });
if (!r.ok) throw new Error("Overpass HTTP " + r.status + ": " + (await r.text()).slice(0, 300));
const j = await r.json();
const ele = (t) => { const m = /^\s*(-?\d+(?:\.\d+)?)\s*(m|ft|')?/i.exec(t || ""); if (!m) return null; const v = +m[1]; return /ft|'/i.test(m[2] || "") ? Math.round(v * 0.3048) : Math.round(v); };
const peaks = j.elements.filter((e) => e.tags && e.tags.name)
  .map((e) => [e.tags.name, +e.lat.toFixed(4), +e.lon.toFixed(4), ele(e.tags.ele)])
  .sort((a, b) => (b[3] ?? -1) - (a[3] ?? -1));
writeFileSync(new URL("../site/assets/peaks.json", import.meta.url), JSON.stringify(peaks));
console.log("peaks:", peaks.length, "with elevation:", peaks.filter((p) => p[3] != null).length, "top:", JSON.stringify(peaks.slice(0, 5)));
