"use client";
import { useNow } from "./LiveNow";
import HourlyPeak from "./HourlyPeak";
import AskAI from "./AskAI";
import SystemBanner from "./SystemBanner";
import PerformanceSection from "./PerformanceSection";
import ForecastCheck from "./ForecastCheck";
import RampBanner from "./RampBanner";
import GridStrings from "./GridStrings";
import GridReports from "./GridReports";
import Finance from "./Finance";
import { lowForecastWarning } from "@/lib/lowForecast";
import { useEffect, useMemo, useState } from "react";
import WeatherSection from "./WeatherSection";
import IrradianceSection from "./IrradianceSection";
import HealthSection from "./HealthSection";
import DispatchPanel from "./DispatchPanel";
import VerificationSection from "./VerificationSection";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, ReferenceArea,
} from "recharts";

const C = { actual: "#e6edf3", f15: "#f5a524", f30: "#d2a8ff", f60: "#3fb6c9", cs: "#6b7a8c", good: "#3fb950", bad: "#f85149" };
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "");
const ageMin = (iso, now) => (iso ? Math.round((new Date(now) - new Date(iso)) / 60000) : null);
const axis = { stroke: "#8b98a8", fontSize: 11 };
const grid = <CartesianGrid stroke="#263241" strokeDasharray="3 3" />;
const tip = { contentStyle: { background: "#171e26", border: "1px solid #263241", fontSize: 12 }, labelStyle: { color: "#e6edf3" } };

function fmtDates(list) {
  // 2026-11-14, 2026-11-15 -> "14–15 Nov"; short lists only
  const d = list.map((x) => new Date(x + "T12:00:00Z"));
  const parts = [];
  for (let i = 0; i < d.length; i++) {
    let j = i;
    while (j + 1 < d.length && d[j + 1] - d[j] === 86400000) j++;
    const f = (x) => x.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    parts.push(i === j ? f(d[i]) : `${d[i].getUTCDate()}–${f(d[j])}`);
    i = j;
  }
  return parts.join(", ");
}

function Kpi({ label, value, unit, note }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <span style={{ fontSize: 14, color: "#8b98a8" }}> {unit}</span>}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

function Legend({ items }) {
  return (
    <div className="legend">
      {items.map(([label, color, dashed]) => (
        <span key={label}><i style={{ background: dashed ? "transparent" : color, borderTop: dashed ? `2px dashed ${color}` : "none" }} />{label}</span>
      ))}
    </div>
  );
}

function useLive(initial) {
  const [live, setLive] = useState(initial);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/live", { cache: "no-store" });
        if (r.ok && !stop) setLive({ ...(await r.json()), fetchedAt: new Date().toISOString() });
      } catch { /* keep the last snapshot */ }
    };
    const id = setInterval(tick, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  return live;
}

