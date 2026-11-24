// Free answers (no AI, no API key): fixed-format text built straight from the plant data.
// Used by the dashboard quick buttons, the shift reports and the alert e-mails
// whenever no Anthropic API key is set.
import { runTool } from "@/lib/agent/tools";
import { gridReport } from "@/lib/gridreport";
import { clearSkyGhi } from "@/lib/irradiance";
import { kpiDays, kpiSummary } from "@/lib/kpi";

const f1 = (v, d = 1) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d));
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

export const TOPICS = {
  status: "Status now",
  today: "Today so far",
  forecast: "Forecast",
  inverters: "Inverters",
  alerts: "Alerts",
  health: "Plant health",
  performance: "PR & losses",
};

async function status() {
  const s = await runTool("get_live_status");
  const a = s.actual_10s, f = s.latest_forecast;
  const out = [`Mount Coffee solar · ${s.now_gmt.slice(11, 16)} GMT`];
  if (a) {
    out.push(`Actual: ${f1(a.pv_sum_mw, 2)} MW (read ${a.age_s} s ago) · last 5 min average ${f1(s.current_last5min_mw, 2)} MW`);
    out.push(Object.entries(a.stations_mw).map(([k, v]) => `${k} ${f1(v, 2)}`).join(" · ") + " MW");
    out.push(`Irradiance: zone A ${f1(a.irradiance_zoneA_wm2, 0)} · zone 4 ${f1(a.irradiance_zone4_wm2, 0)} W/m² · power limit ${f1(a.power_limit_pct, 0)} %`);
  } else out.push("No live readings (live poller not running).");
  if (f) out.push(`Forecast (issued ${f.issued.slice(11, 16)}): +15 min ${f1(f.p15)} · +30 min ${f1(f.p30)} · +60 min ${f1(f.p60)} MW (clear sky ${f1(f.cs15)} MW)`);
  if (s.inverters_not_producing.length) out.push(`Not producing: ${s.inverters_not_producing.join(", ")}`);
  return out.join("\n");
}

async function todayText(date = today()) {
  const [p, h, d] = await Promise.all([runTool("get_power_series", { date, step_min: 60 }), runTool("get_hourly_peaks", { date }),
    runTool("get_daily_energy", { from: date, to: date })]);
  const out = [`Mount Coffee solar · ${date}`];
  if (p.error) return out.concat(p.error).join("\n");
  out.push(`Energy so far: ${f1(p.day_energy_mwh)} MWh · peak ${f1(p.day_peak_mw, 2)} MW`);
  const prof = new Map((h.typical_and_record_by_hour || []).map((r) => [r.h, r]));
  const hours = (h.hours || []).filter((r) => r.peak > 0.2);
  if (hours.length) {
    const best = hours.reduce((a, b) => (b.mwh > a.mwh ? b : a));
    const top = hours.reduce((a, b) => (b.peak > a.peak ? b : a));
    out.push(`Peak ${f1(top.peak, 2)} MW at ${top.at} · best hour ${hh(best.h)}–${hh(best.h + 1)} with ${f1(best.mwh)} MWh`);
    out.push("Hourly peak (typical):");
    for (const r of hours) out.push(`  ${hh(r.h)}  ${f1(r.peak, 1).padStart(5)} MW (${f1(prof.get(r.h)?.median, 1)})  ${f1(r.mwh)} MWh`);
  }
  const avg = d.whole_period_summary?.avg_day_mwh;
  if (avg) out.push(`Average normal day: ${avg} MWh`);
  return out.join("\n");
}

async function forecast() {
  const [s, w] = await Promise.all([runTool("get_live_status"), runTool("get_weather_outlook")]);
  const f = s.latest_forecast;
  const out = ["Mount Coffee solar · forecast"];
  if (f) out.push(`Next hour (issued ${f.issued.slice(11, 16)} GMT): +15 min ${f1(f.p15)} MW · +30 min ${f1(f.p30)} MW · +60 min ${f1(f.p60)} MW`);
  for (const d of (w.days || []).slice(0, 3)) out.push(`${d.date}: ${f1(d.newMwh)} MWh expected (range ${f1(d.lowMwh, 0)}–${f1(d.highMwh, 0)})`);
  const next = (w.next_24h_hourly || []).filter((h) => h.mw > 0.2).slice(0, 8);
  if (next.length) out.push("Coming hours: " + next.map((h) => `${h.hour_ending.slice(11, 13)}h ${f1(h.mw)}`).join(" · ") + " MW");
  for (const a of (w.alerts || []).slice(0, 4)) out.push(`⚠ ${a.text || a}`);
  return out.join("\n");
}

