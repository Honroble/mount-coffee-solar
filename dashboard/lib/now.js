// Near-real-time values from live_poller.py (logger homepage gauges, every 10 s).
//   <liveDir>/widget_now.json   latest read
//   <liveDir>/now_YYYYMMDD.csv  one row per read
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv, SOURCE_URL } from "@/lib/live";

function localNow(minutes = 90) {
  const now = new Date();
  let latest = null;
  try { latest = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "widget_now.json"), "utf8")); } catch { /* none yet */ }
  const since = now.getTime() - minutes * 60000;
  const points = [];
  for (const d of [new Date(now.getTime() - 86400000), now]) {
    const f = path.join(LIVE_DIR, `now_${d.toISOString().slice(0, 10).replace(/-/g, "")}.csv`);
    let text = null;
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    const rows = parseCsv(text);
    const head = rows[0] || [];
    const iT = head.indexOf("time_utc"), iP = head.indexOf("pv_sum_mw");
    for (const r of rows.slice(1)) {
      const t = Date.parse(r[iT]);
      const mw = r[iP] === "" ? null : Number(r[iP]);
      if (t >= since && mw !== null && !Number.isNaN(mw)) points.push({ t: r[iT], mw });
    }
  }
  const ageS = latest?.time_utc ? Math.round((now - Date.parse(latest.time_utc)) / 1000) : null;
  return { now: now.toISOString(), latest, ageS, points, source: "this PC" };
}

export async function getNow() {
  if (!SOURCE_URL) return localNow();
  try {
    const r = await fetch(`${SOURCE_URL}/api/now`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { ...(await r.json()), source: SOURCE_URL };
  } catch (e) {
    return { ...localNow(), source: SOURCE_URL, sourceError: String(e.message || e) };
  }
}
