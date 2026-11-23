"use client";
// Grid & reports tab: daily and monthly export from P01 + P04 (P07 under-reads until repaired), KPIs and CSV download.
import { useEffect, useState } from "react";

const f = (v, d = 1) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));

function Kpi({ label, value, unit, note }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <span style={{ fontSize: 14, color: "#8b98a8" }}> {unit}</span>}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export default function GridReports() {
  const [g, setG] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch("/api/grid/report", { cache: "no-store" }).then((r) => r.json()).then((j) => !stop && setG(j)).catch(() => {});
    load();
    const id = setInterval(load, 300000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  if (!g) return <section className="panel"><h2>Grid &amp; reports</h2><div className="empty">Loading…</div></section>;
  const today = g.days.find((d) => d.partial) || g.days[0];
  const full = g.days.filter((d) => !d.partial);
  return (
    <>
      <div className={`alert ${g.p07.state === "fixed" ? "reserve" : ""}`} style={{ marginBottom: 10 }}>
        <b>Export source: {g.source}.</b> {g.p07.text}
      </div>
      {today && (
        <div className="grid kpis">
          <Kpi label={`Export ${today.partial ? "today so far" : today.date}`} value={f(today.export_mwh, 1)} unit="MWh" note={`Peak ${f(today.peak_mw, 1)} MW at ${today.peak_at || "—"} GMT`} />
          <Kpi label="Capacity factor" value={f(today.capacity_factor_pct, 1)} unit="%" note={`of ${17.79} MWac over 24 h`} />
          <Kpi label="Specific yield" value={f(today.specific_yield, 2)} unit="kWh/kWp" note="of 21.17 MWp DC" />
          <Kpi label="Operating hours" value={f(today.operating_h, 1)} unit="h" note="export above 0.1 MW" />
          <Kpi label="Grid frequency" value={`${f(today.f_min, 2)}–${f(today.f_max, 2)}`} unit="Hz" note="day range at P07" />
          <Kpi label="Grid voltage (VAB)" value={`${f(today.v_min_kv, 1)}–${f(today.v_max_kv, 1)}`} unit="kV" note={`${today.trips} trips · breakers open ${today.breaker_open_min} min in daylight`} />
        </div>
      )}
      <section className="panel">
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2>Daily grid report</h2>
          <a className="btn" href="/api/grid/report?format=csv" download>Download CSV</a>
        </div>
        <div className="sub">{g.note} Days with under 95 % of daylight minutes recorded (PC off) are marked and read low.</div>
        <div className="scroll" style={{ marginTop: 8, maxHeight: "none" }}>
          <table>
            <thead><tr><th>Date</th><th className="num">Export (MWh)</th><th className="num">J07 report (MWh)</th><th className="num">Peak (MW)</th>
              <th className="num">CF (%)</th><th className="num">Yield (kWh/kWp)</th><th className="num">Op. hours</th><th className="num">Q (Mvarh)</th>
              <th className="num">P07 ÷ P01+P04</th><th className="num">f range (Hz)</th><th className="num">Trips</th><th className="num">Data (%)</th></tr></thead>
            <tbody>
              {g.days.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}{d.partial ? " (today)" : ""}</td>
                  <td className="num">{f(d.export_mwh, 1)}</td>
                  <td className="num">{f(d.j07_mwh, 1)}</td>
                  <td className="num">{f(d.peak_mw, 1)}</td>
                  <td className="num">{f(d.capacity_factor_pct, 1)}</td>
                  <td className="num">{f(d.specific_yield, 2)}</td>
                  <td className="num">{f(d.operating_h, 1)}</td>
                  <td className="num">{f(d.reactive_mvarh, 1)}</td>
                  <td className={`num ${d.p07_ratio !== null && Math.abs(d.p07_ratio - 1) > 0.03 ? "warn-text" : ""}`}>{f(d.p07_ratio, 2)}</td>
                  <td className="num">{d.f_min === null ? "—" : `${f(d.f_min, 2)}–${f(d.f_max, 2)}`}</td>
                  <td className={`num ${d.trips > 0 ? "bad-text" : ""}`}>{d.trips}</td>
                  <td className={`num ${!d.partial && d.coverage_pct < 95 ? "warn-text" : ""}`}>{f(d.coverage_pct, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {full.length === 0 && <div className="sub" style={{ marginTop: 6 }}>Feeder data started on 22 Nov 2026 at 15:45 GMT, so the first full day is 23 Nov.</div>}
      </section>
      <section className="panel">
        <h2>Monthly</h2>
        <table>
          <thead><tr><th>Month</th><th className="num">Days</th><th className="num">Export (MWh)</th><th className="num">Peak (MW)</th><th className="num">Trips</th><th className="num">Days with gaps</th></tr></thead>
          <tbody>
            {g.months.map((m) => (
              <tr key={m.month}><td>{m.month}</td><td className="num">{m.days}</td><td className="num">{f(m.export_mwh, 1)}</td><td className="num">{f(m.peak_mw, 1)}</td>
                <td className="num">{m.trips}</td><td className={`num ${m.low_coverage_days ? "warn-text" : ""}`}>{m.low_coverage_days}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="sub" style={{ marginTop: 6 }}>Only months since feeder collection began. Earlier months are in History (J07 reports and logger PV-Sum).</div>
      </section>
    </>
  );
}
