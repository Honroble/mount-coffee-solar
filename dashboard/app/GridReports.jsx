"use client";
// Grid & reports tab: daily and monthly export from P01 + P04 (P07 under-reads until repaired), KPIs and CSV download.
import { useEffect, useState } from "react";

const KIND_BG = { ok: "#1f6f3f", idle: "#3a4656", warn: "#8a6d12", bad: "#8b2b2b", off: "#2a313c" };

function Alarms({ days }) {
  const d = days.find((x) => x.inverters);
  if (!d) return null;
  const inv = Object.entries(d.inverters);
  const stations = [...new Set(inv.map(([k]) => k.split(".")[0]))];
  const lowIso = inv.filter(([, v]) => v.iso_min_kohm !== null && v.iso_min_kohm < 100).sort((a, b) => a[1].iso_min_kohm - b[1].iso_min_kohm);
  const t = inv.find(([, v]) => v.time)?.[1].time;
  return (
    <section className="panel">
      <h2>Inverter alarms and states</h2>
      <div className="sub">Alarm codes and operating states as the inverters report them, {d.date}{d.partial ? " so far" : ""}. Code meanings follow Sungrow's published lists (confirm the inverter make). Energy lost is an estimate: inverter-minutes stopped by an alarm or fault in daylight, at that day's typical output per unit irradiance.</div>
      <div className="grid two" style={{ marginTop: 8 }}>
        <div>
          {d.alarms?.length ? (
            <table>
              <thead><tr><th>Alarm</th><th className="num">Inverters</th><th>From–to (GMT)</th><th className="num">Inverter-min</th></tr></thead>
              <tbody>{d.alarms.map((a) => (
                <tr key={a.code}><td className="warn-text">{a.name} <span style={{ color: "#8b98a8" }}>({a.code})</span></td><td className="num" title={a.inverters.join(", ")}>{a.inverters.length}</td>
                  <td>{a.from}–{a.to}</td><td className="num">{a.minutes}</td></tr>
              ))}</tbody>
            </table>
          ) : <div className="empty">No inverter alarms.</div>}
          <div className="sub" style={{ marginTop: 6 }}>Estimated energy lost to inverter alarms and faults: <b>{f(d.fault_lost_mwh_est, 2)} MWh</b></div>
          {lowIso.length ? <div className="sub" style={{ marginTop: 6 }}>Lowest insulation resistance while running (below 100 kΩ): <span className="warn-text">{lowIso.slice(0, 12).map(([k, v]) => `${k} ${v.iso_min_kohm} kΩ`).join(", ")}{lowIso.length > 12 ? ` and ${lowIso.length - 12} more` : ""}</span></div> : null}
        </div>
        <div>
          <div className="sub" style={{ marginBottom: 6 }}>State now{t ? ` (${t} GMT)` : ""}: green run, grey standby/starting, amber alarm or derating, red fault.</div>
          {stations.map((st) => (
            <div key={st} style={{ display: "flex", gap: 4, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
              <span style={{ width: 40, color: "#8b98a8", fontSize: 12 }}>{st}</span>
              {inv.filter(([k]) => k.startsWith(st + ".")).sort((a, b) => Number(a[0].split("INV")[1]) - Number(b[0].split("INV")[1])).map(([k, v]) => (
                <span key={k} title={`${k}: ${v.state}${v.alarm ? ` · ${v.alarm_name} (${v.alarm})` : ""} · ${v.alarm_minutes} alarm min today · max ${f(v.temp_max_c, 0)} °C`}
                  style={{ background: KIND_BG[v.alarm ? "warn" : v.kind] || KIND_BG.warn, borderRadius: 4, padding: "2px 5px", fontSize: 11, minWidth: 26, textAlign: "center" }}>
                  {k.split(".")[1].replace("INV", "")}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Hourly({ days }) {
  const withH = days.filter((d) => d.hourly);
  const [sel, setSel] = useState(null);
  const day = withH.find((d) => d.date === sel) || withH[0];
  if (!day) return null;
  const rows = day.hourly.filter((h) => h.inverter_kwh || h.export_kwh || h.irradiation_wh_m2 > 5);
  const max = Math.max(1, ...rows.map((h) => Math.max(h.inverter_kwh || 0, h.export_kwh || 0)));
  return (
    <section className="panel">
      <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2>Hourly generation</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {withH.slice(0, 7).map((d) => (
            <button key={d.date} className="btn" style={d.date === day.date ? { borderColor: "#f5a524" } : undefined} onClick={() => setSel(d.date)}>{d.date.slice(5)}</button>
          ))}
          <a className="btn" href="/api/grid/report?format=hourly-csv" download>Download hourly CSV</a>
        </div>
      </div>
      <div className="sub">Energy in each hour (GMT, hour starting): export from P01 + P04, inverter AC output and DC input, and irradiation on the up-facing pyranometers. * = some minutes of that hour missing (reads low).</div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>Hour</th><th className="num">Export (kWh)</th><th className="num">Inverters AC (kWh)</th><th className="num">DC input (kWh)</th><th className="num">Irradiation (Wh/m²)</th><th style={{ width: "35%" }}></th></tr></thead>
        <tbody>{rows.map((h) => (
          <tr key={h.hour}><td>{String(h.hour).padStart(2, "0")}:00</td><td className={`num ${h.export_kwh !== null && h.inverter_kwh > 50 && h.export_min < 55 ? "warn-text" : ""}`} title={`${h.export_min} of 60 minutes recorded`}>{h.export_kwh ?? "—"}{h.export_kwh !== null && h.inverter_kwh > 50 && h.export_min < 55 ? "*" : ""}</td><td className="num">{h.inverter_kwh}</td><td className={`num ${h.dc_kwh && h.dc_min < 55 ? "warn-text" : ""}`}>{h.dc_kwh ?? "—"}{h.dc_kwh && h.dc_min < 55 ? "*" : ""}</td><td className="num">{h.irradiation_wh_m2}</td>
            <td><div style={{ height: 8, borderRadius: 4, background: "#f0c000", width: `${((h.export_kwh ?? h.inverter_kwh) / max) * 100}%` }} /></td></tr>
        ))}</tbody>
        <tfoot><tr><td><b>Total</b></td><td className="num"><b>{rows.some((h) => h.export_kwh !== null) ? rows.reduce((a, h) => a + (h.export_kwh || 0), 0).toLocaleString() : "—"}</b></td>
          <td className="num"><b>{rows.reduce((a, h) => a + (h.inverter_kwh || 0), 0).toLocaleString()}</b></td><td className="num"><b>{rows.reduce((a, h) => a + (h.dc_kwh || 0), 0).toLocaleString() || "—"}</b></td>
          <td className="num"><b>{rows.reduce((a, h) => a + (h.irradiation_wh_m2 || 0), 0).toLocaleString()}</b></td><td /></tr></tfoot>
      </table>
    </section>
  );
}

const f = (v, d = 1) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));

function Kpi({ label, value, unit, note, small }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value" style={small ? { fontSize: 20, whiteSpace: "nowrap" } : undefined}>{value}{unit && <span style={{ fontSize: 14, color: "#8b98a8" }}> {unit}</span>}</div>
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
  const last = g.days.find((d) => d.station) || null;
  const tripEvents = (g.trips || []).map((t) => ({ date: t.date, time: t.trip_utc.slice(11, 16), kind: "plant trip",
    what: `${t.scope === "plant" ? "whole plant" : t.scope}: ${t.cause}; back ${t.restored_utc ? t.restored_utc.slice(11, 16) : "not yet"}${t.duration_min ? ` (${t.duration_min} min)` : ""}; ~${t.energy_lost_mwh_est} MWh lost` }));
  const events = g.days.slice(0, 7).flatMap((d) => (d.events || []).slice().reverse().map((e) => ({ ...e, date: d.date })))
    .concat(tripEvents).sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
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
          <Kpi label="Performance ratio" value={f(today.pr_pct, 1)} unit="%" note={`temperature-corrected ${f(today.pr_temp_corr_pct, 1)} % · module ${f(today.tmod_weighted_c, 1)} °C`} />
          <Kpi label="Inverter availability" value={f(today.availability_pct, 1)} unit="%" note={`${(today.events || []).filter((e) => e.kind === "inverter outage").length} inverter outages today`} />
          <Kpi label="Irradiation" value={f(today.irradiation_kwh_m2, 2)} unit="kWh/m²" note={`${today.minutes_at_limit ?? "—"} min at the export limit`} />
          <Kpi label="Export setpoint" value={f(g.control?.setpoint_mw ?? today.setpoint_mw, 2)} unit="MW"
            note={`power limit ${g.control?.power_limit_pct ?? "—"} % · ${(today.events || []).filter((e) => e.kind === "setpoint change").length} changes today`} />
          <Kpi label="Efficiency" value={f(today.plant_eff_pct ?? today.inverter_eff_pct, 1)} unit="%"
            note={today.plant_eff_pct != null ? `DC to export · inverters alone ${f(today.inverter_eff_pct, 1)} %` : "inverters, DC to AC"} />
          <Kpi label="Energy curtailed (estimate)" value={f(today.curtailed_mwh_est, 2)} unit="MWh" note={`${today.minutes_at_limit ?? "—"} min at the export limit`} />
          <Kpi small label="Grid frequency" value={`${f(today.f_min, 2)}–${f(today.f_max, 2)}`} unit="Hz" note="day range at P07" />
          <Kpi small label="Grid voltage (VAB)" value={`${f(today.v_min_kv, 1)}–${f(today.v_max_kv, 1)}`} unit="kV" note={`${today.trips} trips · breakers open ${today.breaker_open_min} min in daylight`} />
        </div>
      )}
      <section className="panel">
        <div className="panel-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
          <h2>Daily grid report</h2>
          <a className="btn" href="/api/grid/report?format=csv" download>Download CSV</a>
        </div>
        <div className="sub">{g.note} Days with under 95 % of daylight minutes recorded (PC off) are marked and read low. PR = inverter energy ÷ (irradiation × 21.17 MWp), using the up-facing pyranometers as the plane-of-array reference (confirm their tilt on site); temperature-corrected PR uses −0.35 %/°C from 25 °C. Efficiency: inverters = AC ÷ DC; plant = export (P01 + P04) ÷ DC, so it includes transformer and cable losses. Curtailed energy is an estimate: in minutes at the export limit, the output the plant would have made at that day's typical output per unit irradiance, minus what it made.</div>
        <div className="scroll" style={{ marginTop: 8, maxHeight: "none" }}>
          <table>
            <thead><tr><th>Date</th><th className="num">Export (MWh)</th><th className="num">J07 report (MWh)</th><th className="num">Inverters (MWh)</th><th className="num">Irr. (kWh/m²)</th><th className="num">PR (%)</th><th className="num">PR temp-corr. (%)</th><th className="num">Avail. (%)</th><th className="num">Setpoint (MW)</th><th className="num">At limit (min)</th><th className="num">Curtailed est. (MWh)</th><th className="num">Lost to alarms est. (MWh)</th><th className="num">Inv. eff. (%)</th><th className="num">Plant eff. (%)</th><th className="num">Peak (MW)</th>
              <th className="num">CF (%)</th><th className="num">Yield (kWh/kWp)</th><th className="num">Op. hours</th><th className="num">Q (Mvarh)</th>
              <th className="num">P07 ÷ P01+P04</th><th className="num">f range (Hz)</th><th className="num">Trips</th><th className="num">Data (%)</th></tr></thead>
            <tbody>
              {g.days.map((d) => (
                <tr key={d.date}>
                  <td style={{ whiteSpace: "nowrap" }}>{d.date}{d.partial ? " (today)" : ""}</td>
                  <td className="num">{f(d.export_mwh, 1)}</td>
                  <td className="num">{f(d.j07_mwh, 1)}</td>
                  <td className="num">{f(d.inverter_mwh, 1)}</td>
                  <td className="num">{f(d.irradiation_kwh_m2, 2)}</td>
                  <td className="num">{f(d.pr_pct, 1)}</td>
                  <td className="num">{f(d.pr_temp_corr_pct, 1)}</td>
                  <td className={`num ${d.availability_pct !== null && d.availability_pct !== undefined && d.availability_pct < 98 ? "warn-text" : ""}`}>{f(d.availability_pct, 1)}</td>
                  <td className="num">{d.setpoint_min_mw == null ? "—" : d.setpoint_min_mw === d.setpoint_max_mw ? f(d.setpoint_max_mw, 2) : `${f(d.setpoint_min_mw, 2)}–${f(d.setpoint_max_mw, 2)}`}</td>
                  <td className="num">{d.minutes_at_limit ?? "—"}</td>
                  <td className="num">{f(d.curtailed_mwh_est, 2)}</td>
                  <td className={`num ${d.fault_lost_mwh_est > 0.5 ? "warn-text" : ""}`}>{f(d.fault_lost_mwh_est, 2)}</td>
                  <td className="num">{f(d.inverter_eff_pct, 1)}</td>
                  <td className="num">{f(d.plant_eff_pct, 1)}</td>
                  <td className="num">{f(d.peak_mw, 1)}</td>
                  <td className="num">{f(d.capacity_factor_pct, 1)}</td>
                  <td className="num">{f(d.specific_yield, 2)}</td>
                  <td className="num">{f(d.operating_h, 1)}</td>
                  <td className="num">{f(d.reactive_mvarh, 1)}</td>
                  <td className={`num ${d.p07_ratio !== null && Math.abs(d.p07_ratio - 1) > 0.03 ? "warn-text" : ""}`}>{f(d.p07_ratio, 2)}</td>
                  <td className="num">{d.f_min == null ? "—" : `${f(d.f_min, 2)}–${f(d.f_max, 2)}`}</td>
                  <td className={`num ${d.trips > 0 ? "bad-text" : ""}`}>{d.trips ?? "—"}</td>
                  <td className={`num ${!d.partial && d.coverage_pct != null && d.coverage_pct < 95 ? "warn-text" : ""}`}>{f(d.coverage_pct, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {full.length === 0 && <div className="sub" style={{ marginTop: 6 }}>Feeder data started on 22 Nov 2026 at 15:45 GMT, so the first full day is 23 Nov.</div>}
      </section>
      <section className="panel">
        <h2>Plant trips</h2>
        <div className="sub">Whole-plant or station trips found in the inverter data (80 % of inverters to fault while producing), newest first. Also logged in the Google Sheet's Trips tab and e-mailed. Energy lost is an estimate from the output before the trip, scaled by irradiance.</div>
        {!(g.trips || []).length ? <div className="empty">No trips recorded.</div> : (
          <div className="scroll" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Trip (GMT)</th><th>Back</th><th className="num">Min</th><th>Scope</th><th>Cause</th><th className="num">Frequency (Hz)</th><th className="num">MW before</th><th className="num">Lost (MWh est.)</th><th>Breakers</th></tr></thead>
              <tbody>{g.trips.map((t) => (
                <tr key={t.trip_utc + t.scope}><td style={{ whiteSpace: "nowrap" }}>{t.trip_utc}</td><td>{t.restored_utc ? t.restored_utc.slice(11) : <span className="bad-text">not yet</span>}</td>
                  <td className="num">{t.duration_min || "—"}</td><td>{t.scope === "plant" ? "whole plant" : t.scope}</td><td className="bad-text">{t.cause}</td>
                  <td className="num">{t.freq_min_hz}–{t.freq_max_hz}</td><td className="num">{t.mw_before}</td><td className="num">{t.energy_lost_mwh_est}</td><td>{t.breakers}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {(g.trips || []).length ? <div className="sub" style={{ marginTop: 6 }}>Total: {g.trips.length} trips, about {g.trips.reduce((a, t) => a + (Number(t.energy_lost_mwh_est) || 0), 0).toFixed(1)} MWh lost.</div> : null}
      </section>
      <Alarms days={g.days} />
      <Hourly days={g.days} />
      <div className="grid two">
        <section className="panel">
          <h2>Station comparison</h2>
          <div className="sub">{last ? `${last.date}${last.partial ? " (today so far)" : ""}` : ""} · energy per station and per inverter, from the inverter readings.</div>
          {!last?.station ? <div className="empty">No inverter data.</div> : (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>Station</th><th className="num">Inverters</th><th className="num">Energy (MWh)</th><th className="num">Per inverter (MWh)</th><th className="num">vs best (%)</th></tr></thead>
              <tbody>
                {(() => {
                  const st = Object.entries(last.station), best = Math.max(...st.map(([, v]) => v.mwh_per_inv || 0));
                  return st.map(([k, v]) => (
                    <tr key={k}><td>{k}</td><td className="num">{v.inverters}</td><td className="num">{f(v.mwh, 1)}</td><td className="num">{f(v.mwh_per_inv, 2)}</td>
                      <td className={`num ${best && v.mwh_per_inv / best < 0.95 ? "warn-text" : ""}`}>{best ? f((v.mwh_per_inv / best) * 100, 0) : "—"}</td></tr>
                  ));
                })()}
              </tbody>
            </table>
          )}
          {last?.low_inverters?.length ? <div className="sub" style={{ marginTop: 6 }}>Inverters below 85 % of the median inverter: <span className="warn-text">{last.low_inverters.join(", ")}</span></div> : null}
          <div className="sub" style={{ marginTop: 6 }}>Weather sensors: {(last?.sensor_status || ["—"]).join("; ")}</div>
        </section>
        <section className="panel">
          <h2>Events</h2>
          <div className="sub">Breaker changes, trips and faults on P07/P01/P04; changes to the export setpoint; inverter alarms; plant trips; grid frequency outside 49.5–50.5 Hz; inverters off for 15+ min while the rest of the plant produced. Last 7 days, newest first.</div>
          {events.length === 0 ? <div className="empty">No events.</div> : (
            <div className="scroll" style={{ marginTop: 8 }}>
              <table>
                <thead><tr><th>Date</th><th>Time (GMT)</th><th>Event</th><th>Details</th></tr></thead>
                <tbody>{events.map((e, i) => (
                  <tr key={i}><td style={{ whiteSpace: "nowrap" }}>{e.date}</td><td>{e.time}</td><td className={e.kind === "trip" || e.kind === "plant trip" || e.kind === "fault" || e.kind === "breaker open" ? "bad-text" : e.kind === "setpoint change" ? "" : "warn-text"}>{e.kind}</td><td>{e.what}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
      <section className="panel">
        <h2>Weather station</h2>
        <div className="sub">Daily values from the plant's own sensors: pyranometers at STS1 and STS3, module and ambient temperature, WS600 weather station and DustIQ soiling sensor at STS1.</div>
        <div className="scroll" style={{ marginTop: 8, maxHeight: "none" }}>
          <table>
            <thead><tr><th>Date</th><th className="num">Irradiation (kWh/m²)</th><th className="num">Module max (°C)</th><th className="num">Ambient mean (°C)</th><th className="num">Humidity (%)</th>
              <th className="num">Pressure (hPa)</th><th className="num">Wind mean / max (m/s)</th><th className="num">Wind from (°)</th><th className="num">Rain (mm)</th><th className="num">Soiling ratio (%)</th></tr></thead>
            <tbody>{g.days.filter((d) => d.irradiation_kwh_m2 !== undefined).map((d) => (
              <tr key={d.date}><td style={{ whiteSpace: "nowrap" }}>{d.date}{d.partial ? " (today)" : ""}</td><td className="num">{f(d.irradiation_kwh_m2, 2)}</td><td className="num">{f(d.tmod_max_c, 1)}</td>
                <td className="num">{f(d.tamb_mean_c, 1)}</td><td className="num">{f(d.rh_mean_pct, 0)}</td><td className="num">{f(d.pressure_hpa, 1)}</td>
                <td className="num">{f(d.wind_mean_ms, 1)} / {f(d.wind_max_ms, 1)}</td><td className="num">{f(d.wind_dir_deg, 0)}</td><td className="num">{f(d.rain_mm, 1)}</td>
                <td className={`num ${d.soiling_pct !== null && d.soiling_pct < 97 ? "warn-text" : ""}`}>{f(d.soiling_pct, 1)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Monthly</h2>
        <table>
          <thead><tr><th>Month</th><th className="num">Days</th><th className="num">Export (MWh)</th><th className="num">Inverters (MWh)</th><th className="num">Irr. (kWh/m²)</th><th className="num">PR (%)</th><th className="num">Peak (MW)</th><th className="num">Trips</th><th className="num">Days with gaps</th></tr></thead>
          <tbody>
            {g.months.map((m) => (
              <tr key={m.month}><td>{m.month}</td><td className="num">{m.days}</td><td className="num">{f(m.export_mwh, 1)}</td><td className="num">{f(m.inverter_mwh, 1)}</td><td className="num">{f(m.irradiation_kwh_m2, 1)}</td><td className="num">{f(m.pr_pct, 1)}</td><td className="num">{f(m.peak_mw, 1)}</td>
                <td className="num">{m.trips}</td><td className={`num ${m.low_coverage_days ? "warn-text" : ""}`}>{m.low_coverage_days}</td></tr>
            ))}
          </tbody>
        </table>
        <div className="sub" style={{ marginTop: 6 }}>Only months since feeder collection began. Earlier months are in History (J07 reports and logger PV-Sum).</div>
      </section>
    </>
  );
}
