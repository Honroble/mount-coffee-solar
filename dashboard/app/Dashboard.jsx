"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, ReferenceArea,
} from "recharts";

const C = { actual: "#e6edf3", f15: "#f5a524", f60: "#3fb6c9", cs: "#6b7a8c", good: "#3fb950", bad: "#f85149" };
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const hhmm = (iso) => (iso ? iso.slice(11, 16) : "");
const ageMin = (iso, now) => (iso ? Math.round((new Date(now) - new Date(iso)) / 60000) : null);
const axis = { stroke: "#8b98a8", fontSize: 11 };
const grid = <CartesianGrid stroke="#263241" strokeDasharray="3 3" />;
const tip = { contentStyle: { background: "#171e26", border: "1px solid #263241", fontSize: 12 }, labelStyle: { color: "#e6edf3" } };

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
        if (r.ok && !stop) setLive(await r.json());
      } catch { /* keep the last snapshot */ }
    };
    const id = setInterval(tick, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  return live;
}

function LiveSection({ live }) {
  const f = live.latestForecast;
  const fAge = ageMin(f?.issued, live.now);
  const cAge = ageMin(live.collector.lastPlant, live.now);
  const state = !live.liveDirExists || cAge === null ? "off" : cAge > 20 ? "stale" : "ok";
  const stateText = {
    off: "No live data yet – the collector has not saved any readings",
    stale: `Collector last saved data ${cAge} min ago`,
    ok: `Collector OK · last reading ${hhmm(live.collector.lastPlant)} UTC`,
  }[state];

  // Today's chart: actual 5-min output, and each forecast placed at the time it was forecasting for
  const series = useMemo(() => {
    const m = new Map();
    const put = (t, k, v) => { const o = m.get(t) || { t }; o[k] = v; m.set(t, o); };
    for (const a of live.actual) put(a.t, "actual", a.mw);
    for (const fc of live.forecasts) {
      const t0 = new Date(fc.issued).getTime();
      const at = (min) => new Date(Math.round((t0 + min * 60000) / 300000) * 300000).toISOString();
      if (fc.p15 !== null) put(at(15), "f15", fc.p15);
      if (fc.p60 !== null) put(at(60), "f60", fc.p60);
      if (fc.cs15 !== null) put(at(15), "cs", fc.cs15);
    }
    const from = live.now.slice(0, 10) + "T05:30:00.000Z";   // today's daylight only
    return [...m.values()].filter((p) => p.t >= from).sort((a, b) => (a.t < b.t ? -1 : 1));
  }, [live]);

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Live forecast</h2>
          <div className="sub">Issued every 15 minutes by the forecast PC from the logger (read-only), the weather station and satellite data.</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="status"><span className={`dot ${state}`} />{stateText}</span>
          {f && <div className="sub" style={{ marginTop: 4 }}>Last forecast {hhmm(f.issued)} UTC ({fAge} min ago) · model: {f.model === "satellite" ? "plant + weather + satellite" : f.model === "weather" ? "plant + weather station" : f.model}</div>}
        </div>
      </div>

      {f && f.status && f.status !== "ok" && <div className="warn-text" style={{ marginBottom: 8 }}>Forecast status: {f.status}</div>}

      <div className="grid big">
        <Kpi label="Output now (last 15 min)" value={fmt(f?.p_now ?? live.plant?.p_mw)} unit="MW"
             note={f?.inverters_online != null ? `${f.inverters_online} of 52 inverters online` : live.plant ? `${live.inverters.filter((i) => i.online).length} of 52 inverters producing` : ""} />
        <Kpi label="In 15 minutes" value={fmt(f?.p15)} unit="MW" note={f ? `clear sky ${fmt(f.cs15, 1)} MW` : ""} />
        <Kpi label="In 30 minutes" value={fmt(f?.p30)} unit="MW" note={f ? `clear sky ${fmt(f.cs30, 1)} MW` : ""} />
        <Kpi label="In 60 minutes" value={fmt(f?.p60)} unit="MW" note={f ? `clear sky ${fmt(f.cs60, 1)} MW` : ""} />
      </div>

      <Legend items={[["Actual (5-min average)", C.actual], ["Forecast made 15 min earlier", C.f15], ["Forecast made 60 min earlier", C.f60], ["Clear-sky maximum", C.cs, true]]} />
      {series.length ? (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={series} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            {grid}
            <XAxis dataKey="t" tickFormatter={hhmm} {...axis} minTickGap={40} />
            <YAxis {...axis} unit=" MW" width={62} domain={[0, 18]} />
            <Tooltip {...tip} labelFormatter={(t) => `${hhmm(t)} UTC`} formatter={(v) => `${fmt(v)} MW`} />
            <Line dataKey="cs" name="Clear sky" stroke={C.cs} strokeDasharray="5 4" dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="actual" name="Actual" stroke={C.actual} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="f15" name="Forecast 15 min" stroke={C.f15} dot={false} connectNulls isAnimationActive={false} />
            <Line dataKey="f60" name="Forecast 60 min" stroke={C.f60} dot={false} connectNulls isAnimationActive={false} />
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
          {live.plant && <div className="sub">{hhmm(live.plant.time)} UTC · {fmt(live.plant.p_mw)} MW · {fmt(live.plant.freq_hz, 2)} Hz</div>}
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
          {w && <div className="sub">{hhmm(w.time)} UTC</div>}
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
          <Tooltip {...tip} labelFormatter={(t) => `${hhmm(t)} UTC`} formatter={(v) => `${fmt(v)} MW`} />
          <Line dataKey="clearsky_mw" name="Clear sky" stroke={C.cs} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          <Line dataKey="actual_mw" name="Actual" stroke={C.actual} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="forecast15_mw" name="Forecast 15 min" stroke={C.f15} dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="forecast60_mw" name="Forecast 60 min" stroke={C.f60} dot={false} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
}

function DailyEnergy({ daily }) {
  return (
    <section className="panel">
      <h2>Daily energy</h2>
      <div className="sub">MWh per day against the clear-sky maximum. Red bars are outage or missing-data days.</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={daily} margin={{ top: 12, right: 12, left: 0, bottom: 0 }} barGap={-12}>
          {grid}
          <XAxis dataKey="date" tickFormatter={(d) => d.slice(5)} {...axis} minTickGap={20} />
          <YAxis {...axis} width={50} />
          <Tooltip {...tip} formatter={(v, n) => [`${fmt(v, 1)} MWh`, n]} />
          <Bar dataKey="clearsky_mwh" name="Clear-sky maximum" fill="#263241" isAnimationActive={false} barSize={12} />
          <Bar dataKey="energy_mwh" name="Produced" isAnimationActive={false} barSize={12}
               shape={(p) => <rect x={p.x} y={p.y} width={p.width} height={p.height} fill={p.payload.status === "Normal" ? C.f15 : C.bad} rx={2} />} />
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}

function Accuracy({ rows }) {
  return (
    <section className="panel">
      <h2>Forecast accuracy by horizon</h2>
      <div className="sub">Mean absolute error in MW (lower is better), blocked cross-validation over two-week folds.</div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Horizon</th><th className="num">Persistence</th><th className="num">Plant only</th><th className="num">+ Weather station</th><th className="num">+ Satellite</th><th className="num">Better than persistence</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.horizon}><td>{r.horizon}</td><td className="num">{fmt(r.persistence_mae_mw)}</td><td className="num">{fmt(r.plant_only_mae_mw)}</td>
              <td className="num">{fmt(r.with_weather_mae_mw)}</td><td className="num"><b>{fmt(r.with_satellite_mae_mw)}</b></td>
              <td className="num">{fmt(100 * (1 - r.with_satellite_mae_mw / r.persistence_mae_mw), 0)} %</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function InverterHealth({ rows }) {
  return (
    <section className="panel">
      <h2>Inverter health (17 Sep – 13 Nov)</h2>
      <div className="sub">Strong-sun minutes (09:00–15:00 UTC, plant above 5 MW). Output relative to the median inverter.</div>
      <div className="scroll" style={{ marginTop: 8 }}>
        <table>
          <thead><tr><th>Inverter</th><th className="num">Relative output</th><th className="num">Dropouts</th><th className="num">Alarm minutes</th><th className="num">Main alarm code</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.inverter}>
                <td>{r.inverter}</td>
                <td className={`num ${r.relative_output_pct < 95 ? "warn-text" : ""}`}>{fmt(r.relative_output_pct, 1)} %</td>
                <td className={`num ${r.dropout_pct > 1 ? "bad-text" : ""}`}>{fmt(r.dropout_pct, 2)} %</td>
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

export default function Dashboard({ summary: s, daily, accuracy, inverterHealth, frequency, replayDates, initialReplay, initialLive }) {
  const live = useLive(initialLive);
  return (
    <main>
      <h1>Mount Coffee Solar – Forecast &amp; Plant Health</h1>
      <div className="lead">Over {s.days} days of logger data the plant produced <b>{s.energy_mwh.toLocaleString()} MWh</b>. The 15-minute-ahead forecast misses by <b>{s.mae15} MW</b> on average, against {s.persist15} MW for simply repeating the last 15 minutes.</div>
      <div className="sub">LEC Mount Coffee PV plant · 20 MW DC / 16.64 MW AC · 52 inverters in STS1–STS4 · times are UTC (= Monrovia time) · history {s.first} to {s.last}</div>

      <div className="grid kpis">
        <Kpi label="Energy, whole period" value={s.energy_mwh.toLocaleString()} unit="MWh" />
        <Kpi label="Average normal day" value={s.avg_day_mwh} unit="MWh" note="outage days excluded" />
        <Kpi label="Best day" value={s.best_mwh} unit="MWh" note={s.best_day} />
        <Kpi label="15-min forecast error (MAE)" value={s.mae15} unit="MW" note={`persistence ${s.persist15} MW`} />
        <Kpi label="Median grid frequency" value={s.median_hz.toFixed(2)} unit="Hz" note="normal band 49.8–50.2 Hz" />
      </div>

      <LiveSection live={live} />
      <PlantNow live={live} />
      <Replay dates={replayDates} initial={initialReplay} />
      <div className="grid two">
        <DailyEnergy daily={daily} />
        <Frequency rows={frequency} />
      </div>
      <div className="grid two">
        <Accuracy rows={accuracy} />
        <InverterHealth rows={inverterHealth} />
      </div>
      <div className="sub" style={{ marginTop: 16 }}>Page refreshes live data every minute. Live files: {live.liveDir}</div>
    </main>
  );
}