async function inverters() {
  const r = await runTool("get_inverters", { date: today() });
  if (r.error) return r.error;
  const out = [`Inverters at ${r.time} GMT: ${r.producing} of ${r.total} producing · plant ${f1(r.plant_mw, 2)} MW`];
  if (r.at_zero_while_others_produce.length) out.push(`At zero while others produce: ${r.at_zero_while_others_produce.join(", ")}`);
  const by = {};
  for (const i of r.inverters_kw) { const st = i.inverter.split(".")[0]; (by[st] ||= []).push(i.kw ?? 0); }
  for (const [st, v] of Object.entries(by)) out.push(`${st}: ${f1(v.reduce((a, b) => a + b, 0) / 1000, 2)} MW, lowest ${f1(Math.min(...v), 0)} kW, highest ${f1(Math.max(...v), 0)} kW`);
  const weak = (r.history_health || []).filter((h) => h.relative_output_pct < 95).map((h) => `${h.inverter} ${h.relative_output_pct} %`);
  if (weak.length) out.push(`Below 95 % of the others since September: ${weak.join(", ")}`);
  return out.join("\n");
}

async function alerts() {
  const r = await runTool("get_alerts", { days: 2 });
  const out = ["Alerts, last 2 days:"];
  out.push(...(r.alerts.length ? r.alerts.slice(-12).map((l) => "• " + l.slice(0, 300)) : ["none"]));
  if (r.recent_collector_problems.length) out.push("Collector:", ...r.recent_collector_problems.slice(-3).map((l) => "• " + l.slice(0, 200)));
  return out.join("\n");
}

async function health() {
  const s = await runTool("get_live_status");
  const icon = { ok: "✓", warn: "!", bad: "✗", na: "–" };
  return ["Plant health checks:", ...(s.health_checks || []).map((c) => `${icon[c.state] || "·"} ${c.check}: ${c.detail || ""}`)].join("\n");
}

async function performance(date) {
  const days = kpiDays();
  const d = (date && days.find((x) => x.date === date)) || days.at(-1);
  if (!d) return "No KPI data yet (kpi.py has not run).";
  const s = kpiSummary(days).last30, L = d.losses_mwh;
  const out = [`Performance ${d.date}${d.minutes < 1300 ? " (part day)" : ""}`,
    `PR ${f1(d.pr_pct)} % (temperature-corrected ${f1(d.pr_temp_pct)} %) · 30-day ${f1(s.pr)} %`,
    `Availability ${f1(d.availability_pct)} % · specific yield ${f1(d.specific_yield, 2)} kWh/kWp · sunlight ${f1(d.insolation_kwh_m2, 2)} kWh/m² · soiling ratio ${f1(d.soiling_ratio_pct)} %`,
    `Clear sky ${f1(L.clear_sky)} MWh → cloud ${f1(L.cloud)} · clipping ${f1(L.clipping)} · curtailment ${f1(L.curtailment)} · outage ${f1(L.plant_outage)} · inverters down ${f1(L.inverters_down)} · soiling ${f1(L.soiling)} · other ${f1(L.other)} → produced ${f1(L.actual)} MWh`];
  if (d.outage_minutes) out.push(`Plant stopped in daylight for ${d.outage_minutes} min.`);
  if (d.weakest_inverters?.length) out.push(`Lowest availability: ${d.weakest_inverters.map((w) => `${w.inverter} ${w.availability_pct} %`).join(", ")}`);
  return out.join("\n");
}

export async function quickAnswer(topic) {
  switch (topic) {
    case "status": return status();
    case "today": return todayText();
    case "yesterday": return todayText(yesterday());
    case "forecast": return forecast();
    case "inverters": return inverters();
    case "alerts": return alerts();
    case "health": return health();
    case "performance": return performance();
    default: return `Pick one of: ${Object.keys(TOPICS).join(", ")}`;
  }
}

// Shift report without AI
export async function quickReport(period) {
  const day = period === "morning" ? yesterday() : today();
  const fva = await runTool("get_forecast_vs_actual", { date: day });
  const acc = fva.summary?.["+15"];
  const parts = [
    `MOUNT COFFEE SOLAR · ${period === "morning" ? "MORNING" : "EVENING"} REPORT`,
    "",
    await todayText(day),
    "",
    acc ? `Forecast ${day}: +15 min missed by ${acc.mae_mw} MW on average (repeat-last ${acc.repeat_last_mae_mw} MW, ${acc.n} forecasts)` : "Forecast accuracy: not enough data",
    "",
    await forecast(),
    "",
    await performance(day),
    "",
    await inverters(),
    "",
    await health(),
  ];
  return parts.join("\n");
}

