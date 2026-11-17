"use client";
import { useMemo, useState } from "react";
import { ResponsiveContainer, ComposedChart, Area, Line, Scatter, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";

const C = { actual: "#e6edf3", newF: "#f5a524", band: "#f5a524", old: "#8b98a8", now: "#3fb6c9", warn: "#d29922", bad: "#f85149" };
const MODEL_COLORS = ["#7aa2f7", "#bb9af7", "#9ece6a", "#e0af68", "#7dcfff", "#f7768e"];
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const ms = (iso) => new Date(iso).getTime();
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const dayName = (date, today) => {
  const d = Math.round((ms(date + "T00:00:00Z") - ms(today + "T00:00:00Z")) / 86400000);
  return d === 0 ? "Today" : d === 1 ? "Tomorrow" : d === -1 ? "Yesterday" : new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
};
const axis = { stroke: "#8b98a8", fontSize: 11 };
const tip = { contentStyle: { background: "#171e26", border: "1px solid #263241", fontSize: 12 }, labelStyle: { color: "#e6edf3" } };

function DayCard({ d, today, actual, selected, onClick }) {
  return (
    <button className={`kpi daycard ${selected ? "sel" : ""}`} onClick={onClick}>
      <div className="label">{dayName(d.date, today)} · {d.date.slice(5)}</div>
      <div className="value">{fmt(d.newMwh, 0)}<span style={{ fontSize: 14, color: "#8b98a8" }}> MWh</span></div>
      <div className="note">range {fmt(d.lowMwh, 0)}–{fmt(d.highMwh, 0)} · single model {fmt(d.oldMwh, 0)}</div>
      {actual && <div className="note">actual {d.date === today ? "so far " : ""}<b style={{ color: "#e6edf3" }}>{fmt(actual.mwh, 1)} MWh</b></div>}
    </button>
  );
}

export default function WeatherSection({ live }) {
  const nwp = live.nwp;
  const fc = nwp?.forecast;
  const today = live.now.slice(0, 10);
  const [day, setDay] = useState(today);
  const [showModels, setShowModels] = useState(false);

  const view = useMemo(() => {
    if (!fc) return null;
    const from = ms(day + "T05:00:00Z"), to = ms(day + "T19:30:00Z");
    const inDay = (t) => t >= from && t <= to;
    const hourly = fc.hourly.filter((h) => inDay(ms(h.t))).map((h) => ({ x: ms(h.t), ...h, band: [h.low, h.high], ...h.models }));
    const quarter = fc.quarter.filter((q) => inDay(ms(q.t))).map((q) => ({ x: ms(q.t), old: q.old }));
    const actual = day === today ? live.actual.filter((a) => inDay(ms(a.t))).map((a) => ({ x: ms(a.t), mw: a.mw })) : [];
    const f = live.latestForecast;
    const nowcast = day === today && f ? [15, 30, 60].map((m) => ({ x: ms(f.issued) + m * 60000, mw: f[`p${m}`] })).filter((p) => p.mw !== null) : [];
    const best = day === today && live.blend?.points ? live.blend.points.filter((p) => inDay(ms(p.t))).map((p) => ({ x: ms(p.t), best: p.mw })) : [];
    return { hourly, quarter, actual, nowcast, best, from, to };
  }, [fc, day, today, live]);

  if (!fc) {
    return (
      <section className="panel">
        <h2>Today and the next 2 days (weather models)</h2>
        <div className="empty">No weather-model forecast yet. It is made every hour by the "MCSolar Weather Models" task on the forecast PC
          (run <code>live\install_live_tasks.ps1</code> again to add it).{nwp?.error ? ` Error: ${nwp.error}` : ""}</div>
      </section>
    );
  }

  const actualsByDate = Object.fromEntries((nwp.recentActuals || []).map((a) => [a.date, a]));
  const models = fc.modelsUsed || [];
  const alerts = (fc.alerts || []).filter((a) => a.time.slice(0, 10) === day || (a.kind === "ramp" && a.time.slice(0, 10) >= today));
  const s = nwp.score;

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Today and the next 2 days (weather models)</h2>
          <div className="sub">Hourly forecast from the average of {models.length} weather models with dust (AOD) correction, and the single-model 15-minute forecast.
            Issued {hhmm(fc.issued)} GMT ({fc.ageMin} min ago), refreshed every hour.
            {fc.calibration ? ` Calibrated hour by hour on the logger (${fc.calibration.period[0]} – ${fc.calibration.period[1]}): out-of-sample error ${fc.calibration.mae.calibrated} MW vs ${fc.calibration.mae.harris_daily_factors} MW before.` : " Using the daily-energy calibration until the hourly calibration has run."}</div>
        </div>
        <label className="sub" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={showModels} onChange={(e) => setShowModels(e.target.checked)} /> show the {models.length} models
        </label>
      </div>

      <div className="grid daycards">
        {fc.days.filter((d) => d.date >= today).slice(0, 3).map((d) => (
          <DayCard key={d.date} d={d} today={today} actual={actualsByDate[d.date]} selected={d.date === day} onClick={() => setDay(d.date)} />
        ))}
      </div>

      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a, i) => (
            <div key={i} className={`alert ${a.kind}`}><b>{a.kind === "ramp" ? "Ramp" : a.kind === "split" ? "Models disagree" : "Reserve"}:</b> {a.text}</div>
          ))}
        </div>
      )}

      {live.blend?.points?.length > 0 && (
        <div className="grid sixh">
          {[60, 120, 180, 240, 300, 360].map((m) => {
            const p = live.blend.points.find((x) => Math.round((ms(x.t) - ms(live.blend.issued)) / 60000) === m);
            return p ? (
              <div className="kpi" key={m}><div className="label">+{m / 60} h · {hhmm(ms(p.t))}</div><div className="value" style={{ fontSize: 22 }}>{fmt(p.mw)}<span style={{ fontSize: 12, color: "#8b98a8" }}> MW</span></div><div className="note">{p.src}</div></div>
            ) : null;
          })}
        </div>
      )}
      <div className="legend">
        <span><i style={{ background: C.newF }} />Forecast, average of models (hourly)</span>
        <span><i style={{ background: "rgba(245,165,36,.25)", height: 8 }} />Likely range</span>
        <span><i style={{ borderTop: `2px dashed ${C.old}` }} />Single model (15 min)</span>
        {day === today && <span><i style={{ background: C.actual }} />Actual (5 min)</span>}
        {day === today && <span><i style={{ background: C.now, height: 8, width: 8, borderRadius: 4 }} />Plant-data forecast +15/30/60 min</span>}
        {day === today && view.best.length > 0 && <span><i style={{ background: "#3fb950" }} />Best estimate, next 6 h (plant data, handing over to the models)</span>}
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" scale="time" domain={[view.from, view.to]} tickFormatter={hhmm} {...axis}
                 ticks={Array.from({ length: 15 }, (_, i) => view.from + i * 3600000)} allowDuplicatedCategory={false} />
          <YAxis {...axis} unit=" MW" width={62} domain={[0, 18]} />
          <Tooltip {...tip} labelFormatter={(t) => `${hhmm(t)} GMT`} formatter={(v, n) => [Array.isArray(v) ? `${fmt(v[0])}–${fmt(v[1])} MW` : `${fmt(v, 2)} MW`, n]} />
          <ReferenceLine y={16.64} stroke="#3a4757" strokeDasharray="2 4" label={{ value: "export limit 16.64 MW", fill: "#6b7a8c", fontSize: 10, position: "insideTopRight" }} />
          {day === today && <ReferenceLine x={ms(live.now)} stroke="#3fb6c9" strokeOpacity={0.5} />}
          <Area data={view.hourly} dataKey="band" name="Likely range" stroke="none" fill={C.band} fillOpacity={0.18} isAnimationActive={false} />
          <Line data={view.quarter} dataKey="old" name="Single model" stroke={C.old} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          {showModels && models.map((m, i) => (
            <Line key={m} data={view.hourly} dataKey={m} name={m} stroke={MODEL_COLORS[i % 6]} strokeWidth={1} dot={false} isAnimationActive={false} />
          ))}
          <Line data={view.hourly} dataKey="new" name="Forecast (average)" stroke={C.newF} strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} />
          {view.actual.length > 0 && <Line data={view.actual} dataKey="mw" name="Actual" stroke={C.actual} strokeWidth={2} dot={false} isAnimationActive={false} />}
          {view.best.length > 0 && <Line data={view.best} dataKey="best" name="Best estimate (blend)" stroke="#3fb950" strokeWidth={2.5} strokeDasharray="1 0" dot={false} isAnimationActive={false} />}
          {view.nowcast.length > 0 && <Scatter data={view.nowcast} dataKey="mw" name="Plant-data forecast" fill={C.now} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>

      <h3 style={{ margin: "16px 0 4px", fontSize: 14 }}>Scorecard: forecast vs actual daily energy</h3>
      <div className="sub">
        Actual = logger energy at the inverters (about 1.9 % above the J07 grid export). Day-ahead = last forecast issued before the day.
        {s.days ? <> Average miss over {s.days} days: day-ahead {fmt(s.maeDayAheadNew)} MWh (single model {fmt(s.maeDayAheadOld)}), same-day {fmt(s.maeSameDayNew)} MWh.</> : " The scorecard fills in from tomorrow, once a full day has a day-ahead forecast."}
      </div>
      {s.rows.length > 0 && (
        <div className="scroll" style={{ marginTop: 8, maxHeight: 260 }}>
          <table>
            <thead><tr><th>Date</th><th className="num">Actual</th><th className="num">Day-ahead</th><th className="num">Range</th><th className="num">Miss</th><th className="num">Single model</th><th className="num">Same-day</th></tr></thead>
            <tbody>
              {s.rows.map((r) => {
                const miss = r.dayAheadNew === null ? null : r.dayAheadNew - r.actual;
                const out = r.dayAheadLow !== null && (r.actual < r.dayAheadLow || r.actual > r.dayAheadHigh);
                return (
                  <tr key={r.date}>
                    <td>{r.date}</td><td className="num">{fmt(r.actual)}</td><td className="num">{fmt(r.dayAheadNew)}</td>
                    <td className={`num ${out ? "warn-text" : ""}`}>{r.dayAheadLow === null ? "—" : `${fmt(r.dayAheadLow, 0)}–${fmt(r.dayAheadHigh, 0)}`}</td>
                    <td className={`num ${miss !== null && Math.abs(miss) > 20 ? "bad-text" : ""}`}>{miss === null ? "—" : (miss > 0 ? "+" : "") + fmt(miss)}</td>
                    <td className="num">{fmt(r.dayAheadOld)}</td><td className="num">{fmt(r.sameDayNew)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="sub" style={{ marginTop: 8 }}>{fc.credit}</div>
    </section>
  );
}
