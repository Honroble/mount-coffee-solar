// All irradiance the system has, for today: the plant's four pyranometers (logger, 1-minute), satellite
// irradiance over the plant and the 20 km ring (Open-Meteo / EUMETSAT, 10-minute), the weather models'
// forecast on the 10° panel plane, and a clear-sky reference. Server side only.
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv } from "@/lib/live";

const SENTINELS = new Set([655.35, 6553.5, 65535]);
export const SENSORS = [
  { key: "sts1_up", channel: "FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated", label: "STS1 horizontal (pyranometer up)" },
  { key: "sts3_up", channel: "FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated", label: "STS3 horizontal (pyranometer up)" },
  { key: "sts1_down", channel: "FPE.PV.STS1.Pyranometer.down.irradiation_temp_compensated", label: "STS1 reflected (pyranometer down)" },
  { key: "sts3_down", channel: "FPE.PV.STS3.Pyranometer.down.irradiation_temp_compensated", label: "STS3 reflected (pyranometer down)" },
];
const LAT = 6.505, LON = -10.648;

function num(s) {
  if (s === undefined || s === null || String(s).trim() === "") return null;
  const v = Number(String(s).replace(",", "."));
  return Number.isFinite(v) && !SENTINELS.has(v) && v > -20 && v < 1600 ? Math.max(v, 0) : null;
}
const ymd = (d) => d.toISOString().slice(0, 10);

function sensorsToday(now) {
  let text;
  try { text = fs.readFileSync(path.join(LIVE_DIR, `iv1_live_${ymd(now).replace(/-/g, "")}.csv`), "latin1"); } catch { return { series: [], latest: null }; }
  const rows = parseCsv(text, ";");
  const head = rows[0] || [];
  const col = Object.fromEntries(SENSORS.map((s) => [s.key, head.indexOf(s.channel)]));
  const buckets = new Map();
  let latest = null;
  for (const r of rows.slice(1)) {
    if (!r[0] || r[0].startsWith("[")) continue;
    const [dd, mm, yyyy] = r[0].split(".");
    const t = new Date(`${yyyy}-${mm}-${dd}T${r[1]}Z`);
    if (isNaN(t)) continue;
    const k = Math.floor(t.getTime() / 300000) * 300000;
    const b = buckets.get(k) || {};
    const vals = { time: t.toISOString() };
    for (const s of SENSORS) {
      const v = col[s.key] >= 0 ? num(r[col[s.key]]) : null;
      vals[s.key] = v;
      if (v === null) continue;
      b[s.key] = b[s.key] || { s: 0, n: 0 };
      b[s.key].s += v; b[s.key].n += 1;
    }
    buckets.set(k, b);
    latest = vals;
  }
  const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([k, b]) => {
    const o = { t: new Date(k + 150000).toISOString() };   // middle of the 5 minutes
    for (const s of SENSORS) o[s.key] = b[s.key] ? Math.round(b[s.key].s / b[s.key].n) : null;
    return o;
  });
  return { series, latest, missing: SENSORS.filter((s) => col[s.key] < 0).map((s) => s.key) };
}

function satelliteToday(now) {
  let text;
  try { text = fs.readFileSync(path.join(LIVE_DIR, "sat_recent.csv"), "utf8"); } catch { return { series: [], latest: null }; }
  const rows = parseCsv(text);
  const head = rows[0] || [];
  const plant = 1;                                           // the column right after time_utc is the plant
  const ring = head.map((h, i) => (h.startsWith("r20") ? i : -1)).filter((i) => i >= 0);
  const day = ymd(now);
  const series = [];
  for (const r of rows.slice(1)) {
    if (!r[0] || !r[0].startsWith(day)) continue;
    const p = num(r[plant]);
    if (p === null) continue;
    const rv = ring.map((i) => num(r[i])).filter((v) => v !== null);
    const end = new Date(r[0] + ":00Z");
    series.push({ t: new Date(end.getTime() - 300000).toISOString(), end: end.toISOString(), plant: p,
                  ring: rv.length ? Math.round(rv.reduce((a, b) => a + b, 0) / rv.length) : null });
  }
  return { series, latest: series.at(-1) ?? null };
}

function modelsToday(now) {
  let fc;
  try { fc = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "nwp_forecast.json"), "utf8")); } catch { return { hourly: [], quarter: [] }; }
  const day = ymd(now);
  return {
    issued: fc.issued,
    hourly: (fc.hourly || []).filter((h) => h.t.startsWith(day) && h.gti !== undefined).map((h) => ({ t: h.t, gti: h.gti })),
    quarter: (fc.quarter || []).filter((q) => q.t.startsWith(day) && q.gti !== undefined).map((q) => ({ t: q.t, gti: q.gti })),
  };
}

// Clear-sky horizontal irradiance (Haurwitz) with the NOAA sun position.
export function clearSkyGhi(t) {
  const rad = Math.PI / 180;
  const jd = t.getTime() / 86400000 + 2440587.5, n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const ha = ((gmst * 15 + LON) * rad) - ra;
  const cosz = Math.sin(LAT * rad) * Math.sin(dec) + Math.cos(LAT * rad) * Math.cos(dec) * Math.cos(ha);
  return cosz > 0.01 ? Math.round(1098 * cosz * Math.exp(-0.057 / cosz)) : 0;
}

export function irradianceSnapshot(now = new Date()) {
  const day = ymd(now);
  const clear = [];
  for (let m = 5 * 60; m <= 19.5 * 60; m += 10) {
    const t = new Date(`${day}T00:00:00Z`); t.setUTCMinutes(m);
    clear.push({ t: t.toISOString(), ghi: clearSkyGhi(t) });
  }
  const s = sensorsToday(now);
  return {
    sensors: s.series, sensorsLatest: s.latest, sensorsMissing: s.missing || [],
    satellite: satelliteToday(now), models: modelsToday(now), clearSky: clear,
    clearSkyNow: clearSkyGhi(now), labels: Object.fromEntries(SENSORS.map((x) => [x.key, x.label])),
  };
}
