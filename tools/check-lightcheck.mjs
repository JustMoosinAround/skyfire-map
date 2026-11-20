// Sends the light check's real requests (as the phone would) and prints what Open-Meteo answers.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../site/lightcheck.js");
const [lat, lon] = [61.2181, -149.9003];
const now = new Date().toISOString();
const ev = L.sunEvent(lat, lon, new Date(Date.now() + 6 * 3600e3).toISOString(), false) || L.sunEvent(lat, lon, now, false);
console.log("sunset", ev && new Date(ev.ms).toISOString(), "az", ev && ev.az.toFixed(1));
const w = L.windowFor(ev, false);
const a0 = L.sunPos(w[0], lat, lon).az, a1 = L.sunPos(w[1], lat, lon).az;
const nodes = L.nodesFor(lat, lon, Math.min(a0, a1) - 2, Math.max(a0, a1) + 2);
console.log("forecast points", nodes.length);
const logged = (url) => fetch(url, { headers: { Origin: "https://justmoosinaround.github.io" } }).then(async (r) => {
  const body = await r.clone().text();
  console.log(r.status, "CORS:", r.headers.get("access-control-allow-origin"), "len", url.length, "|", body.slice(0, 200).replace(/\s+/g, " "));
  return r;
});
try {
  const f = await L.fetchForecast(nodes, new Date(w[0]).toISOString(), logged);
  console.log("forecast OK: nodes with data", Object.keys(f.nodes).length, "models", f.models().join(","));
  const t = await L.fetchProfiles(lat, lon, Math.min(a0, a1) - 2, Math.max(a0, a1) + 2, logged);
  console.log("terrain OK: ground", t.ground, "max", Math.max(...t.elev.flat()));
  const tl = L.timeline(f, lat, lon, w[0], w[1], "auto", t.ground + 2, t);
  console.log("summary", JSON.stringify(L.summary(tl, false)), "states", [...new Set(tl.map((m) => m.state))].join(","));
} catch (e) {
  console.log("FAILED:", e.message);
  process.exitCode = 1;
}