function LiveSection({ live, trimNight = false }) {
  const [show60, setShow60] = useState(false);
  const f = live.latestForecast;
  const n = useNow();
  const w = n?.latest;
  const nFresh = w && n.ageS <= 90;
  // average of the 10-second live readings over the last 5 minutes
  const last5 = (() => {
    if (!nFresh || !n.points?.length) return null;
    const end = Date.parse(w.time_utc), pts = n.points.filter((p) => Date.parse(p.t) > end - 300000);
    return pts.length ? pts.reduce((a, p) => a + p.mw, 0) / pts.length : null;
  })();
  const lowWarn = lowForecastWarning(f, live.now);
  const fAge = ageMin(f?.issued, live.now);
  const fEvery = (() => {                              // interval between the last forecasts (1 or 5 min)
    const fs = live.forecasts || [];
    if (fs.length < 3) return null;
    const d = (Date.parse(fs[fs.length - 1].issued) - Date.parse(fs[fs.length - 3].issued)) / 120000;
    return d > 0 && d < 10 ? Math.round(d) : null;
  })();
  const cAge = ageMin(live.collector.lastPlant, live.now);
  const state = !live.liveDirExists || cAge === null ? "off" : cAge > 20 ? "stale" : "ok";
  const stateText = {
    off: "No live data yet – the collector has not saved any readings",
    stale: `Collector last saved data ${cAge} min ago`,
    ok: `Collector OK · last reading ${hhmm(live.collector.lastPlant)} GMT`,
  }[state];

  // Today's chart. Every line is placed at the CENTRE of the period it averages, on one 5-minute grid offset by 2.5 min:
  //  actual = 5-minute average (logger bucket k..k+5 -> k+2.5); forecast "15 min" = average over issue..issue+15 -> +7.5;
  //  forecast "30 min" = average over issue+15..issue+30 -> +22.5; forecast "60 min" = average over issue+45..issue+60 -> +52.5.
  //  With forecasts every minute, several issues fall in one 5-minute slot: the newest one is shown. (Until 19 Nov the forecasts were drawn at the END of
  //  their 15-minute window against actuals labelled at the START of theirs, which made the forecast look ~10 min late,
  //  and the newest actuals from the 10-second readings were labelled at the end, 5 min off from the logger's.)
  const series = useMemo(() => {
    const HALF = 150000, STEP = 300000;
    const slot = (ms) => new Date(Math.round((ms - HALF) / STEP) * STEP + HALF).toISOString();
    const m = new Map();
    const put = (t, k, v) => { const o = m.get(t) || { t }; o[k] = v; m.set(t, o); };
    for (const a of live.actual) put(slot(Date.parse(a.t) + HALF), "actual", a.mw);   // a.t = start of the 5-min bucket
    // newest 5-minute averages from the 10-second live readings (the logger files arrive a few minutes late)
    const have = new Set(live.actual.map((a) => slot(Date.parse(a.t) + HALF)));
    const b = new Map();
    for (const p of n?.points || []) {
      const start = Math.floor(Date.parse(p.t) / STEP) * STEP;
      const t = slot(start + HALF);
      if (have.has(t)) continue;
      const o = b.get(t) || [0, 0]; o[0] += p.mw; o[1] += 1; b.set(t, o);
    }
    for (const [t, [sum, cnt]] of b) if (cnt >= 6) put(t, "actual", +(sum / cnt).toFixed(2));
    for (const fc of live.forecasts) {
      const t0 = new Date(fc.issued).getTime();
      if (fc.p15 !== null) put(slot(t0 + 7.5 * 60000), "f15", fc.p15);
      if (fc.p30 !== null) put(slot(t0 + 22.5 * 60000), "f30", fc.p30);
      if (fc.p60 !== null) put(slot(t0 + 52.5 * 60000), "f60", fc.p60);
      if (fc.cs15 !== null) put(slot(t0 + 7.5 * 60000), "cs", fc.cs15);
    }
    const from = live.now.slice(0, 10) + "T05:30:00.000Z";   // today's daylight only
    const all = [...m.values()].filter((p) => p.t >= from).sort((a, b) => (a.t < b.t ? -1 : 1));
    if (!trimNight) return all;
    // new layout: start 30 min before the first actual above 0.05 MW (no hour of flat night)
    const first = all.findIndex((p) => (p.actual ?? 0) > 0.05);
    return first > 6 ? all.slice(first - 6) : all;
  }, [live, n, trimNight]);

  return (
    <section className="panel">
      {lowWarn && <div className="lowwarn">⚠ LOW OUTPUT FORECAST · {lowWarn}</div>}
      <div className="panel-head">
        <div>
          <h2>Actual vs Forecast</h2>
          <div className="sub">Actual output straight from the logger (10-second readings, read-only) and the forecast the PC issues {fEvery ? `every ${fEvery === 1 ? "minute" : `${fEvery} minutes`}` : "regularly"} from the live readings, the weather station and satellite data.</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="status"><span className={`dot ${!w ? "off" : nFresh ? "ok" : "stale"}`} />{w ? `Live · read ${n.ageS} s ago` : "Waiting for the live poller"}</span>{" "}
          <span className="status"><span className={`dot ${state}`} />{stateText}</span>
          {f && <div className="sub" style={{ marginTop: 4 }}>Last forecast {hhmm(f.issued)} GMT ({fAge} min ago) · model: {f.model === "v2" ? "v2 · live plant + weather + satellite" : f.model === "satellite" ? "plant + weather + satellite" : f.model === "weather" ? "plant + weather station" : f.model}</div>}
        </div>
      </div>

      {live.sourceError && <div className="bad-text" style={{ marginBottom: 8 }}>{live.sourceError}. Check that the forecast PC is on and that you are on the same network (or VPN).</div>}
      {f && f.status && f.status !== "ok" && <div className="warn-text" style={{ marginBottom: 8 }}>Forecast status: {f.status}</div>}

      <div className="avfrow">
        <Kpi label="Actual MW" value={nFresh ? fmt(w.pv_sum_mw) : fmt(live.plant?.p_mw)} unit="MW"
             note={nFresh ? `PV-Sum at ${w.time_utc.slice(11, 19)} GMT` : live.plant ? `logger ${hhmm(live.plant.time)} GMT` : ""} />
        {[1, 2, 3, 4].map((i) => (
          <Kpi key={i} label={`STS${i}`} value={nFresh && w[`sts${i}_kw`] != null ? (w[`sts${i}_kw`] / 1000).toFixed(2) : "—"} unit="MW" note="live" />
        ))}
        <Kpi label="Current MW" value={fmt(last5 ?? f?.p_now)} unit="MW" note={last5 != null ? "average, last 5 min" : "average, last 15 min"} />
        <Kpi label="In 15 minutes" value={fmt(f?.p15)} unit="MW" note={f ? `clear sky ${fmt(f.cs15, 1)}` : ""} />
        <Kpi label="In 30 minutes" value={fmt(f?.p30)} unit="MW" note={f ? `clear sky ${fmt(f.cs30, 1)}` : ""} />
        <Kpi label="In 60 minutes" value={fmt(f?.p60)} unit="MW" note={f ? `clear sky ${fmt(f.cs60, 1)}` : ""} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Legend items={[["Actual (5-min average)", C.actual], ["Forecast 0–15 min ahead (its 15-min average, drawn at the middle)", C.f15], ["Forecast 15–30 min ahead", C.f30],
          ...(show60 ? [["Forecast 45–60 min ahead", C.f60]] : []), ["Clear-sky maximum", C.cs, true]]} />
        <label className="sub" style={{ cursor: "pointer", whiteSpace: "nowrap" }}><input type="checkbox" checked={show60} onChange={(e) => setShow60(e.target.checked)} /> show 60-min line</label>
      </div>
      {series.length ? (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            {grid}
            <XAxis dataKey="t" tickFormatter={(t) => hhmm(new Date(Date.parse(t) - 150000).toISOString())} {...axis} minTickGap={40} />
            <YAxis {...axis} unit=" MW" width={62} domain={[0, 18]} />
            <Tooltip {...tip} labelFormatter={(t) => `${hhmm(new Date(Date.parse(t) - 150000).toISOString())}–${hhmm(new Date(Date.parse(t) + 150000).toISOString())} GMT`} formatter={(v) => `${fmt(v)} MW`} />
            <Line dataKey="cs" name="Clear sky" stroke={C.cs} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="actual" name="Actual" stroke={C.actual} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="f15" name="Forecast 15 min" stroke={C.f15} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="f30" name="Forecast 30 min" stroke={C.f30} dot={false} connectNulls isAnimationActive={false} />
            {show60 && <Line dataKey="f60" name="Forecast 60 min" stroke={C.f60} dot={false} connectNulls isAnimationActive={false} />}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="empty">No live readings yet. They appear here once the collector and forecast tasks are running on this PC.<br /><span className="sub">Looking in: {live.liveDir}</span></div>
      )}
    </section>
  );
}

