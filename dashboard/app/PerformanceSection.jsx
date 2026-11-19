"use client";
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";

const tip = { contentStyle: { background: "#171e26", border: "1px solid #263241", fontSize: 12 }, labelStyle: { color: "#e6edf3" } };
const f1 = (v, d = 1) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const PARTS = [
  ["actual", "Produced", "#3fb950"],
  ["plant", "Plant losses (outages, inverters, clipping, curtailment, soiling, other)", "#f85149"],
  ["cloud", "Cloud (weather)", "#4b5a6c"],
];

function Kpi({ label, value, unit, note }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <span style={{ fontSize: 14, color: "#8b98a8" }}> {unit}</span>}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

// Performance ratio, availability and where each day's energy went (forecast/live/kpi.py)
export default function PerformanceSection() {
  const [data, setData] = useState(null);
  const [day, setDay] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch("/api/kpi", { cache: "no-store" }).then((r) => r.json()).then((j) => !stop && setData(j)).catch(() => {});
    load();
    const id = setInterval(load, 300000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  const days = data?.days || [];
  const sel = days.find((d) => d.date === day) || days.at(-1);
  const chart = useMemo(() => days.slice(-30).map((d) => {
    const L = d.losses_mwh || {};
    const plant = Math.max(0, (L.plant_outage || 0) + (L.inverters_down || 0) + (L.clipping || 0) + (L.curtailment || 0) + (L.soiling || 0) + Math.max(0, L.other || 0));
    return { date: d.date.slice(5), full: d.date, actual: d.energy_mwh, plant: +plant.toFixed(2),
      cloud: +Math.max(0, (L.clear_sky || 0) - d.energy_mwh - plant).toFixed(2), part: d.minutes < 1300 };
  }), [days]);
  if (!data) return null;
  const s = data.summary?.last30 || {};
  const L = sel?.losses_mwh || {};
  const rows = [
    ["Clear-sky potential", L.clear_sky], ["− cloud (weather)", L.cloud], ["− clipping at export limit", L.clipping],
    ["− curtailment (power limit)", L.curtailment], ["− plant/grid outage (sunny, plant stopped)", L.plant_outage], ["− inverters down", L.inverters_down], ["− soiling (DustIQ)", L.soiling],
    ["− other (mismatch, sensors, wiring, ageing)", L.other], ["= produced", L.actual],
  ];
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Performance &amp; losses</h2>
          <div className="sub">Performance ratio (PR), availability and where each day&apos;s energy went. Sunlight from the STS3 pyranometer (STS1&apos;s reads low against STS3 and the satellite – see Plant health, Pyranometers; clean or check it). PR uses horizontal sunlight, so compare days with each other rather than with design values.</div>
        </div>
        <select className="btn" value={sel?.date || ""} onChange={(e) => setDay(e.target.value)}>
          {[...days].reverse().map((d) => <option key={d.date} value={d.date}>{d.date}{d.minutes < 1300 ? " (part day)" : ""}</option>)}
        </select>
      </div>
      <div className="grid kpis" style={{ marginBottom: 10 }}>
        <Kpi label={`PR, ${sel?.date ?? ""}`} value={f1(sel?.pr_pct)} unit="%" note={`temperature-corrected ${f1(sel?.pr_temp_pct)} % · 30-day ${f1(s.pr)} %`} />
        <Kpi label="Availability" value={f1(sel?.availability_pct)} unit="%" note={`30-day ${f1(s.availability)} % · inverters that reported`} />
        <Kpi label="Specific yield" value={f1(sel?.specific_yield, 2)} unit="kWh/kWp" note={`30-day average ${f1(s.specific_yield, 2)}`} />
        <Kpi label="Sunlight" value={f1(sel?.insolation_kwh_m2, 2)} unit="kWh/m²" note="horizontal, STS3" />
        <Kpi label="Soiling ratio" value={f1(sel?.soiling_ratio_pct)} unit="%" note="DustIQ, 100 % = clean" />
        <Kpi label="Plant losses, 30 days" value={f1((s.losses?.plant_outage || 0) + (s.losses?.inverters_down || 0) + (s.losses?.clipping || 0) + (s.losses?.curtailment || 0) + (s.losses?.soiling || 0) + Math.max(0, s.losses?.other || 0))} unit="MWh"
             note={`cloud ${f1(s.losses?.cloud, 0)} MWh · produced ${f1(s.losses?.actual, 0)} MWh`} />
      </div>
      <div className="grid two">
        <div>
          <div className="sub" style={{ marginBottom: 4 }}>Last 30 days: produced, plant losses and cloud (MWh). Click a bar for its breakdown.</div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chart} margin={{ top: 6, right: 8, left: -8, bottom: 0 }} onClick={(e) => e?.activePayload && setDay(e.activePayload[0].payload.full)}>
              <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: "#8b949e", fontSize: 10 }} interval={2} />
              <YAxis tick={{ fill: "#8b949e", fontSize: 11 }} unit="" width={40} />
              <Tooltip {...tip} formatter={(v, n) => [`${f1(v)} MWh`, n]} labelFormatter={(l, p) => (p?.[0]?.payload?.part ? `${l} (part day)` : l)} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {PARTS.map(([k, n, c]) => <Bar key={k} dataKey={k} name={n} stackId="a" fill={c} isAnimationActive={false} cursor="pointer" />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div>
          <div className="sub" style={{ marginBottom: 4 }}>{sel?.date}: from clear-sky potential down to what the plant produced</div>
          <table className="tbl">
            <tbody>
              {rows.map(([n, v]) => (
                <tr key={n} className={n.startsWith("=") || n.startsWith("Clear") ? "strong" : ""}>
                  <td>{n}</td><td style={{ textAlign: "right" }}>{f1(n.startsWith("−") ? v : v, 2)} MWh</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sel?.weakest_inverters?.length > 0 && <div className="sub" style={{ marginTop: 8 }}>Lowest availability: {sel.weakest_inverters.map((w) => `${w.inverter} ${w.availability_pct} %`).join(" · ")}</div>}
          {sel && sel.curtailed_minutes > 0 && <div className="warn-text" style={{ marginTop: 6 }}>Power limit below 100 % for {sel.curtailed_minutes} minutes.</div>}
          {sel && sel.outage_minutes > 0 && <div className="bad-text" style={{ marginTop: 6 }}>Plant stopped in daylight for {sel.outage_minutes} minutes.</div>}
          <div className="sub" style={{ marginTop: 8 }}>&ldquo;Other&rdquo; includes wiring and module losses and the difference between one sunlight sensor and a 20 MW field under broken cloud; it can be negative when the plant beat the model.</div>
        </div>
      </div>
    </section>
  );
}
