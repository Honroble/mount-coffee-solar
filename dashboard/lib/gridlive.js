// 22 kV feeder relays (P07 outgoing to J07, P01 MVSTS 1-2, P04 MVSTS 3-5) and the daily DC string check.
// Read-only files written on the forecast PC: data/live/grid_live_YYYYMMDD.csv (every minute) and
// string_check_latest.json (daily after 14:00 GMT). Values are shown as the logger reports them; P07 power,
// voltages and energy counters are still being verified at site (see the findings report of 22 Nov 2026).
import fs from "fs";
import path from "path";
import { LIVE_DIR, SOURCE_URL } from "@/lib/live";

const FEEDERS = [["P07 (OUTGOING FEEDER )", "P07 · to J07 (grid)"], ["P01 - MVSTS 1..2", "P01 · MVSTS 1–2"], ["P04 - MVSTS 3..5", "P04 · MVSTS 3–5"]];

function latestRows(prefix) {
  const days = [0, 1].map((d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10).replace(/-/g, ""));
  for (const d of days) {
    const f = path.join(LIVE_DIR, `${prefix}_live_${d}.csv`);
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, "latin1").trim().split(/\r?\n/);
    if (lines.length < 3) continue;
    return { header: lines[0].split(";"), units: lines[1].split(";"), rows: lines.slice(2).map((l) => l.split(";")) };
  }
  return null;
}

const num = (v) => { const x = Number(v); return v === "" || v === undefined || !Number.isFinite(x) ? null : x; };

function localGrid() {
  const g = latestRows("grid");
  let strings = null;
  try { strings = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "string_check_latest.json"), "utf8")); } catch { /* not yet */ }
  if (!g) return { feeders: [], strings, missing: true };
  const last = g.rows[g.rows.length - 1];
  const first = g.rows[0];
  const get = (row, name) => { const i = g.header.indexOf(name); return i >= 0 ? num(row[i]) : null; };
  const [dd, mm, yyyy] = last[0].split(".");
  const time = `${yyyy}-${mm}-${dd}T${last[1]}Z`;
  const feeders = FEEDERS.map(([key, label]) => {
    const v = (s) => get(last, `${key}.${s}`);
    const cbOn = v("C.B ON"), cbOff = v("C.B OFF");
    const tripsNow = v("total number of happened trip"), tripsDayStart = get(first, `${key}.total number of happened trip`);
    return {
      key, label,
      breaker: cbOn === 1 && cbOff !== 1 ? "closed" : cbOff === 1 ? "open" : "unknown",
      trips_total: tripsNow, trips_today: tripsNow !== null && tripsDayStart !== null ? tripsNow - tripsDayStart : null,
      phase_fault: v("General Phase Fault"), earth_fault: v("General Earth Fault"),
      p_kw: v("Active power"), q_kvar: v("Reactive power"), pf: v("Power factor"), f_hz: v("Frequency"),
      v_ab: v("Line-to-line voltage VAB"), v_bc: v("Line-to-line voltage VBC"), v_ca: v("Line-to-line voltage VCA"),
      i_a: v("Phase current IA"), i_b: v("Phase current IB"), i_c: v("Phase current IC"),
      remote_local: v("Remote_Local State"),
    };
  }).filter((f) => f.breaker !== "unknown" || f.p_kw !== null);
  return { time, ageS: Math.round((Date.now() - Date.parse(time)) / 1000), feeders, strings };
}

export async function getGrid() {
  if (!SOURCE_URL) return localGrid();
  try {
    const r = await fetch(`${SOURCE_URL}/api/grid`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } catch {
    return localGrid();
  }
}