function PlantNow({ live }) {
  const w = live.weather;
  const stations = ["STS1", "STS2", "STS3", "STS4"];
  return (
    <div className="grid two">
      <section className="panel">
        <div className="panel-head">
          <div><h2>Inverters right now</h2><div className="sub">Latest 1-minute reading, kW. Green = producing, red = no output.</div></div>
          {live.plant && <div className="sub">{hhmm(live.plant.time)} GMT · {fmt(live.plant.p_mw)} MW · {fmt(live.plant.freq_hz, 2)} Hz</div>}
        </div>
        {live.plant ? stations.map((s) => (
          <div className="station" key={s}>
            <div className="sub">{s}</div>
            <div className="inv-grid">
              {live.inverters.filter((i) => i.station === s).map((i) => (
                <div key={i.name} className={`inv ${i.kw === null ? "" : i.online ? "on" : "off"}`} title={i.name}>
                  <div className="n">{i.name.split(".")[1].replace("INV", "")}</div>{i.kw === null ? "—" : Math.round(i.kw)}
                </div>
              ))}
            </div>
          </div>
        )) : <div className="empty">Waiting for the first live reading.</div>}
      </section>
      <section className="panel">
        <div className="panel-head">
          <div><h2>Weather station</h2><div className="sub">STS1 WS600, pyranometers and DustIQ, latest minute.</div></div>
          {w && <div className="sub">{hhmm(w.time)} GMT</div>}
        </div>
        {w ? (
          <div className="grid kpis" style={{ margin: 0 }}>
            <Kpi label="Irradiance STS1" value={fmt(w.ghi_sts1, 0)} unit="W/m²" note={`STS3: ${fmt(w.ghi_sts3, 0)} W/m²`} />
            <Kpi label="Module temperature" value={fmt(w.t_module, 1)} unit="°C" note={`ambient ${fmt(w.t_ambient, 1)} °C`} />
            <Kpi label="Wind" value={fmt(w.wind_kmh, 1)} unit="km/h" note={`gusts ${fmt(w.gust_kmh, 1)} km/h`} />
            <Kpi label="Humidity" value={fmt(w.humidity, 0)} unit="%" note={`rain ${fmt(w.rain_mmh, 1)} mm/h`} />
            <Kpi label="Soiling ratio" value={fmt(w.soiling, 1)} unit="%" note="100 % = clean" />
          </div>
        ) : <div className="empty">Waiting for the first weather reading.</div>}
      </section>
    </div>
  );
}

