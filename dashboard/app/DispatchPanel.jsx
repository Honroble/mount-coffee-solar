"use client";
import { useEffect, useMemo, useState } from "react";

// Decision support for the dispatcher: enter what is running now; the panel adds the solar forecast.
// Unit sizes from the LEC system: Mount Coffee hydro 4 x 22 MW, thermal 10 + 10 + 18 MW, regional import (PPA) 50 MW.
const DEFAULTS = {
  load: 130,
  hydro: [{ on: true, mw: 20, cap: 22 }, { on: true, mw: 20, cap: 22 }, { on: false, mw: 0, cap: 22 }, { on: false, mw: 0, cap: 22 }],
  thermal: [{ name: "Thermal 1", on: true, mw: 9, cap: 10 }, { name: "Thermal 2", on: true, mw: 9, cap: 10 }, { name: "Thermal 3", on: true, mw: 16, cap: 18 }],
  ppa: 45, ppaLimit: 50, minSyncPct: 40,
};
const KEY = "mcsolar-dispatch-v1";
const f1 = (v) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(1));

function NumberIn({ value, onChange, step = 1, w = 70 }) {
  return <input type="number" value={value} step={step} onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))} style={{ width: w }} />;
}

export default function DispatchPanel({ live }) {
  const [s, setS] = useState(DEFAULTS);
  useEffect(() => { try { const x = JSON.parse(localStorage.getItem(KEY)); if (x) setS({ ...DEFAULTS, ...x }); } catch { /* first use */ } }, []);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ } }, [s]);
  const upd = (k, v) => setS((o) => ({ ...o, [k]: v }));
  const updUnit = (k, i, f, v) => setS((o) => ({ ...o, [k]: o[k].map((u, j) => (j === i ? { ...u, [f]: v } : u)) }));

  const solar = useMemo(() => {
    const now = live.latestForecast?.p_now ?? live.plant?.p_mw ?? 0;
    const pts = live.blend?.points || [];
    const t0 = pts[0] ? Date.parse(pts[0].t) : Date.now();
    const next1h = pts.filter((p) => Date.parse(p.t) <= t0 + 3600000).map((p) => p.mw);
    const hourly = live.nwp?.forecast?.hourly || [];
    const lowNext = hourly.filter((h) => { const t = Date.parse(h.t); return t >= Date.now() - 1800000 && t <= Date.now() + 3600000; }).map((h) => h.low);
    const minNext = Math.min(now, ...(next1h.length ? next1h : [now]), ...(lowNext.length ? lowNext : [now]));
    return { now, minNext: Math.max(0, minNext), drop: Math.max(0, now - Math.max(0, minNext)) };
  }, [live]);

  const r = useMemo(() => {
    const units = [...s.hydro.map((u, i) => ({ ...u, name: `Hydro ${i + 1}` })), ...s.thermal].filter((u) => u.on);
    const sync = units.reduce((a, u) => a + u.mw, 0);
    const reserve = units.reduce((a, u) => a + Math.max(0, u.cap - u.mw), 0);
    const largestUnit = units.reduce((a, u) => (u.mw > a.mw ? u : a), { mw: 0, name: "—" });
    const losses = [{ what: largestUnit.name, mw: largestUnit.mw }, { what: "Regional import (tie-line trip)", mw: s.ppa }, { what: "Solar drop within the hour (forecast)", mw: solar.drop }];
    const largest = losses.reduce((a, l) => (l.mw > a.mw ? l : a));
    const margin = reserve - largest.mw;
    const supply = sync + s.ppa + solar.now;
    // solar cap so that a solar collapse to its forecast low is covered by the reserve left after the largest other loss
    const otherLargest = Math.max(largestUnit.mw, s.ppa);
    const room = reserve - otherLargest;
    const cap = solar.drop > reserve ? Math.max(0, Math.min(16.64, solar.minNext + Math.max(0, reserve))) : null;
    return { sync, reserve, losses, largest, margin, supply, balance: supply - s.load, tie: s.ppaLimit - s.ppa,
      syncPct: s.load > 0 ? (100 * sync) / s.load : null, cap, capPct: cap === null ? null : Math.round((100 * cap) / 16.64), room };
  }, [s, solar]);

  const state = (ok, warn) => (ok ? "ok" : warn ? "warn" : "bad");
  const C = { ok: "#3fb950", warn: "#d29922", bad: "#f85149" };
  const Out = ({ label, value, st, note }) => (
    <div className="kpi"><div className="label"><span className="dot" style={{ background: C[st] }} /> {label}</div><div className="value" style={{ fontSize: 24 }}>{value}</div>{note && <div className="note">{note}</div>}</div>
  );

  return (
    <section className="panel" id="dispatch">
      <div className="panel-head">
        <div><h2>Dispatch check</h2><div className="sub">Enter what is running now. The check adds the solar output and its forecast for the next hour. Decision support only: the dispatcher decides. Values are kept in this browser.</div></div>
        <button className="btn" onClick={() => setS(DEFAULTS)}>Reset</button>
      </div>
      <div className="grid two">
        <div>
          <table className="dtable"><tbody>
            <tr><td>System load (MW)</td><td><NumberIn value={s.load} onChange={(v) => upd("load", v)} /></td><td /></tr>
            {s.hydro.map((u, i) => (
              <tr key={`h${i}`}><td><label><input type="checkbox" checked={u.on} onChange={(e) => updUnit("hydro", i, "on", e.target.checked)} /> Hydro unit {i + 1} ({u.cap} MW)</label></td>
                <td><NumberIn value={u.mw} onChange={(v) => updUnit("hydro", i, "mw", v)} /> MW</td><td className="sub">{u.on ? `${f1(u.cap - u.mw)} MW spare` : "off"}</td></tr>
            ))}
            {s.thermal.map((u, i) => (
              <tr key={`t${i}`}><td><label><input type="checkbox" checked={u.on} onChange={(e) => updUnit("thermal", i, "on", e.target.checked)} /> {u.name} ({u.cap} MW)</label></td>
                <td><NumberIn value={u.mw} onChange={(v) => updUnit("thermal", i, "mw", v)} /> MW</td><td className="sub">{u.on ? `${f1(u.cap - u.mw)} MW spare` : "off"}</td></tr>
            ))}
            <tr><td>Regional import now (MW)</td><td><NumberIn value={s.ppa} onChange={(v) => upd("ppa", v)} /></td><td className="sub">limit <NumberIn value={s.ppaLimit} onChange={(v) => upd("ppaLimit", v)} w={56} /> MW</td></tr>
            <tr><td>Solar now (live)</td><td><b>{f1(solar.now)} MW</b></td><td className="sub">could fall to {f1(solar.minNext)} MW within the hour</td></tr>
            <tr><td>Minimum synchronous share</td><td><NumberIn value={s.minSyncPct} onChange={(v) => upd("minSyncPct", v)} /> %</td><td className="sub">your rule</td></tr>
          </tbody></table>
        </div>
        <div className="grid kpis" style={{ margin: 0, alignContent: "start" }}>
          <Out label="Supply − load" value={`${f1(r.balance)} MW`} st={state(Math.abs(r.balance) < 3, Math.abs(r.balance) < 8)} note={`supply ${f1(r.supply)} MW`} />
          <Out label="Spinning reserve" value={`${f1(r.reserve)} MW`} st={state(r.margin >= 0, r.margin > -5)} note={`largest loss: ${r.largest.what}, ${f1(r.largest.mw)} MW`} />
          <Out label="Reserve margin" value={`${f1(r.margin)} MW`} st={state(r.margin >= 0, r.margin > -5)} note="reserve − largest single loss" />
          <Out label="Tie-line margin" value={`${f1(r.tie)} MW`} st={state(r.tie >= 5, r.tie >= 0)} note="import limit − import now" />
          <Out label="Synchronous share" value={r.syncPct === null ? "—" : `${Math.round(r.syncPct)} %`} st={state(r.syncPct >= s.minSyncPct, r.syncPct >= s.minSyncPct - 10)} note="hydro + thermal ÷ load" />
          <Out label="Solar cap (PowerLimit_User)" value={r.cap === null ? "not needed" : `${r.capPct} %`} st={r.cap === null ? "ok" : "warn"}
               note={r.cap === null ? "reserve covers the forecast solar drop" : `≈ ${f1(r.cap)} MW: keeps a solar collapse within the reserve`} />
        </div>
      </div>
      <div className="sub" style={{ marginTop: 8 }}>Largest-loss candidates: {r.losses.map((l) => `${l.what} ${f1(l.mw)} MW`).join(" · ")}. Unit sizes from the LEC system (hydro 4 × 22 MW, thermal 10 + 10 + 18 MW, import limit 50 MW); edit them if they change.</div>
    </section>
  );
}
