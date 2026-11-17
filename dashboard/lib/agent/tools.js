// Read-only tools the AI agent can call. Every tool reads files the forecast PC already writes;
// none of them can send anything to the logger, the inverters or the portal.
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv, readLogger } from "@/lib/live";
import { getLive } from "@/lib/snapshot";
import { getNow } from "@/lib/now";
import { dailyActuals } from "@/lib/nwp";
import { hourlyByDate, hourlyProfile, liveScore, summaryAll } from "@/lib/summary";
import { replay15, inverters as invHistory, frequency, reportDaily } from "@/lib/history";

const PLANT = {
  name: "LEC Mount Coffee PV plant, Liberia (Liberia Electricity Corporation)",
  dc_mwp: 21.17, ac_mw: 17.79, export_limit_mw: 16.64, inverters: 52,
  stations: { STS1: 14, STS2: 14, STS3: 12, STS4: 12 },
  logger: "Gantner Q.reader, read through ras.gantner-webportal.com (read-only)",
  time_zone: "GMT (Liberia time, same as UTC)",
  panels: "fixed, facing south, 10 degree tilt",
  forecast: "v2 model issued every 5 minutes for +15/+30/+60 min (mean of the 15 minutes ending at that time); weather-model (NWP) forecast for hours to 3 days",
  energy_note: "logger energy is inverter-side, about 1.9 % above grid export (J07 meter)",
};

const r2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100);
const ymd = (d) => d.replace(/-/g, "");
const dayStart = (date) => new Date(date + "T00:00:00Z");
const inWindow = (t, date, from, to) => {
  const hm = t.toISOString().slice(11, 16);
  return t.toISOString().slice(0, 10) === date && (!from || hm >= from) && (!to || hm <= to);
};

function readText(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }

function forecastRows(date) {
  const text = readText(path.join(LIVE_DIR, "forecast_log.csv"));
  if (!text) return [];
  const rows = parseCsv(text);
  const head = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]]))).filter((o) => (o.issued_utc || "").startsWith(date));
}

function plantMinutes(date) {
  return readLogger("iv2", dayStart(date)).map(({ t, values }) => ({ t, p: values["Information.Inverter sum P"], values }));
}

function bucket(rows, stepMin, key) {
  const b = new Map();
  for (const r of rows) {
    const v = key(r);
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const k = Math.ceil(r.t.getTime() / (stepMin * 60000)) * stepMin * 60000;
    const o = b.get(k) || { s: 0, n: 0, max: -Infinity, min: Infinity };
    o.s += v; o.n++; o.max = Math.max(o.max, v); o.min = Math.min(o.min, v); b.set(k, o);
  }
  return [...b.entries()].sort((a, c) => a[0] - c[0]).map(([k, o]) => ({ t: new Date(k).toISOString().slice(11, 16), mean: r2(o.s / o.n), max: r2(o.max), min: r2(o.min) }));
}