function Replay({ dates, initial }) {
  const [day, setDay] = useState(initial);
  const choose = async (date) => {
    const r = await fetch(`/api/replay?date=${date}`);
    setDay({ date, rows: await r.json() });
  };
  const mae = (k) => {
    const v = day.rows.filter((r) => r[k] != null && r.actual_mw != null);
    return v.length ? v.reduce((s, r) => s + Math.abs(r[k] - r.actual_mw), 0) / v.length : null;
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Forecast vs actual, one day</h2>
          <div className="sub">15-minute averages. Out-of-sample: each day was forecast by a model trained without that day's two-week block.
            {" "}MAE this day: 15-min {fmt(mae("forecast15_mw"))} MW · 60-min {fmt(mae("forecast60_mw"))} MW · persistence {fmt(mae("persistence15_mw"))} MW</div>
        </div>
        <select value={day.date} onChange={(e) => choose(e.target.value)}>
          {[...dates].reverse().map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <Legend items={[["Actual", C.actual], ["Forecast 15 min ahead", C.f15], ["Forecast 60 min ahead", C.f60], ["Clear-sky maximum", C.cs, true]]} />
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={day.rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          {grid}
          <XAxis dataKey="time" tickFormatter={hhmm} {...axis} minTickGap={40} />
          <YAxis {...axis} unit=" MW" width={62} domain={[0, 18]} />
          <Tooltip {...tip} labelFormatter={(t) => `${hhmm(t)} GMT`} formatter={(v) => `${fmt(v)} MW`} />
          <Line dataKey="clearsky_mw" name="Clear sky" stroke={C.cs} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          <Line dataKey="actual_mw" name="Actual" stroke={C.actual} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="forecast15_mw" name="Forecast 15 min" stroke={C.f15} dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="forecast60_mw" name="Forecast 60 min" stroke={C.f60} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
}

function EnergyHistory({ rows, live }) {
  const all = useMemo(() => {
    const m = new Map(rows.map((r) => [r.date, r]));
    for (const a of live.nwp?.recentActuals || []) if (!m.has(a.date) && a.source?.startsWith("logger (live)")) m.set(a.date, { date: a.date, mwh: a.mwh, source: "logger (live)", outage: false });
    return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  }, [rows, live]);
  const months = useMemo(() => {
    const g = new Map();
    for (const r of all) { const k = r.date.slice(0, 7); const o = g.get(k) || { month: k, mwh: 0, days: 0, src: new Set() }; o.mwh += r.mwh; o.days += 1; o.src.add(r.source.split(" ")[0]); g.set(k, o); }
    return [...g.values()];
  }, [all]);
  return (
    <section className="panel">
      <h2>Energy since commissioning</h2>
      <div className="sub">MWh per day from 23 March 2026. Until 31 October: grid export at J07 from the monthly reports. After that: logger energy at the inverters (about 1.9 % higher). Red: confirmed outage days.</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={all} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          {grid}
          <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} {...axis} minTickGap={24} />
          <YAxis {...axis} width={50} />
          <Tooltip {...tip} formatter={(v, n, p) => [`${fmt(v, 1)} MWh (${p.payload.source})`, "Energy"]} />
          <Bar dataKey="mwh" name="Energy" isAnimationActive={false}
               shape={(p) => <rect x={p.x} y={p.y} width={Math.max(1, p.width)} height={p.height} fill={p.payload.outage ? C.bad : p.payload.source.startsWith("J07") ? C.f60 : C.f15} />} />
        </BarChart>
      </ResponsiveContainer>
      <div className="legend"><span><i style={{ background: C.f60 }} />J07 export (report)</span><span><i style={{ background: C.f15 }} />Logger</span><span><i style={{ background: C.bad }} />Outage</span></div>
      <div className="scroll" style={{ maxHeight: 220 }}>
        <table><thead><tr><th>Month</th><th className="num">Energy (MWh)</th><th className="num">Days</th><th className="num">Average (MWh/day)</th><th>Source</th></tr></thead>
          <tbody>{months.map((m) => <tr key={m.month}><td>{m.month}</td><td className="num">{fmt(m.mwh, 1)}</td><td className="num">{m.days}</td><td className="num">{fmt(m.mwh / m.days, 1)}</td><td className="sub">{[...m.src].join(" + ")}</td></tr>)}</tbody>
        </table>
      </div>
    </section>
  );
}

function DailyEnergy({ daily }) {
  return (
    <section className="panel">
      <h2>Daily energy</h2>
      <div className="sub">MWh per day at the inverters (logger) against the clear-sky maximum, updated with every day the PC saves. Red: outage or part day; grey: today so far.</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={daily} margin={{ top: 12, right: 12, left: 0, bottom: 0 }} barGap={-12}>
          {grid}
          <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} {...axis} minTickGap={20} />
          <YAxis {...axis} width={50} />
          <Tooltip {...tip} formatter={(v, n) => [`${fmt(v, 1)} MWh`, n]} />
          <Bar dataKey="clearsky_mwh" name="Clear-sky maximum" fill="#263241" isAnimationActive={false} barSize={12} />
          <Bar dataKey="energy_mwh" name="Produced" isAnimationActive={false} barSize={12}
               shape={(p) => <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={p.payload.status === "Normal" ? C.f15 : p.payload.status === "Today" ? "#4b5a6c" : C.bad} rx={2} />} />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}

function InverterHealth({ data }) {
  const rows = data?.rows || [];
  const hasLive = !!data?.live_days;
  return (
    <section className="panel">
      <h2>Inverter health</h2>
      <div className="sub">Strong-sun minutes (09:00–15:00 GMT, plant above 5 MW). Output relative to the median inverter; below 95 % is highlighted.
        History 17 Sep – 13 Nov (with alarm codes){hasLive ? <>; live {data.live_range} ({data.live_days} days, power only – the live files carry no alarm codes)</> : null}.</div>
      <div className="scroll" style={{ marginTop: 8 }}>
        <table>
          <thead><tr><th>Inverter</th><th className="num">Relative output (history)</th>{hasLive && <th className="num">Relative output (live)</th>}
            <th className="num">Dropouts (history)</th>{hasLive && <th className="num">Dropouts (live)</th>}<th className="num">Alarm minutes</th><th className="num">Main alarm code</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.inverter}>
                <td>{r.inverter}</td>
                <td className={`num ${r.relative_output_pct < 95 ? "warn-text" : ""}`}>{fmt(r.relative_output_pct, 1)} %</td>
                {hasLive && <td className={`num ${r.live_relative_output_pct < 95 ? "warn-text" : ""}`}>{r.live_relative_output_pct == null ? "—" : `${fmt(r.live_relative_output_pct, 1)} %`}</td>}
                <td className={`num ${r.dropout_pct > 1 ? "bad-text" : ""}`}>{fmt(r.dropout_pct, 2)} %</td>
                {hasLive && <td className={`num ${r.live_dropout_pct > 1 ? "bad-text" : ""}`}>{r.live_dropout_pct == null ? "—" : `${fmt(r.live_dropout_pct, 2)} %`}</td>}
                <td className="num">{r.alarm_minutes}</td>
                <td className="num">{r.main_alarm_code ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Frequency({ rows }) {
  return (
    <section className="panel">
      <h2>Grid frequency</h2>
      <div className="sub">Daily median, minimum and maximum at the plant; shaded band is 49.8–50.2 Hz. Dips below 49 Hz are cut off at the bottom.</div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={rows} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
          {grid}
          <ReferenceArea y1={49.8} y2={50.2} fill="#3fb950" fillOpacity={0.08} />
          <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} {...axis} minTickGap={20} />
          <YAxis {...axis} width={62} domain={[49, 51]} ticks={[49, 49.5, 50, 50.5, 51]} allowDataOverflow unit=" Hz" />
          <Tooltip {...tip} formatter={(v, n) => [`${fmt(v, 2)} Hz`, n]} />
          <Line dataKey="max_hz" name="Max" stroke={C.cs} dot={false} isAnimationActive={false} />
          <Line dataKey="median_hz" name="Median" stroke={C.f60} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="min_hz" name="Min" stroke={C.cs} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
}


// ---- Layout choice: "new" (tabs, compact) or "classic" (the single long page as of 19 Nov 2026). Remembered in this
// browser; ?view=classic or ?view=new in the address also sets it.
const VIEW_KEY = "mcsolar-view";
function useView() {
  const [view, setV] = useState("new");
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search).get("view");
      const v = q === "classic" || q === "new" ? q : localStorage.getItem(VIEW_KEY);
      if (v === "classic" || v === "new") setV(v);
    } catch { /* default */ }
  }, []);
  const setView = (v) => { setV(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window */ } };
  return [view, setView];
}

