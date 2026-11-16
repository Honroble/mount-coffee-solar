// Reads the files the forecast PC writes (server side only).
//   <liveDir>/forecast_log.csv          one row per 15-minute forecast (live_forecast.py)
//   <liveDir>/iv2_live_YYYYMMDD.csv      plant + inverters, 1-minute (portal_collector.py)
//   <liveDir>/iv1_live_YYYYMMDD.csv      weather station, 1-minute
import fs from "fs";
import path from "path";
import os from "os";

export const LIVE_DIR = process.env.MCSOLAR_LIVE_DIR || path.join(process.cwd(), "..", "data", "live");
const SENTINELS = new Set([655.35, 6553.5, 65535]);

function readText(file, enc = "utf8") {
  try { return fs.readFileSync(file, enc); } catch { return null; }
}

// Small CSV reader that understands quoted fields (the status column can hold commas).
export function parseCsv(text, sep = ",") {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const num = (s) => {
  if (s === undefined || s === null || String(s).trim() === "") return null;
  const v = Number(String(s).replace(",", "."));
  return Number.isFinite(v) && !SENTINELS.has(v) ? v : null;
};

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

// Logger-style file -> [{t: Date, values: {channel: number|null}}]
function readLogger(group, day) {
  const text = readText(path.join(LIVE_DIR, `${group}_live_${ymd(day)}.csv`), "latin1");
  if (!text) return [];
  const rows = parseCsv(text, ";");
  if (rows.length < 3) return [];
  const head = rows[0];
  const out = [];
  for (const r of rows.slice(1)) {
    if (!r[0] || r[0].startsWith("[")) continue;
    const [dd, mm, yyyy] = r[0].split(".");
    const t = new Date(`${yyyy}-${mm}-${dd}T${r[1]}Z`);
    if (isNaN(t)) continue;
    const values = {};
    for (let i = 3; i < head.length; i++) values[head[i]] = num(r[i]);
    out.push({ t, values });
  }
  return out;
}

function recentLogger(group, now) {
  const yesterday = new Date(now.getTime() - 86400000);
  return [...readLogger(group, yesterday), ...readLogger(group, now)];
}

function readForecasts(now) {
  const text = readText(path.join(LIVE_DIR, "forecast_log.csv"));
  if (!text) return [];
  const rows = parseCsv(text);
  const head = rows[0];
  const since = now.getTime() - 26 * 3600000;
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => (o[h] = r[i] ?? ""));
    const t = new Date(o.issued_utc.replace(" ", "T") + "Z");
    return {
      issued: isNaN(t) ? null : t.toISOString(),
      p_now: num(o.p_now_mw), p15: num(o.p_15min_mw), p30: num(o.p_30min_mw), p60: num(o.p_60min_mw),
      cs15: num(o.clear_sky_15min_mw), cs30: num(o.clear_sky_30min_mw), cs60: num(o.clear_sky_60min_mw),
      inverters_online: num(o.inverters_online), model: o.model, satellite: o.satellite_used === "True",
      status: o.status,
    };
  }).filter((f) => f.issued && new Date(f.issued).getTime() >= since);
}

const INVERTERS = [];
for (const [s, n, pad] of [["STS1", 14, true], ["STS2", 14, true], ["STS3", 12, true], ["STS4", 12, false]])
  for (let i = 1; i <= n; i++) INVERTERS.push(`${s}.INV${pad ? String(i).padStart(2, "0") : i}`);

export function liveSnapshot() {
  const now = new Date();
  const exists = fs.existsSync(LIVE_DIR);
  const iv2 = recentLogger("iv2", now);
  const iv1 = recentLogger("iv1", now);
  const forecasts = readForecasts(now);
  const lastIv2 = iv2.at(-1)?.t ?? null;
  const lastIv1 = iv1.at(-1)?.t ?? null;

  // 5-minute plant output for the last 24 h
  const since = now.getTime() - 24 * 3600000;
  const buckets = new Map();
  for (const { t, values } of iv2) {
    if (t.getTime() < since) continue;
    const p = values["Information.Inverter sum P"];
    if (p === null) continue;
    const k = Math.floor(t.getTime() / 300000) * 300000;
    const b = buckets.get(k) || { s: 0, n: 0 };
    b.s += p; b.n += 1; buckets.set(k, b);
  }
  const actual = [...buckets.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ t: new Date(k).toISOString(), mw: +(b.s / b.n).toFixed(3) }));

  const latest = iv2.at(-1)?.values ?? {};
  const inverters = INVERTERS.map((name) => {
    const kw = latest[`${name}.active_power_total`] ?? null;
    return { name, station: name.split(".")[0], kw, online: kw !== null && kw > 5 };
  });
  const w = iv1.at(-1)?.values ?? {};
  const W = (k) => w[`FPE.PV.${k}`] ?? null;
  const weather = lastIv1 ? {
    time: lastIv1.toISOString(),
    ghi_sts1: W("STS1.Pyranometer.up.irradiation_temp_compensated"),
    ghi_sts3: W("STS3.Pyranometer.up.irradiation_temp_compensated"),
    t_module: W("STS1.temperature.Temp01 - Module"),
    t_ambient: W("STS1.temperature.Temp02 - Ambient"),
    humidity: W("STS1.WS600.relative_humidity_avg"),
    wind_kmh: W("STS1.WS600.wind_speed_avg."),            // logger stores the average in km/h
    gust_kmh: W("STS1.WS600.wind_speed_max") === null ? null : W("STS1.WS600.wind_speed_max") * 3.6, // max in m/s
    rain_mmh: W("STS1.WS600.precipitation_intense"),
    soiling: W("STS1.DustIQ.soiling_ratio_Sensor01"),
  } : null;

  return {
    now: now.toISOString(), liveDir: LIVE_DIR, liveDirExists: exists,
    collector: { lastPlant: lastIv2?.toISOString() ?? null, lastWeather: lastIv1?.toISOString() ?? null },
    plant: lastIv2 ? {
      time: lastIv2.toISOString(), p_mw: latest["Information.Inverter sum P"] ?? null,
      freq_hz: latest["Active Power.Frequency"] ?? null, setpoint: latest["Active Power.Power_Setpoint"] ?? null,
    } : null,
    actual, forecasts, latestForecast: forecasts.at(-1) ?? null, inverters, weather,
  };
}

// Addresses other PCs can use to open this dashboard (shown in the page footer).
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || [])
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(`http://${a.address}:3000`);
  return out;
}

// On a collaborator's PC there is no data/live folder: set MCSOLAR_SOURCE_URL (in .env.local) to the
// forecast PC's dashboard, e.g. http://10.0.0.25:3000, and the live data is read from there.
export const SOURCE_URL = (process.env.MCSOLAR_SOURCE_URL || "").replace(/\/+$/, "");

export async function getLive() {
  if (!SOURCE_URL) return { ...liveSnapshot(), source: "this PC", servedFrom: lanAddresses() };
  try {
    const r = await fetch(`${SOURCE_URL}/api/live`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { ...j, source: SOURCE_URL, servedFrom: lanAddresses() };
  } catch (e) {
    const local = liveSnapshot();
    return { ...local, source: SOURCE_URL, sourceError: `Cannot reach the forecast PC at ${SOURCE_URL} (${e.message})`,
             servedFrom: lanAddresses() };
  }
}
