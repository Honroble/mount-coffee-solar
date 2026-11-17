// Weather-model forecast (hours to 3 days) written by forecast/live/nwp_forecast.py, plus daily actuals
// from the logger files, and the day-ahead scorecard. Server side only.
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv } from "@/lib/live";
import { daily as historyDaily } from "@/lib/history";

const SENTINELS = new Set([655.35, 6553.5, 65535]);
const cache = new Map(); // file -> {mtime, value}

function cached(file, build) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.value;
  const value = build(file);
  cache.set(file, { mtime: st.mtimeMs, value });
  return value;
}

// One logger day file -> {date, mwh, peakMw, minutes}. Energy = sum of 1-minute MW / 60 (gross, inverter side).
function dayFromFile(file) {
  const text = fs.readFileSync(file, "latin1");
  const rows = parseCsv(text, ";");
  const head = rows[0] || [];
  const k = head.indexOf("Information.Inverter sum P");
  if (k < 0) return null;
  let e = 0, peak = 0, n = 0, date = null;
  const hours = new Map(); // hour -> {h, peak, at, mwh}
  for (const r of rows.slice(1)) {
    if (!r[0] || r[0].startsWith("[")) continue;
    const v = Number(r[k]);
    if (!Number.isFinite(v) || SENTINELS.has(v) || v < -0.1 || v > 20) continue;
    const [dd, mm, yyyy] = r[0].split(".");
    date = `${yyyy}-${mm}-${dd}`;
    e += Math.max(v, 0) / 60; peak = Math.max(peak, v); n++;
    const h = Number((r[1] || "").slice(0, 2));
    if (!hours.has(h)) hours.set(h, { h, peak: -1, at: null, mwh: 0 });
    const o = hours.get(h);
    o.mwh += Math.max(v, 0) / 60;
    if (v > o.peak) { o.peak = v; o.at = (r[1] || "").slice(0, 5); }
  }
  const hourly = [...hours.values()].filter((o) => o.peak > 0.05).sort((a, b) => a.h - b.h)
    .map((o) => ({ h: o.h, peak: +o.peak.toFixed(2), at: o.at, mwh: +o.mwh.toFixed(2) }));
  return date ? { date, mwh: +e.toFixed(1), peakMw: +peak.toFixed(2), minutes: n, hourly, source: "logger (live)" } : null;
}

export function dailyActuals() {
  const out = new Map();
  for (const d of historyDaily) out.set(d.date, { date: d.date, mwh: d.energy_mwh, peakMw: d.peak_mw ?? null, minutes: null, source: "logger (history)", status: d.status });
  let files = [];
  try { files = fs.readdirSync(LIVE_DIR).filter((f) => /^iv2_live_\d{8}\.csv$/.test(f)).sort(); } catch { /* no live folder */ }
  for (const f of files) {
    const d = cached(path.join(LIVE_DIR, f), dayFromFile);
    if (d) out.set(d.date, d);
  }
  return out;
}

function readNwp() {
  return cached(path.join(LIVE_DIR, "nwp_forecast.json"), (f) => JSON.parse(fs.readFileSync(f, "utf8")));
}

function readDailyLog() {
  return cached(path.join(LIVE_DIR, "nwp_daily_log.csv"), (f) => {
    const rows = parseCsv(fs.readFileSync(f, "utf8"));
    const head = rows[0];
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  }) || [];
}

// Day-ahead = last issue made before that day; same-day = first issue made on that day (morning).
export function scorecard(actuals, today) {
  const log = readDailyLog();
  const byDate = new Map();
  for (const r of log) {
    const issuedDay = r.issued_utc.slice(0, 10);
    const s = byDate.get(r.date) || {};
    if (issuedDay < r.date) s.dayAhead = r;            // log is in time order: keeps the last one before the day
    else if (issuedDay === r.date && !s.sameDay) s.sameDay = r;
    byDate.set(r.date, s);
  }
  const rows = [];
  for (const [date, s] of [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    if (date >= today) continue;                        // only finished days
    const a = actuals.get(date);
    if (!a || (a.minutes !== null && a.minutes < 600)) continue;  // skip days with big data gaps
    const num = (x) => (x === undefined || x === "" ? null : Number(x));
    rows.push({
      date, actual: a.mwh,
      dayAheadNew: num(s.dayAhead?.new_mwh), dayAheadLow: num(s.dayAhead?.low_mwh), dayAheadHigh: num(s.dayAhead?.high_mwh),
      dayAheadOld: num(s.dayAhead?.old_mwh), sameDayNew: num(s.sameDay?.new_mwh),
    });
  }
  const mae = (k) => {
    const v = rows.filter((r) => r[k] !== null);
    return v.length ? +(v.reduce((t, r) => t + Math.abs(r[k] - r.actual), 0) / v.length).toFixed(1) : null;
  };
  return { rows: rows.slice(0, 21), maeDayAheadNew: mae("dayAheadNew"), maeDayAheadOld: mae("dayAheadOld"), maeSameDayNew: mae("sameDayNew"), days: rows.length };
}

export function nwpSnapshot(now = new Date()) {
  const fc = readNwp();
  const today = now.toISOString().slice(0, 10);
  const actuals = dailyActuals();
  const recent = [...actuals.values()].filter((a) => a.date >= new Date(now - 7 * 86400000).toISOString().slice(0, 10));
  return {
    forecast: fc ? { ...fc, ageMin: Math.round((now - new Date(fc.issued)) / 60000) } : null,
    actualToday: actuals.get(today) ?? null,
    recentActuals: recent,
    score: scorecard(actuals, today),
  };
}