function ViewSwitch({ view, setView }) {
  return (
    <div className="viewswitch">
      Layout:
      <button className={view === "new" ? "on" : ""} onClick={() => setView("new")}>New</button>
      <button className={view === "classic" ? "on" : ""} onClick={() => setView("classic")}>Classic</button>
    </div>
  );
}

const TABS = [
  ["live", "Live"], ["forecast", "Forecast"], ["performance", "Performance"],
  ["health", "Plant health"], ["grid", "Grid & reports"], ["finance", "Finance"], ["history", "History"], ["verification", "Verification"],
];

// Click the first explanation line of a section to show the rest (new layout keeps sections short).
function useExplainToggle() {
  useEffect(() => {
    const onClick = (e) => {
      const el = e.target.closest(".v2 h2 + .sub, .v2 .panel-head .sub");
      if (el && !e.target.closest("a,button,select,input")) el.classList.toggle("open");
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}

function NewLayout({ live, s, liveAcc, liveFrom, liveScore, replayDates, initialReplay, energyAll, daily, inverterHealth, frequency, setView }) {
  const [tab, setTab] = useState("live");
  useEffect(() => {
    const fromHash = () => { const h = window.location.hash.slice(1); if (TABS.some(([k]) => k === h)) setTab(h); };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);
  useExplainToggle();
  const go = (k) => { setTab(k); try { history.replaceState(null, "", `#${k}`); } catch { /* ignore */ } window.scrollTo({ top: 0 }); };
  const lagMin = live.collector.lastPlant ? Math.round((Date.now() - Date.parse(live.collector.lastPlant)) / 60000) : null;
  const dataState = lagMin === null ? "off" : lagMin <= 6 ? "ok" : lagMin <= 20 ? "stale" : "off";
  return (
    <main className="v2">
      <header className="v2head">
        <div className="brand">
          <img src="/lec-logo.png" alt="Liberia Electricity Corporation" width={60} height={60} />
          <div>
            <div className="org">Liberia Electricity Corporation · SCADA/EMS</div>
            <h1>Mount Coffee Solar</h1>
          </div>
        </div>
        <div className="v2tools">
          <span className={`status ${dataState}`}><span className={`dot ${dataState}`} /> {dataState === "ok" ? "Data live" : dataState === "stale" ? "Data delayed" : "No recent data"} · logger {live.collector.lastPlant ? live.collector.lastPlant.slice(11, 16) : "—"} GMT</span>
          <a className="btn" href="/tv">Control-room screen →</a>
          <ViewSwitch view="new" setView={setView} />
        </div>
      </header>
      <SystemBanner />
      <RampBanner />
      <div className="v2summary">
        <b>{s.energy_mwh.toLocaleString()} MWh</b> since {s.first} · average normal day <b>{s.avg_day_mwh} MWh</b> ·
        15-min forecast error <b>{liveAcc?.n ? liveAcc.mae_mw : s.mae15} MW</b> (repeat-last {liveAcc?.n ? liveAcc.persistence_mae_mw : s.persist15} MW)
      </div>
      <nav className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => go(k)}>{label}</button>
        ))}
      </nav>

      {tab === "live" && <>
        <LiveSection live={live} trimNight />
        <DispatchPanel live={live} />
        <PlantNow live={live} />
      </>}
      {tab === "forecast" && <>
        <WeatherSection live={live} />
        <ForecastCheck score={liveScore} />
        <Replay dates={replayDates} initial={initialReplay} />
      </>}
      {tab === "performance" && <>
        <PerformanceSection />
        <HourlyPeak />
        <DailyEnergy daily={daily} />
      </>}
      {tab === "health" && <>
        <HealthSection live={live} />
        <GridStrings />
        <InverterHealth data={inverterHealth} />
        <IrradianceSection live={live} />
      </>}
      {tab === "grid" && <GridReports />}
      {tab === "finance" && <Finance />}
      {tab === "history" && <>
        <div className="grid kpis">
          <Kpi label="Energy, whole period" value={s.energy_mwh.toLocaleString()} unit="MWh" note={`${s.days} days, ${s.first} to ${s.last}`} />
          <Kpi label="Average normal day" value={s.avg_day_mwh} unit="MWh" note={`${s.normal_days} full days`} />
          <Kpi label="Best day" value={s.best_mwh} unit="MWh" note={s.best_day} />
          <Kpi label="Best hour (logger)" value={s.best_hour ? s.best_hour.mwh.toFixed(1) : "—"} unit="MWh" note={s.best_hour ? `${s.best_hour.date} ${String(s.best_hour.h).padStart(2, "0")}:00 GMT` : ""} />
          <Kpi label="15-min forecast error" value={liveAcc?.n ? liveAcc.mae_mw : s.mae15} unit="MW" note={liveAcc?.n ? `live since ${liveFrom} · testing ${s.mae15} MW` : "in testing"} />
          <Kpi label="Median grid frequency" value={s.median_hz.toFixed(2)} unit="Hz" note="normal 49.8–50.2 Hz" />
        </div>
        <EnergyHistory rows={energyAll} live={live} />
        <Frequency rows={frequency} />
        <section className="panel">
          <h2>About this data</h2>
          <div className="sub">LEC Mount Coffee PV plant · 21.17 MWp DC / 17.79 MWac · export limit 16.64 MW · 52 inverters in STS1–STS4 · times are GMT (Liberia time).
            Energy is inverter-side (logger), about 1.9 % above the J07 grid export; days to {s.operator_last || s.first} come from the J07 reports.
            {s.missing.length > 0 && <> No data: {fmtDates(s.missing)}.</>}{s.partial.length > 0 && <> Part days: {fmtDates(s.partial)}.</>}
            {" "}Live data from {live.source === "this PC" || !live.source ? `this PC (${live.liveDir})` : `forecast PC ${live.source}`}.
            {live.servedFrom?.length ? <> Open from another PC: {live.servedFrom.join("  ·  ")}</> : null}</div>
        </section>
      </>}
      {tab === "verification" && <VerificationSection />}
      <AskAI />
    </main>
  );
}

