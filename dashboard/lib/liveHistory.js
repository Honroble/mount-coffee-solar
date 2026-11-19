// History charts that keep growing with the live data: daily energy, grid frequency and inverter health.
// The history files (17 Sep - 13 Nov, built from the logger exports) are extended with every day the forecast PC has
// saved in data/live (iv2_live_YYYYMMDD.csv). Server side only. Each live file is read once and cached by mtime.
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv } from "@/lib/live";
import { dailyActuals } from "@/lib/nwp";
import { kpiDays } from "@/lib/kpi";
import historyDaily from "@/data/history/daily.json";
import historyFreq from "@/data/history/frequency.json";
import historyInv from "@/data/history/inverters.json";

const SENTINELS = new Set([-999999, 999999, -99999, 99999]);
const FULL_DAY_MIN = 1300;
const cache = new Map();

function liveFiles() {
  try { return fs.readdirSync(LIVE_DIR).filter((f) => /^iv2_live_\d{8}\.csv$/.test(f)).sort(); } catch { return []; }
}

function cached(file, build) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.value;
  let value = null;
  try { value = build(file); } catch { value = null; }
  cache.set(file, { mtime: st.mtimeMs, value });
  return value;
}

const val = (s) => { const v = Number(s); return Number.isFinite(v) && !SENTINELS.has(v) ? v : null; };

// One live day: frequency statistics and per-inverter strong-sun output (09:00-15:00 GMT, plant above 5 MW).
function parseDay(file) {
  const rows = parseCsv(fs.readFileSync(file, "latin1"), ";");
  const head = rows[0] || [];
  const iP = head.indexOf("Information.Inverter sum P"), iF = head.indexOf("Active Power.Frequency");
  const inv = head.map((h, i) => [h, i]).filter(([h]) => /^STS\d\.INV\d+\.active_power_total$/.test(h));
  const freq = [];
  const sums = Object.fromEntries(inv.map(([h]) => [h.replace(".active_power_total", ""), { sum: 0, n: 0, zero: 0 }]));
  let date = null, strong = 0;
  for (const r of rows.slice(1)) {
    if (!r[0] || r[0].startsWith("[")) continue;
    const [dd, mm, yyyy] = r[0].split(".");
    date = `${yyyy}-${mm}-${dd}`;
    const f = iF >= 0 ? val(r[iF]) : null;
    if (f !== null && f > 45 && f < 55) freq.push(f);
    const hr = Number((r[1] || "").slice(0, 2));
    const p = iP >= 0 ? val(r[iP]) : null;
    if (hr < 9 || hr >= 15 || p === null || p <= 5) continue;
    strong++;
    for (const [h, i] of inv) {
      const v = val(r[i]);
      if (v === null) continue;
      const o = sums[h.replace(".active_power_total", "")];
      o.sum += v; o.n++; if (v <= 1) o.zero++;
    }
  }
  freq.sort((a, b) => a - b);
  const frequency = freq.length ? {
    date, median_hz: +freq[Math.floor(freq.length / 2)].toFixed(3), min_hz: +freq[0].toFixed(2), max_hz: +freq.at(-1).toFixed(2),
    in_band_pct: +(100 * freq.filter((x) => x >= 49.8 && x <= 50.2).length / freq.length).toFixed(1),
  } : null;
  return date ? { date, frequency, strong, inverters: sums } : null;
}

function liveDays() {
  return liveFiles().map((f) => cached(path.join(LIVE_DIR, f), parseDay)).filter(Boolean);
}

// Daily energy: history + live days, with the clear-sky maximum from the KPI files where known.
export function dailyEnergy() {
  const cs = new Map(kpiDays().map((k) => [k.date, k.losses_mwh?.clear_sky ?? null]));
  const out = new Map(historyDaily.map((d) => [d.date, { ...d }]));
  for (const d of dailyActuals().values()) {
    if (out.has(d.date) && d.source === "logger (history)") continue;
    const today = d.date === new Date().toISOString().slice(0, 10);
    const status = today ? "Today" : d.minutes !== null && d.minutes < FULL_DAY_MIN ? "Part day" : "Normal";
    out.set(d.date, { date: d.date, energy_mwh: d.mwh, clearsky_mwh: cs.get(d.date) ?? out.get(d.date)?.clearsky_mwh ?? null, peak_mw: d.peakMw, status });
  }
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function frequencyDays() {
  const out = new Map(historyFreq.map((d) => [d.date, d]));
  for (const d of liveDays()) if (d.frequency) out.set(d.date, d.frequency);
  return [...out.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Inverter health: the history table (17 Sep - 13 Nov, with alarm codes) plus relative output and dropouts over the
// live days (the live files carry power only, not alarm codes).
export function inverterHealth() {
  const days = liveDays().filter((d) => d.strong > 0);
  const tot = {};
  for (const d of days) for (const [k, o] of Object.entries(d.inverters)) {
    tot[k] ??= { sum: 0, n: 0, zero: 0 };
    tot[k].sum += o.sum; tot[k].n += o.n; tot[k].zero += o.zero;
  }
  const means = Object.entries(tot).filter(([, o]) => o.n > 0).map(([k, o]) => [k, o.sum / o.n]);
  const sorted = means.map(([, m]) => m).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const live = new Map(means.map(([k, m]) => [k, {
    live_relative_output_pct: median ? +(100 * m / median).toFixed(1) : null,
    live_dropout_pct: +(100 * tot[k].zero / tot[k].n).toFixed(2),
  }]));
  const rows = historyInv.map((r) => ({ ...r, ...(live.get(r.inverter) || {}) }));
  const range = days.length ? `${days[0].date} – ${days.at(-1).date}` : null;
  return { rows, live_range: range, live_days: days.length };
}
