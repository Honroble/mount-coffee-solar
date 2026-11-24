"use client";
// Finance tab: the plant's measured energy losses expressed in US dollars at a price per kWh the user chooses.
// Uses the same daily figures as Grid & reports (/api/grid/report). All losses are estimates.
import { useEffect, useState } from "react";

const PRESETS = [
  ["LEC residential tariff 2026 (US$0.22/kWh)", 0.22],
  ["LEC social tariff 2026 (US$0.13/kWh)", 0.13],
  ["Old residential tariff 2022-25 (US$0.24/kWh)", 0.24],
];
const CAUSES = [
  ["trip_lost_mwh_est", "Grid trips (frequency events)", "NLDC: grid frequency; contractor: shorter reconnection delay"],
  ["fault_lost_mwh_est", "Inverter alarms (mostly morning insulation)", "Contractor: insulation tests, trip threshold"],
  ["string_lost_mwh_est", "Dead DC strings (if faults)", "Contractor: fuses, connectors, DC isolators"],
  ["curtailed_mwh_est", "Export limit (curtailment)", "Dispatch: 16.64 MW limit at midday"],
];
const usd = (x) => (x == null || !Number.isFinite(x) ? "—" : `$${Math.round(x).toLocaleString()}`);
const mwh = (x) => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(1));

function Card({ label, value, note }) {
  return <div className="kpi"><div className="label">{label}</div><div className="value">{value}</div>{note && <div className="note">{note}</div>}</div>;
}