export const TOOLS = [
  {
    name: "get_plant_info",
    description: "Static facts about the Mount Coffee PV plant: ratings, export limit, stations, time zone, data sources, what the forecasts mean.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_live_status",
    description: "Right now: actual output (10-second PV-Sum and per station), latest 5-minute forecast for +15/+30/+60 min, collector and live-poller health, inverters not producing, latest weather station minute, any low-output warning, plant health checks, today's weather-model outlook.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_power_series",
    description: "Plant output for one day (GMT), aggregated to step_min buckets: mean, max and min MW per bucket. For dates collected live by the forecast PC (from 2026-11-16) it is from the 1-minute logger data; for 2026-09-17..2026-11-13 it falls back to 15-minute history.",
    input_schema: { type: "object", properties: {
      date: { type: "string", description: "YYYY-MM-DD" },
      from: { type: "string", description: "HH:MM GMT, optional" }, to: { type: "string", description: "HH:MM GMT, optional" },
      step_min: { type: "integer", description: "bucket size in minutes (1-60), default 5" } }, required: ["date"] },
  },
  {
    name: "get_forecast_vs_actual",
    description: "Every short-term forecast issued on a day (GMT) with what actually happened 15/30/60 minutes later, and the day's error summary. Use for 'how good was the forecast' or 'why was the forecast wrong'.",
    input_schema: { type: "object", properties: { date: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["date"] },
  },
  {
    name: "get_daily_energy",
    description: "Daily energy (MWh) and peak (MW) per day between two dates, from the logger, plus grid export from the monthly reports where available (since commissioning 2026-03-23). Also the whole-period summary.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  {
    name: "get_hourly_peaks",
    description: "Highest 1-minute output and energy in each hour of a day, against the typical (median) and record peak for that hour.",
    input_schema: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
  },
  {
    name: "get_meteo_series",
    description: "Weather station readings for a day (GMT), aggregated to step_min buckets: pyranometer irradiance STS1/STS3 (W/m2), module and ambient temperature, wind, humidity, rain, soiling. Collected live from 2026-11-16.",
    input_schema: { type: "object", properties: { date: { type: "string" }, from: { type: "string" }, to: { type: "string" }, step_min: { type: "integer" } }, required: ["date"] },
  },
  {
    name: "get_inverters",
    description: "Per-inverter output (kW) at a time on a day (latest minute if no time), which inverters were at zero while others produced, and each inverter's long-run health statistics (availability, relative yield) from the history.",
    input_schema: { type: "object", properties: { date: { type: "string" }, time: { type: "string", description: "HH:MM GMT, optional" } }, required: ["date"] },
  },
  {
    name: "get_weather_outlook",
    description: "Weather-model forecast: expected energy for today and the next days (range), hourly MW for the next 24 h, cloud/rain alerts, and how the weather models scored on past days.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_alerts",
    description: "Alerts the system sent (low-output forecast, output below satellite estimate, curtailment, inverter, stale data, logger disk) in the last N days, and recent collector errors.",
    input_schema: { type: "object", properties: { days: { type: "integer", description: "default 2" } } },
  },
];

const handlers = {
  get_plant_info: async () => PLANT,

  get_live_status: async () => {
    const live = await getLive();
    const n = await getNow();
    const f = live.latestForecast;
    const pts = (n.points || []).filter((p) => Date.parse(p.t) > Date.parse(n.latest?.time_utc || 0) - 300000);
    return {
      now_gmt: live.now,
      actual_10s: n.latest ? { time: n.latest.time_utc, pv_sum_mw: n.latest.pv_sum_mw, age_s: n.ageS,
        stations_mw: Object.fromEntries([1, 2, 3, 4].map((i) => [`STS${i}`, n.latest[`sts${i}_kw`] != null ? r2(n.latest[`sts${i}_kw`] / 1000) : null])),
        irradiance_zoneA_wm2: n.latest.zoneA_ghi_wm2, irradiance_zone4_wm2: n.latest.zone4_ghi_wm2, power_limit_pct: n.latest.power_limit_user_pct } : null,
      current_last5min_mw: pts.length ? r2(pts.reduce((a, p) => a + p.mw, 0) / pts.length) : null,
      latest_forecast: f, collector: live.collector,
      inverters_not_producing: (live.inverters || []).filter((i) => i.kw !== null && !i.online).map((i) => `${i.name} (${i.kw} kW)`),
      weather_station_latest: live.weather,
      health_checks: live.health?.checks?.map((c) => ({ check: c.label, state: c.state, detail: c.text })) ?? null,
      today_outlook: live.nwp?.forecast?.days?.[0] ?? null,
      weather_alerts: live.nwp?.forecast?.alerts ?? [],
    };
  },

  get_power_series: async ({ date, from, to, step_min = 5 }) => {
    const step = Math.min(60, Math.max(1, step_min | 0 || 5));
    const rows = plantMinutes(date).filter((r) => inWindow(r.t, date, from, to));
    if (rows.length) {
      const day = dailyActuals().get(date);
      return { date, source: "logger 1-minute (live collection)", step_min: step, day_energy_mwh: day?.mwh ?? null, day_peak_mw: day?.peakMw ?? null,
        series_mw: bucket(rows, step, (r) => r.p) };
    }
    const h = replay15.filter((r) => r.date === date && (!from || r.time.slice(11, 16) >= from) && (!to || r.time.slice(11, 16) <= to))
      .map((r) => ({ t: r.time.slice(11, 16), actual_mw: r.actual_mw, clear_sky_mw: r.clearsky_mw }));
    if (h.length) return { date, source: "history, 15-minute blocks", series: h };
    return { date, error: "No plant data for this date (history covers 2026-09-17..2026-11-13; live collection from 2026-11-16; none on 14-15 Nov)." };
  },

  get_forecast_vs_actual: async ({ date, from, to }) => {
    const rows = forecastRows(date).filter((o) => (!from || o.issued_utc.slice(11) >= from) && (!to || o.issued_utc.slice(11) <= to));
    if (!rows.length) {
      const h = replay15.filter((r) => r.date === date);
      return h.length ? { date, source: "history replay (15-minute model, tested out-of-sample); each row: actual and the forecasts made 15 and 60 minutes before",
        rows: h.map((r) => ({ t: r.time.slice(11, 16), actual_mw: r.actual_mw, forecast_made_15min_before: r.forecast15_mw, forecast_made_60min_before: r.forecast60_mw, repeat_last_15min: r.persistence15_mw })) }
        : { date, error: "No forecasts logged for this date." };
    }
    const mins = new Map(plantMinutes(date).concat(plantMinutes(new Date(dayStart(date).getTime() + 86400000).toISOString().slice(0, 10))).map((r) => [r.t.getTime(), r.p]));
    const mean15 = (end) => { let s = 0, k = 0; for (let t = end - 14 * 60000; t <= end; t += 60000) if (mins.get(t) != null) { s += mins.get(t); k++; } return k >= 12 ? r2(s / k) : null; };
    const out = rows.map((o) => {
      const t = Date.parse(o.issued_utc.replace(" ", "T") + ":00Z");
      const row = { issued: o.issued_utc.slice(11), model: o.model, status: o.status, now_mw: Number(o.p_now_mw) };
      for (const h of [15, 30, 60]) { row[`f${h}`] = Number(o[`p_${h}min_mw`]); row[`actual${h}`] = mean15(t + h * 60000); row[`clear_sky${h}`] = Number(o[`clear_sky_${h}min_mw`]); }
      return row;
    });
    const err = (h) => { const e = out.filter((r) => r[`actual${h}`] !== null && r[`clear_sky${h}`] >= 1).map((r) => [Math.abs(r[`f${h}`] - r[`actual${h}`]), Math.abs(r.now_mw - r[`actual${h}`])]);
      return e.length ? { n: e.length, mae_mw: r2(e.reduce((a, x) => a + x[0], 0) / e.length), repeat_last_mae_mw: r2(e.reduce((a, x) => a + x[1], 0) / e.length) } : null; };
    return { date, summary: { "+15": err(15), "+30": err(30), "+60": err(60) }, rows: out.length > 160 ? out.filter((_, i) => i % 2 === 0) : out };
  },

  get_daily_energy: async ({ from, to }) => {
    const days = [...dailyActuals().values()].filter((d) => d.date >= from && d.date <= to)
      .map((d) => ({ date: d.date, mwh: d.mwh, peak_mw: d.peakMw, minutes_logged: d.minutes ?? null, status: d.status ?? (d.minutes < 660 ? "part day" : "full day") }));
    const exp = reportDaily.filter((r) => r.date >= from && r.date <= to).map((r) => ({ date: r.date, export_mwh: r.export_mwh, outage: r.outage }));
    let summary = null;
    try { summary = summaryAll(); } catch { /* history only */ }
    return { logger_days: days, grid_export_report_days: exp, whole_period_summary: summary, live_track_record: liveScore() };
  },

  get_hourly_peaks: async ({ date }) => {
    const by = hourlyByDate();
    return { date, hours: by[date] ?? [], typical_and_record_by_hour: hourlyProfile(by) };
  },

  get_meteo_series: async ({ date, from, to, step_min = 15 }) => {
    const step = Math.min(60, Math.max(1, step_min | 0 || 15));
    const rows = readLogger("iv1", dayStart(date)).filter((r) => inWindow(r.t, date, from, to));
    if (!rows.length) return { date, error: "No weather-station data for this date and time window on this PC (live collection from 2026-11-16)." };
    const V = (k) => (r) => r.values[`FPE.PV.${k}`] ?? null;
    const series = {
      ghi_sts1_wm2: V("STS1.Pyranometer.up.irradiation_temp_compensated"), ghi_sts3_wm2: V("STS3.Pyranometer.up.irradiation_temp_compensated"),
      t_module_c: V("STS1.temperature.Temp01 - Module"), t_ambient_c: V("STS1.temperature.Temp02 - Ambient"),
      wind_kmh: V("STS1.WS600.wind_speed_avg."), humidity_pct: V("STS1.WS600.relative_humidity_avg"),
      rain_mmh: V("STS1.WS600.precipitation_intense"), soiling_ratio_pct: V("STS1.DustIQ.soiling_ratio_Sensor01"),
    };
    return { date, step_min: step, series: Object.fromEntries(Object.entries(series).map(([k, f]) => [k, bucket(rows, step, f).map((b) => ({ t: b.t, v: b.mean }))])) };
  },

  get_inverters: async ({ date, time }) => {
    const rows = plantMinutes(date);
    if (!rows.length) return { date, error: "No inverter data for this date on this PC.", history_health: invHistory };
    const before = time ? rows.filter((r) => r.t.toISOString().slice(11, 16) <= time) : rows;
    const pick = before.length ? before.at(-1) : rows[0];
    const inv = Object.entries(pick.values).filter(([k]) => k.endsWith(".active_power_total")).map(([k, v]) => ({ inverter: k.replace(".active_power_total", ""), kw: v }));
    const producing = inv.filter((i) => (i.kw ?? 0) > 5).length;
    return { date, time: pick.t.toISOString().slice(11, 16), plant_mw: pick.p, producing, total: inv.length,
      at_zero_while_others_produce: producing > 10 ? inv.filter((i) => i.kw !== null && i.kw <= 5).map((i) => i.inverter) : [],
      inverters_kw: inv, history_health: invHistory, grid_frequency_history: frequency.slice(-7) };
  },

  get_weather_outlook: async () => {
    const live = await getLive();
    const nwp = live.nwp;
    if (!nwp?.forecast) return { error: "No weather-model forecast yet." };
    const nowMs = Date.parse(live.now);
    return { issued: nwp.forecast.issued ?? null, days: nwp.forecast.days, alerts: nwp.forecast.alerts,
      next_24h_hourly: (nwp.forecast.hourly || []).filter((h) => Date.parse(h.t) >= nowMs - 3600000 && Date.parse(h.t) <= nowMs + 86400000)
        .map((h) => ({ hour_ending: h.end ?? h.t, mw: h.new ?? null, low: h.low ?? null, high: h.high ?? null })),
      score: nwp.score, recent_actuals: nwp.recentActuals };
  },

  get_alerts: async ({ days = 2 }) => {
    const since = new Date(Date.now() - Math.min(30, Math.max(1, days)) * 86400000).toISOString().slice(0, 16).replace("T", " ");
    const lines = (readText(path.join(LIVE_DIR, "alerts_log.txt")) || "").split("\n").filter((l) => l.trim() && l.slice(0, 16) >= since);
    const coll = (readText(path.join(LIVE_DIR, "collector_log.txt")) || "").split("\n").filter((l) => /ERROR|error|failed|poller/i.test(l)).slice(-15);
    return { alerts: lines.slice(-60), recent_collector_problems: coll };
  },
};

export async function runTool(name, input) {
  const h = handlers[name];
  if (!h) return { error: `unknown tool ${name}` };
  try {
    return await h(input || {});
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}