// Facts added to an alert e-mail without AI
export async function quickContext() {
  const s = await runTool("get_live_status");
  const a = s.actual_10s, f = s.latest_forecast, w = s.weather_station_latest;
  const out = ["Plant data at the time of the alert:"];
  if (a) out.push(`• Actual ${f1(a.pv_sum_mw, 2)} MW · STS ${Object.values(a.stations_mw).map((v) => f1(v, 1)).join(" / ")} MW · power limit ${f1(a.power_limit_pct, 0)} %`);
  if (a) out.push(`• Irradiance zone A ${f1(a.irradiance_zoneA_wm2, 0)} / zone 4 ${f1(a.irradiance_zone4_wm2, 0)} W/m²` + (w ? ` · pyranometer STS1 ${f1(w.ghi_sts1, 0)} W/m², rain ${f1(w.rain_mmh, 1)} mm/h` : ""));
  if (f) out.push(`• Forecast (issued ${f.issued.slice(11, 16)}): +15 ${f1(f.p15)} · +30 ${f1(f.p30)} · +60 ${f1(f.p60)} MW · clear sky ${f1(f.cs15)} MW`);
  if (s.inverters_not_producing.length) out.push(`• Not producing: ${s.inverters_not_producing.join(", ")}`);
  const hint = [];
  if (a && f && f.cs15 > 3) {
    const kOut = a.pv_sum_mw / f.cs15;                                     // output as a share of clear-sky output
    const gcs = clearSkyGhi(new Date());
    const ghi = a.irradiance_zoneA_wm2 ?? w?.ghi_sts1 ?? null;
    const kSun = ghi != null && gcs > 50 ? ghi / gcs : null;               // sunlight as a share of clear-sky sunlight
    if (a.power_limit_pct != null && a.power_limit_pct < 100) hint.push(`power limit at ${f1(a.power_limit_pct, 0)} % (curtailment)`);
    if (s.inverters_not_producing.length) hint.push(`${s.inverters_not_producing.length} inverter(s) at zero`);
    if (kSun !== null && kSun < 0.4 && kOut < 0.4) hint.push(`sunlight only ${Math.round(kSun * 100)} % of clear sky: cloud or rain`);
    else if (kSun !== null && kSun > 0.6 && kOut < 0.5 && !hint.length) hint.push(`sunlight is ${Math.round(kSun * 100)} % of clear sky but output only ${Math.round(kOut * 100)} %: check inverters, breakers and the grid`);
  }
  if (hint.length) out.push(`• Likely: ${hint.join("; ")}`);
  return out.join("\n");
}

// Weekly review without AI: the numbers only (used when no API key is set)
export function quickWeekly() {
  const g = gridReport();
  const ds = g.days.filter((d) => !d.partial).slice(0, 7);
  const S = (k) => ds.reduce((a, d) => a + (Number(d[k]) || 0), 0);
  const prod = S("inverter_mwh"), lost = ["trip_lost_mwh_est", "fault_lost_mwh_est", "string_lost_mwh_est", "curtailed_mwh_est"].reduce((a, k) => a + S(k), 0);
  const since = ds.length ? ds[ds.length - 1].date : "";
  const until = ds[0]?.date || "";
  const trips = (g.trips || []).filter((t) => t.date >= since && t.date <= until);
  const p07 = ds.find((d) => d.p07_ratio != null)?.p07_ratio;
  return [
    `MOUNT COFFEE SOLAR · WEEKLY REVIEW (${since} to ${ds[0]?.date || ""}, ${ds.length} days)`,
    `Produced ${prod.toFixed(1)} MWh. Estimated losses ${lost.toFixed(1)} MWh (${prod + lost > 0 ? ((lost / (prod + lost)) * 100).toFixed(1) : "0"} % of potential):`,
    `  grid trips ${S("trip_lost_mwh_est").toFixed(1)}, inverter alarms ${S("fault_lost_mwh_est").toFixed(1)}, dead strings ${S("string_lost_mwh_est").toFixed(1)}, export limit ${S("curtailed_mwh_est").toFixed(1)} MWh.`,
    `Trips: ${trips.length}${trips.length ? " - " + trips.map((t) => `${t.trip_utc} ${t.scope} ${t.cause} (${t.duration_min || "?"} min)`).join("; ") : ""}.`,
    `P07 meter: ${p07 != null ? `reads ${Math.round(p07 * 100)} % of P01+P04` + (Math.abs(p07 - 1) <= 0.03 ? " (looks fixed)" : " (still faulty)") : "no data"}.`,
    "(Automatic numbers-only review; the written AI review needs the API key on the forecast PC.)",
  ].join("\n");
}