export default function Finance() {
  const [g, setG] = useState(null);
  const [price, setPrice] = useState(0.22);
  useEffect(() => {
    try { const v = Number(localStorage.getItem("mcsolar-price")); if (v > 0 && v < 5) setPrice(v); } catch { /* storage off */ }
    fetch("/api/grid/report", { cache: "no-store" }).then((r) => r.json()).then(setG).catch(() => {});
  }, []);
  const setP = (v) => { const x = Number(v); if (x >= 0 && x < 5) { setPrice(x); try { localStorage.setItem("mcsolar-price", String(x)); } catch { /* storage off */ } } };
  if (!g) return <section className="panel"><h2>Finance</h2><div className="empty">Loading…</div></section>;

  const k = price * 1000;                                       // US$ per MWh
  const tracked = g.days.filter((d) => d.fault_lost_mwh_est != null);   // days with inverter alarm data
  const full = tracked.filter((d) => !d.partial);
  const today = g.days[0];
  const month = today?.date.slice(0, 7);
  const sum = (ds, key) => ds.reduce((a, d) => a + (Number(d[key]) || 0), 0);
  const lostOf = (ds) => CAUSES.reduce((a, [c]) => a + sum(ds, c), 0);
  const periods = [
    [today?.partial ? "Today so far" : today?.date, [today].filter(Boolean)],
    ["Last 7 days", g.days.slice(0, 7)],
    [`${month} so far`, g.days.filter((d) => d.date.startsWith(month))],
  ];
  const perDay = (c) => (full.length ? sum(full, c) / full.length : null);
  const yearOf = (c) => (perDay(c) == null ? null : perDay(c) * 365);
  const yearLost = full.length ? CAUSES.reduce((a, [c]) => a + yearOf(c), 0) : null;
  const prodPerDay = full.length ? sum(full, "inverter_mwh") / full.length : null;
  const trips = g.trips || [];

  return (
    <>
      <section className="panel">
        <h2>Lost energy in dollars</h2>
        <div className="sub">The plant's estimated energy losses (from Grid &amp; reports) multiplied by a price per kWh. Choose the price that fits the question: the LEC customer tariff shows revenue that could have been billed; the cost of the generation that replaces the lost solar (for example thermal or imported power) shows the extra cost to LEC. Losses are measured at the plant; network losses before customers are not deducted.</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "10px 0" }}>
          <span className="sub">Price:</span>
          {PRESETS.map(([label, v]) => (
            <button key={label} className="btn" style={Math.abs(price - v) < 1e-9 ? { borderColor: "#f0c000", color: "#f0c000" } : undefined} onClick={() => setP(v)}>{label}</button>
          ))}
          <label className="sub" style={{ display: "flex", gap: 6, alignItems: "center" }}>Custom US$/kWh
            <input type="number" step="0.01" min="0" max="5" value={price} onChange={(e) => setP(e.target.value)}
              style={{ width: 80, background: "#0d1117", color: "inherit", border: "1px solid #30363d", borderRadius: 4, padding: "3px 6px" }} />
          </label>
          <span className="sub">= US${Math.round(k).toLocaleString()} per MWh</span>
        </div>
        <div className="grid kpis">
          {periods.map(([name, ds]) => (
            <Card key={name} label={`Lost ${name}`} value={usd(lostOf(ds) * k)} note={`${mwh(lostOf(ds))} MWh · produced ${usd(sum(ds, "inverter_mwh") * k)}`} />
          ))}
          <Card label="Lost per year at this rate" value={usd(yearLost == null ? null : yearLost * k)}
            note={full.length ? `${mwh(yearLost)} MWh/yr, from ${full.length} full day${full.length === 1 ? "" : "s"} of data` : "needs one full day of data"} />
        </div>
      </section>

      <section className="panel">
        <h2>By cause</h2>
        <div className="sub">Yearly figures repeat the average of the full days tracked so far ({full.length} day{full.length === 1 ? "" : "s"} since 23 Nov 2026), so they are rough until a few weeks of data have built up; trips in particular vary a lot from day to day.</div>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Cause</th><th className="num">Today (MWh)</th><th className="num">Today</th><th className="num">Last 7 days</th><th className="num">Month so far</th><th className="num">Per year (est.)</th><th>Who can fix it</th></tr></thead>
          <tbody>
            {CAUSES.map(([c, label, who]) => (
              <tr key={c}><td>{label}</td><td className="num">{mwh(Number(today?.[c]) || 0)}</td><td className="num">{usd((Number(today?.[c]) || 0) * k)}</td>
                <td className="num">{usd(sum(periods[1][1], c) * k)}</td><td className="num">{usd(sum(periods[2][1], c) * k)}</td>
                <td className="num"><b>{usd(yearOf(c) == null ? null : yearOf(c) * k)}</b></td><td className="sub">{who}</td></tr>
            ))}
            <tr><td><b>Total</b></td><td className="num"><b>{mwh(lostOf([today].filter(Boolean)))}</b></td><td className="num"><b>{usd(lostOf([today].filter(Boolean)) * k)}</b></td>
              <td className="num"><b>{usd(lostOf(periods[1][1]) * k)}</b></td><td className="num"><b>{usd(lostOf(periods[2][1]) * k)}</b></td>
              <td className="num"><b>{usd(yearLost == null ? null : yearLost * k)}</b></td><td /></tr>
          </tbody>
        </table>
        {prodPerDay != null && yearLost != null ? (
          <div className="sub" style={{ marginTop: 6 }}>For scale: the plant produced about {usd(prodPerDay * 365 * k)} a year of energy at this price ({mwh(prodPerDay)} MWh a day on the tracked days); the losses above are {((yearLost / (prodPerDay * 365 + yearLost)) * 100).toFixed(1)} % of what it could have made. The P07 meter fault loses no energy (it only under-reports), so it has no dollar value here.</div>
        ) : null}
      </section>

      <section className="panel">
        <h2>Cost of each trip</h2>
        {!trips.length ? <div className="empty">No trips recorded.</div> : (
          <>
            <table>
              <thead><tr><th>Trip (GMT)</th><th className="num">Out (min)</th><th>Scope</th><th>Cause</th><th className="num">Lost (MWh est.)</th><th className="num">Cost</th></tr></thead>
              <tbody>{trips.map((t) => (
                <tr key={t.trip_utc + t.scope}><td style={{ whiteSpace: "nowrap" }}>{t.trip_utc}</td><td className="num">{t.duration_min || "—"}</td>
                  <td>{t.scope === "plant" ? "whole plant" : t.scope}</td><td>{t.cause}</td><td className="num">{t.energy_lost_mwh_est}</td>
                  <td className="num">{usd((Number(t.energy_lost_mwh_est) || 0) * k)}</td></tr>
              ))}</tbody>
            </table>
            <div className="sub" style={{ marginTop: 6 }}>Total {trips.length} trips: {usd(trips.reduce((a, t) => a + (Number(t.energy_lost_mwh_est) || 0), 0) * k)}. A trip costs more the sunnier it is when it happens.</div>
          </>
        )}
      </section>
    </>
  );
}