export default function Dashboard({ liveScore, summary: s, daily, energyAll, inverterHealth, frequency, replayDates, initialReplay, initialLive }) {
  const live = useLive(initialLive);
  const liveAcc = liveScore?.horizons?.find((h) => h.horizon_min === 15);
  const liveFrom = liveScore?.from ? new Date(liveScore.from).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
  const [view, setView] = useView();
  if (view === "classic") return (
    <>
      <ViewSwitch view={view} setView={setView} />
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div className="brand">
          <img src="/lec-logo.png" alt="Liberia Electricity Corporation" width={56} height={56} />
          <div>
            <div className="org">Liberia Electricity Corporation · SCADA/EMS</div>
            <h1>Mount Coffee Solar – Forecast &amp; Plant Health</h1>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="sub" style={{ margin: 0 }}>Updates every minute · page {(live.fetchedAt || live.now).slice(11, 19)} GMT · logger {live.collector.lastPlant ? live.collector.lastPlant.slice(11, 16) : "—"} GMT</span>
          <a className="btn" href="/tv">Control-room screen →</a>
        </div>
      </div>
      <SystemBanner />
      <RampBanner />
      <div className="lead">From {s.first} to {s.last} the plant produced <b>{s.energy_mwh.toLocaleString()} MWh</b> over {s.days} days with data
        {s.operator_days > 0 && <> ({s.operator_days} days to {s.operator_last} from the J07 grid-export reports, the rest from the logger)</>}
        (average normal day {s.avg_day_mwh} MWh; highest output {s.peak_mw} MW on {s.peak_day}). The forecast, issued every 5 minutes, misses the next
        15 minutes by <b>{s.mae15} MW</b> on average in testing on weeks it never saw, against {s.persist15} MW for simply repeating the last 15 minutes.
        {liveAcc && liveAcc.n > 0 && <> Live since {liveFrom}: <b>{liveAcc.mae_mw} MW</b> against {liveAcc.persistence_mae_mw} MW ({liveAcc.n} forecasts).</>}</div>
      <div className="sub">LEC Mount Coffee PV plant · 21.17 MWp DC / 17.79 MWac · export limit 16.64 MW · 52 inverters in STS1–STS4 · times are GMT (Liberia time) · energy is inverter-side (logger), about 1.9 % above grid export
        {s.missing.length > 0 && <> · no data {fmtDates(s.missing)}</>}{s.partial.length > 0 && <> · part days {fmtDates(s.partial)}</>}</div>

      <div className="grid kpis">
        <Kpi label="Energy, whole period" value={s.energy_mwh.toLocaleString()} unit="MWh" note={`${s.days} days, ${s.first} to ${s.last}${s.operator_days ? ` · to ${s.operator_last} J07 reports` : ""}`} />
        <Kpi label="Average normal day" value={s.avg_day_mwh} unit="MWh" note={`${s.normal_days} full days; outage and part days excluded`} />
        <Kpi label="Best day" value={s.best_mwh} unit="MWh" note={s.best_day} />
        <Kpi label="Best hour (logger)" value={s.best_hour ? s.best_hour.mwh.toFixed(1) : "—"} unit="MWh" note={s.best_hour ? `${s.best_hour.date} ${String(s.best_hour.h).padStart(2, "0")}:00–${String(s.best_hour.h + 1).padStart(2, "0")}:00 GMT` : ""} />
        <Kpi label="15-min forecast error (MAE)" value={liveAcc?.n ? liveAcc.mae_mw : s.mae15} unit="MW" note={liveAcc?.n ? `live since ${liveFrom}, ${liveAcc.n} forecasts · repeat-last ${liveAcc.persistence_mae_mw} MW · in testing ${s.mae15} MW` : `in testing · repeat-last ${s.persist15} MW`} />
        <Kpi label="Median grid frequency" value={s.median_hz.toFixed(2)} unit="Hz" note="normal band 49.8–50.2 Hz" />
      </div>

      <AskAI />
      <LiveSection live={live} />
      <HourlyPeak />
      <ForecastCheck score={liveScore} />
      <PerformanceSection />
      <WeatherSection live={live} />
      <VerificationSection />
      <DispatchPanel live={live} />
      <HealthSection live={live} />
      <PlantNow live={live} />
      <IrradianceSection live={live} />
      <Replay dates={replayDates} initial={initialReplay} />
      <EnergyHistory rows={energyAll} live={live} />
      <div className="grid two">
        <DailyEnergy daily={daily} />
        <Frequency rows={frequency} />
      </div>
      <div className="grid two">
        <InverterHealth data={inverterHealth} />
      </div>
      <div className="sub" style={{ marginTop: 16 }}>
        Page refreshes live data every minute. Live data from: {live.source === "this PC" || !live.source ? `this PC (${live.liveDir})` : `forecast PC ${live.source}`}.
        {live.servedFrom?.length ? <> Open this dashboard from another PC: {live.servedFrom.join("  ·  ")}</> : null}
      </div>
    </main>
  
    </>
  );
  return <NewLayout {...{ live, s, liveAcc, liveFrom, liveScore, replayDates, initialReplay, energyAll, daily, inverterHealth, frequency, setView }} />;
}
