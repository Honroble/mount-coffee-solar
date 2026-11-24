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

// Weekly review without AI: numbers and rule-based checks of the open contractor issues (no API key needed)
export function quickWeekly() {
  const g = gridReport();
  const full = g.days.filter((d) => !d.partial);
  const ds = full.slice(0, 7), prev = full.slice(7, 14);
  if (!ds.length) return "MOUNT COFFEE SOLAR · WEEKLY REVIEW\nNo complete days of data yet.";
  const S = (arr, k) => arr.reduce((a, d) => a + (Number(d[k]) || 0), 0);
  const avg = (arr, k) => { const v = arr.map((d) => d[k]).filter((x) => x != null && Number.isFinite(Number(x))); return v.length ? v.reduce((a, x) => a + Number(x), 0) / v.length : null; };
  const LK = ["trip_lost_mwh_est", "fault_lost_mwh_est", "string_lost_mwh_est", "curtailed_mwh_est"];
  const lostOf = (arr) => LK.reduce((a, k) => a + S(arr, k), 0);
  const since = ds[ds.length - 1].date, until = ds[0].date;
  const prod = S(ds, "inverter_mwh"), lost = lostOf(ds);
  const f1 = (x) => (x == null ? "n/a" : Number(x).toFixed(1));
  const out = [`MOUNT COFFEE SOLAR · WEEKLY REVIEW ${since} to ${until} (${ds.length} days)`, ""];
  out.push("1. WEEK IN NUMBERS");
  out.push(`Produced ${prod.toFixed(1)} MWh (inverters); export ${S(ds, "export_mwh").toFixed(1)} MWh (P01+P04, days with feeder data).`);
  out.push(`PR ${f1(avg(ds, "pr_pct"))} %, inverter availability ${f1(avg(ds, "availability_pct"))} %.`);
  out.push(`Estimated losses ${lost.toFixed(1)} MWh (${prod + lost > 0 ? ((lost / (prod + lost)) * 100).toFixed(1) : "0"} % of potential): grid trips ${S(ds, LK[0]).toFixed(1)}, inverter alarms ${S(ds, LK[1]).toFixed(1)}, dead strings ${S(ds, LK[2]).toFixed(1)}, export limit ${S(ds, LK[3]).toFixed(1)} MWh.`);
  const gaps = ds.filter((d) => d.coverage_pct != null && d.coverage_pct < 95).map((d) => d.date.slice(5));
  if (gaps.length) out.push(`Data gaps (PC off) on ${gaps.join(", ")}: those days read low.`);
  out.push("");
  out.push("2. COMPARED WITH THE WEEK BEFORE");
  const prevInv = prev.filter((d) => d.inverter_mwh != null);
  if (prevInv.length >= 5 && prev.some((d) => d.fault_lost_mwh_est != null)) {
    const pp = S(prev, "inverter_mwh") / prevInv.length, cp = prod / Math.max(1, ds.filter((d) => d.inverter_mwh != null).length);
    out.push(`Average day ${cp.toFixed(1)} MWh vs ${pp.toFixed(1)} MWh (${cp >= pp ? "+" : ""}${(cp - pp).toFixed(1)}). Losses ${lost.toFixed(1)} vs ${lostOf(prev).toFixed(1)} MWh.`);
    out.push(`PR ${f1(avg(ds, "pr_pct"))} vs ${f1(avg(prev, "pr_pct"))} %; irradiation ${f1(S(ds, "irradiation_kwh_m2"))} vs ${f1(S(prev, "irradiation_kwh_m2"))} kWh/m2.`);
  } else out.push("Not enough data from the week before yet (loss tracking began 23 Nov 2026).");
  out.push("");
  out.push("3. OPEN CONTRACTOR ISSUES (checked against the data)");
  const invDays = ds.filter((d) => d.inverters);
  const insDays = invDays.filter((d) => d.alarms.some((a) => a.code === 39));
  out.push(`- Morning insulation alarms (code 39): ${!invDays.length ? "cannot tell (no inverter data)" : insDays.length ? `STILL OCCURRING on ${insDays.length} of ${invDays.length} day${invDays.length === 1 ? "" : "s"} with inverter data, about ${S(insDays, "fault_lost_mwh_est").toFixed(1)} MWh lost (est.)` : `NOT SEEN on ${invDays.length} days - looks fixed`}.`);
  const strDays = ds.filter((d) => d.dead_strings != null && d.string_lost_mwh_est != null);
  const dead = strDays.length ? strDays[0].dead_strings : null, deadOld = strDays.length ? strDays[strDays.length - 1].dead_strings : null;
  out.push(`- Dead DC strings: ${dead == null ? "cannot tell (no string check)" : dead === 0 ? "NONE in the latest check - looks fixed" : `STILL ${dead} strings${deadOld != null && deadOld !== dead ? ` (was ${deadOld})` : ""}, about ${S(strDays, "string_lost_mwh_est").toFixed(1)} MWh lost (est.) if faults`}.`);
  const p07 = ds.find((d) => d.p07_ratio != null && (d.coverage_pct ?? 0) >= 95) || ds.find((d) => d.p07_ratio != null);
  out.push(`- P07 meter: ${!p07 ? "cannot tell (no feeder data)" : Math.abs(p07.p07_ratio - 1) <= 0.03 ? `LOOKS FIXED (reads ${Math.round(p07.p07_ratio * 100)} % of P01+P04 on ${p07.date})` : `STILL FAULTY (reads ${Math.round(p07.p07_ratio * 100)} % of P01+P04 on ${p07.date})`}.`);
  const inv14 = ds.flatMap((d) => (d.events || []).filter((e) => e.kind === "inverter outage" && /STS2\.INV14\b/.test(e.what)).map(() => d.date));
  const inv14low = ds.filter((d) => d.inverter_mwh != null).filter((d) => (d.low_inverters || []).some((x) => x.startsWith("STS2.INV14"))).length;
  out.push(`- STS2.INV14 dropping out: ${!invDays.length ? "cannot tell" : inv14.length || inv14low ? `STILL OCCURRING (${inv14.length} outage${inv14.length === 1 ? "" : "s"}, low output on ${inv14low} day${inv14low === 1 ? "" : "s"})` : "no outages this week"}.`);
  const trips = (g.trips || []).filter((t) => t.date >= since && t.date <= until);
  const durs = trips.map((t) => Number(t.duration_min)).filter((x) => x > 0);
  out.push(`- Reconnection delay after trips: ${durs.length ? `${Math.min(...durs)}-${Math.max(...durs)} min over ${durs.length} trips${Math.max(...durs) > 6 ? " - STILL LONG" : " - improved"}` : "no trips this week to judge"}.`);
  out.push("- Reactive power / cos phi setpoints recorded by the logger: cannot be checked from the data; open until the contractor confirms.");
  out.push("");
  out.push("4. GRID TRIPS (for NLDC)");
  if (trips.length) {
    out.push(`${trips.length} trips, about ${trips.reduce((a, t) => a + (Number(t.energy_lost_mwh_est) || 0), 0).toFixed(1)} MWh lost (est.):`);
    for (const t of trips.slice().reverse()) out.push(`  ${t.trip_utc} ${t.scope}: ${t.cause}, ${t.freq_min_hz}-${t.freq_max_hz} Hz, back after ${t.duration_min || "?"} min`);
  } else out.push("No trips this week.");
  out.push("");
  out.push("5. TOP ACTIONS (most energy first)");
  const acts = [
    [S(insDays, "fault_lost_mwh_est"), "Contractor: insulation tests on the arrays and review of the insulation trip threshold."],
    [trips.reduce((a, t) => a + (Number(t.energy_lost_mwh_est) || 0), 0), "NLDC: grid frequency events causing trips; contractor: shorten the reconnection delay if the grid code allows."],
    [S(strDays, "string_lost_mwh_est"), "Contractor: check the as-built string count; inspect fuses, connectors and DC isolators of the dead strings."],
    [S(ds, LK[3]), "Dispatch: review the 16.64 MW export limit at midday."],
  ].filter(([v]) => v > 0.05).sort((a, b) => b[0] - a[0]).slice(0, 3);
  acts.forEach(([v, t], i) => out.push(`${i + 1}. ${t} (~${v.toFixed(1)} MWh this week)`));
  if (!acts.length) out.push("No significant losses measured this week.");
  out.push("");
  out.push("All losses are estimates from the plant's own data. (Automatic review, no AI.)");
  return out.join("\n");
}
