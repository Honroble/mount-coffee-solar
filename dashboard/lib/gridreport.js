// Grid & reports: daily export figures built from the 22 kV station feeders P01 (MVSTS 1-2) + P04 (MVSTS 3-5).
// P07 (outgoing feeder to J07) reads about 34 % low because two of its voltage inputs read ~12.7 kV instead of
// ~21.8 kV (found 23 Nov 2026), so P01 + P04 stand in for export until P07 is repaired. P07 is still compared
// every day; when it agrees with P01 + P04 within 3 % for a full day the report says the repair looks done.
import fs from "fs";
import path from "path";
import { LIVE_DIR } from "@/lib/live";
import reportDaily from "@/data/history/report_daily.json";
import { plantDay } from "@/lib/plantreport";

const K7 = "P07 (OUTGOING FEEDER )", K1 = "P01 - MVSTS 1..2", K4 = "P04 - MVSTS 3..5";
const AC_MW = 17.79, DC_KWP = 21170;
const DAY_FROM = 6.5 * 60, DAY_TO = 18 * 60;             // daylight window used for data coverage, GMT minutes
const j07 = Object.fromEntries((reportDaily || []).map((r) => [r.date, r.export_mwh]));
const cache = new Map();                                   // date -> { stamp, day }

const num = (v) => { const x = Number(v); return v === "" || v === undefined || !Number.isFinite(x) ? null : x; };
const r = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

function parseDay(file, date, nowMin = null) {
  const lines = fs.readFileSync(file, "latin1").trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const h = lines[0].split(";");
  const ix = (k, s) => h.indexOf(`${k}.${s}`);
  const c = {
    p1: ix(K1, "Active power"), p4: ix(K4, "Active power"), q1: ix(K1, "Reactive power"), q4: ix(K4, "Reactive power"),
    p7: ix(K7, "Active power"), f: ix(K7, "Frequency"), v: ix(K7, "Line-to-line voltage VAB"),
    trips: [K7, K1, K4].map((k) => ix(k, "total number of happened trip")),
    cbOff: [K7, K1, K4].map((k) => ix(k, "C.B OFF")),
  };
  if (c.p1 < 0 || c.p4 < 0) return null;
  const seen = new Set();
  let exp = 0, imp = 0, q = 0, peak = 0, peakAt = null, opMin = 0, dayMin = 0, s7 = 0, s14 = 0;
  let fMin = null, fMax = null, vMin = null, vMax = null, offMin = 0;
  const tripFirst = c.trips.map(() => null), tripLast = c.trips.map(() => null);
  for (const line of lines.slice(2)) {
    const row = line.split(";");
    const hhmm = (row[1] || "").slice(0, 5);
    if (!hhmm || seen.has(hhmm)) continue;
    seen.add(hhmm);
    const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const p1 = num(row[c.p1]), p4 = num(row[c.p4]);
    if (p1 === null || p4 === null) continue;
    if (m >= DAY_FROM && m < DAY_TO) dayMin++;
    const p = p1 + p4;                                     // kW, positive = towards the grid
    if (p > 0) exp += p / 60; else imp += -p / 60;
    q += ((num(row[c.q1]) || 0) + (num(row[c.q4]) || 0)) / 60;
    if (p > peak) { peak = p; peakAt = hhmm; }
    if (p > 100) opMin++;
    const p7 = c.p7 >= 0 ? num(row[c.p7]) : null;
    if (p7 !== null && p > 1000) { s7 += Math.abs(p7); s14 += p; }
    const f = c.f >= 0 ? num(row[c.f]) : null;
    if (f !== null && f > 40) { fMin = fMin === null ? f : Math.min(fMin, f); fMax = fMax === null ? f : Math.max(fMax, f); }
    const v = c.v >= 0 ? num(row[c.v]) : null;
    if (v !== null && v > 1000) { vMin = vMin === null ? v : Math.min(vMin, v); vMax = vMax === null ? v : Math.max(vMax, v); }
    if (c.cbOff.some((i) => i >= 0 && num(row[i]) === 1) && m >= DAY_FROM && m < DAY_TO) offMin++;
    c.trips.forEach((i, k) => { const t = i >= 0 ? num(row[i]) : null; if (t !== null) { if (tripFirst[k] === null) tripFirst[k] = t; tripLast[k] = t; } });
  }
  const exportMwh = exp / 1000;
  const trips = c.trips.reduce((n, _, k) => n + (tripFirst[k] !== null ? Math.max(0, tripLast[k] - tripFirst[k]) : 0), 0);
  return {
    date,
    export_mwh: r(exportMwh, 2),
    import_mwh: r(imp / 1000, 3),
    reactive_mvarh: r(q / 1000, 2),
    peak_mw: r(peak / 1000, 2), peak_at: peakAt,
    operating_h: r(opMin / 60, 1),
    capacity_factor_pct: r((exportMwh / (AC_MW * 24)) * 100, 1),
    specific_yield: r((exportMwh * 1000) / DC_KWP, 2),
    p07_ratio: s14 > 0 ? r(s7 / s14, 3) : null,
    f_min: r(fMin, 2), f_max: r(fMax, 2),
    v_min_kv: r(vMin === null ? null : vMin / 1000, 2), v_max_kv: r(vMax === null ? null : vMax / 1000, 2),
    trips, breaker_open_min: offMin,
    coverage_pct: r((dayMin / Math.max(1, Math.min(DAY_TO, nowMin ?? DAY_TO) - DAY_FROM)) * 100, 0),
    j07_mwh: j07[date] ?? null,
  };
}

