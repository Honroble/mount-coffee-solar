// Whole-period summary, hourly peaks and the live forecast track record. Server side only.
// History (17 Sep - 13 Nov 2026 logger exports) + every day the forecast PC has collected since.
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv } from "@/lib/live";
import { dailyActuals } from "@/lib/nwp";
import { frequency } from "@/lib/history";
import hourlyHistory from "@/data/history/hourly.json";
import accV2 from "@/data/history/accuracy_v2.json";

const FULL_DAY_MIN = 660; // a day with fewer logged minutes than this is partial (PC off or collector stopped)

function days() {
  return [...dailyActuals().values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function missingDates(first, last, have) {
  const out = [];
  for (let t = Date.parse(first + "T00:00:00Z"); t <= Date.parse(last + "T00:00:00Z"); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (!have.has(d)) out.push(d);
  }
  return out;
}

export function hourlyByDate() {
  const out = { ...hourlyHistory };
  for (const d of days()) if (d.hourly) out[d.date] = d.hourly;
  return out;
}

// Typical (median) and record hourly peak for each hour of the day, over complete normal days.
export function hourlyProfile(byDate) {
  const today = new Date().toISOString().slice(0, 10);
  const normal = new Set(days().filter((d) => d.date !== today && (d.status ? d.status === "Normal" : (d.minutes ?? 0) >= FULL_DAY_MIN)).map((d) => d.date));
  const per = new Map();
  for (const [date, rows] of Object.entries(byDate)) {
    if (!normal.has(date)) continue;
    for (const r of rows) {
      if (!per.has(r.h)) per.set(r.h, []);
      per.get(r.h).push({ peak: r.peak, date, at: r.at });
    }
  }
  return [...per.entries()].sort((a, b) => a[0] - b[0]).map(([h, v]) => {
    const s = v.map((x) => x.peak).sort((a, b) => a - b);
    const rec = v.reduce((a, b) => (b.peak > a.peak ? b : a));
    return { h, median: +s[Math.floor(s.length / 2)].toFixed(2), record: rec.peak, recordDate: rec.date, days: v.length };
  });
}

// Live track record: each logged forecast against the 15-minute mean actually measured afterwards.
let scoreCache = { key: "", value: null };
export function liveScore() {
  let files = [];
  try { files = fs.readdirSync(LIVE_DIR).filter((f) => /^iv2_live_\d{8}\.csv$/.test(f)).sort(); } catch { return null; }
  const logFile = path.join(LIVE_DIR, "forecast_log.csv");
  let logStat;
  try { logStat = fs.statSync(logFile); } catch { return null; }
  const key = logStat.mtimeMs + "|" + files.map((f) => f + fs.statSync(path.join(LIVE_DIR, f)).mtimeMs).join(",");
  if (scoreCache.key === key) return scoreCache.value;
  const P = new Map(); // minute (ms) -> MW
  for (const f of files) {
    const rows = parseCsv(fs.readFileSync(path.join(LIVE_DIR, f), "latin1"), ";");
    const k = (rows[0] || []).indexOf("Information.Inverter sum P");
    if (k < 0) continue;
    for (const r of rows.slice(1)) {
      if (!r[0] || r[0].startsWith("[")) continue;
      const v = Number(r[k]);
      if (!Number.isFinite(v) || v < -0.1 || v > 20) continue;
      const [dd, mm, yyyy] = r[0].split(".");
      const t = Date.parse(`${yyyy}-${mm}-${dd}T${r[1]}Z`);
      if (!Number.isNaN(t)) P.set(t, v);
    }
  }
  const mean15 = (end) => {
    let s = 0, n = 0;
    for (let t = end - 14 * 60000; t <= end; t += 60000) if (P.has(t)) { s += P.get(t); n++; }
    return n >= 12 ? s / n : null;
  };
  const rows = parseCsv(fs.readFileSync(logFile, "utf8"));
  const head = rows[0];
  const col = (r, name) => Number(r[head.indexOf(name)]);
  const acc = { 15: [], 30: [], 60: [] };
  let first = null, last = null;
  for (const r of rows.slice(1)) {
    if (!(r[head.indexOf("status")] || "").startsWith("ok")) continue;
    const t = Date.parse(r[0].replace(" ", "T") + ":00Z");
    if (Number.isNaN(t)) continue;
    const now = col(r, "p_now_mw");
    for (const h of [15, 30, 60]) {
      const cs = col(r, `clear_sky_${h}min_mw`);
      if (!(cs >= 1)) continue; // daylight only
      const truth = mean15(t + h * 60000);
      if (truth === null) continue;
      acc[h].push([Math.abs(col(r, `p_${h}min_mw`) - truth), Math.abs(now - truth)]);
      first = first === null ? t : Math.min(first, t); last = last === null ? t : Math.max(last, t);
    }
  }
  const value = {
    from: first ? new Date(first).toISOString() : null, to: last ? new Date(last).toISOString() : null,
    horizons: [15, 30, 60].map((h) => {
      const a = acc[h];
      if (!a.length) return { horizon_min: h, n: 0 };
      const m = (i) => +(a.reduce((s, x) => s + x[i], 0) / a.length).toFixed(2);
      return { horizon_min: h, n: a.length, mae_mw: m(0), persistence_mae_mw: m(1) };
    }),
  };
  scoreCache = { key, value };
  return value;
}

export function summaryAll() {
  const all = days();
  const have = new Set(all.map((d) => d.date));
  const partial = all.filter((d) => d.date !== new Date().toISOString().slice(0, 10) && d.minutes !== null && d.minutes !== undefined && d.minutes < FULL_DAY_MIN).map((d) => d.date);
  const today = new Date().toISOString().slice(0, 10);
  const isNormal = (d) => d.date !== today && (d.status ? d.status === "Normal" : (d.minutes ?? 0) >= FULL_DAY_MIN);
  const normal = all.filter(isNormal);
  const best = all.reduce((a, b) => (b.mwh > a.mwh ? b : a));
  const peakDay = all.reduce((a, b) => ((b.peakMw ?? 0) > (a.peakMw ?? 0) ? b : a));
  const byDate = hourlyByDate();
  let bestHour = null;
  for (const [date, rows] of Object.entries(byDate)) for (const r of rows) if (!bestHour || r.mwh > bestHour.mwh) bestHour = { ...r, date };
  const hz = frequency.map((f) => f.median_hz).sort((a, b) => a - b);
  const v15 = accV2.horizons.find((h) => h.horizon_min === 15);
  return {
    days: all.length, first: all[0].date, last: all.at(-1).date,
    missing: missingDates(all[0].date, all.at(-1).date, have), partial,
    energy_mwh: Math.round(all.reduce((s, d) => s + (d.mwh || 0), 0)),
    avg_day_mwh: +(normal.reduce((s, d) => s + d.mwh, 0) / normal.length).toFixed(1), normal_days: normal.length,
    best_day: best.date, best_mwh: best.mwh,
    peak_mw: peakDay.peakMw, peak_day: peakDay.date,
    best_hour: bestHour,
    mae15: v15.mae_mw, persist15: v15.persistence_mae_mw,
    operator: accV2.operator_view_next15,
    median_hz: hz[Math.floor(hz.length / 2)],
  };
}