export function gridDays() {
  let dates = [];
  try {
    dates = [...new Set(fs.readdirSync(LIVE_DIR).map((f) => (f.match(/^(?:grid|iv1|iv2)_live_(\d{8})\.csv$/) || [])[1]).filter(Boolean))].sort();
  } catch { return []; }
  const now = new Date(), today = now.toISOString().slice(0, 10);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const days = [];
  for (const d of dates) {
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const stamp = ["grid", "iv1", "iv2"].map((k) => { try { return fs.statSync(path.join(LIVE_DIR, `${k}_live_${d}.csv`)).mtimeMs; } catch { return 0; } }).join("|");
    const hit = cache.get(date);
    if (hit && hit.stamp === stamp && date !== today) { if (hit.day) days.push(hit.day); continue; }
    let grid = null, plant = null;
    const gf = path.join(LIVE_DIR, `grid_live_${d}.csv`);
    if (fs.existsSync(gf)) { try { grid = parseDay(gf, date, date === today ? nowMin : null); } catch { grid = null; } }
    try { plant = plantDay(date); } catch { plant = null; }
    const day = grid || plant ? { date, ...(grid || { export_mwh: null, trips: 0, coverage_pct: null, p07_ratio: null }), ...(plant || {}), partial: date === today } : null;
    cache.set(date, { stamp, day });
    if (day) days.push(day);
  }
  return days.reverse();                                   // newest first
}

export function gridReport() {
  const days = gridDays();
  const months = {};
  for (const d of days) {
    const k = d.date.slice(0, 7);
    const m = (months[k] ||= { month: k, days: 0, export_mwh: 0, peak_mw: 0, trips: 0, low_coverage_days: 0 });
    m.days++; m.export_mwh += d.export_mwh || 0; m.inverter_mwh = (m.inverter_mwh || 0) + (d.inverter_mwh || 0); m.irr = (m.irr || 0) + (d.irradiation_kwh_m2 || 0); m.peak_mw = Math.max(m.peak_mw, d.peak_mw || 0); m.trips += d.trips || 0;
    if (!d.partial && d.coverage_pct !== null && d.coverage_pct < 95) m.low_coverage_days++;
  }
  const full = days.filter((d) => !d.partial && d.coverage_pct !== null && d.coverage_pct >= 95 && d.p07_ratio !== null);
  const last = full[0];
  const p07 = !last ? { state: "unknown", text: "Not enough full days yet to compare P07 with P01 + P04." }
    : Math.abs(last.p07_ratio - 1) <= 0.03
      ? { state: "fixed", ratio: last.p07_ratio, date: last.date, text: `P07 agreed with P01 + P04 within 3 % on ${last.date}: the repair looks done. Confirm before switching export back to P07.` }
      : { state: "faulty", ratio: last.p07_ratio, date: last.date, text: `P07 read ${Math.round(last.p07_ratio * 100)} % of P01 + P04 on ${last.date}, so export is taken from P01 + P04.` };
  let control = null;
  try {
    const w = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "widget_now.json"), "utf8"));
    control = { time: w.time_utc, setpoint_mw: w.power_setpoint_mw ?? null, power_limit_pct: w.power_limit_user_pct ?? null };
  } catch { /* not yet */ }
  return {
    control,
    source: "P01 + P04 (station feeders)",
    note: "Export from the station feeders includes the small 22 kV busbar and cable losses up to P07 (probably under 1 %). Night-time import reads zero on these relays, so auxiliary consumption is not measured here. J07's meter remains the reference for official figures.",
    p07, days, months: Object.values(months).map((m) => ({ ...m, export_mwh: r(m.export_mwh, 1), inverter_mwh: r(m.inverter_mwh, 1), irradiation_kwh_m2: r(m.irr, 1), pr_pct: m.irr > 0 ? r((m.inverter_mwh * 1000 / (m.irr * 21170)) * 100, 1) : null })).sort((a, b) => b.month.localeCompare(a.month)),
  };
}

const COLS = ["date", "export_mwh", "inverter_mwh", "j07_mwh", "irradiation_kwh_m2", "pr_pct", "pr_temp_corr_pct", "availability_pct",
  "minutes_at_limit", "curtailed_mwh_est", "fault_lost_mwh_est", "alarm_inverter_minutes", "dc_mwh", "inverter_eff_pct", "plant_eff_pct", "setpoint_min_mw", "setpoint_max_mw", "tmod_weighted_c", "tamb_mean_c", "rh_mean_pct", "pressure_hpa", "wind_mean_ms", "wind_max_ms", "rain_mm", "soiling_pct", "import_mwh", "reactive_mvarh", "peak_mw", "peak_at", "operating_h", "capacity_factor_pct",
  "specific_yield", "p07_ratio", "f_min", "f_max", "v_min_kv", "v_max_kv", "trips", "breaker_open_min", "coverage_pct", "partial"];
export function gridCsv() {
  const rows = gridDays().slice().reverse();
  return [COLS.join(","), ...rows.map((d) => COLS.map((k) => (d[k] === null || d[k] === undefined ? "" : d[k])).join(","))].join("\n") + "\n";
}

export function hourlyCsv() {
  const rows = gridDays().slice().reverse();
  const out = ["date,hour_gmt,export_kwh,export_minutes,inverter_kwh,dc_kwh,dc_minutes,irradiation_wh_m2"];
  for (const d of rows) for (const h of d.hourly || []) {
    if (!h.inverter_kwh && !h.export_kwh && !h.irradiation_wh_m2) continue;
    out.push([d.date, `${String(h.hour).padStart(2, "0")}:00`, h.export_kwh ?? "", h.export_min ?? "", h.inverter_kwh ?? "", h.dc_kwh ?? "", h.dc_min ?? "", h.irradiation_wh_m2 ?? ""].join(","));
  }
  return out.join("\n") + "\n";
}
