"use client";
// Plant health: 22 kV feeder relays (breakers, trips, faults, live readings) and the daily DC string check.
import { useEffect, useState } from "react";

const f0 = (v, d = 0) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));

export default function GridStrings() {
  const [g, setG] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch("/api/grid", { cache: "no-store" }).then((r) => r.json()).then((j) => !stop && setG(j)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  if (!g) return null;
  const s = g.strings;
  const bad = s ? Object.entries(s.inverters || {}).filter(([, v]) => (v.dead || []).length || (v.weak || []).length) : [];
  return (
    <>
      <section className="panel">
        <h2>22 kV feeders</h2>
        <div className="sub">Protection relays as reported to the logger, every minute{g.time ? ` · last reading ${g.time.slice(11, 16)} GMT` : ""}. Breaker state, trips and faults are reliable; P07 active power and energy read about 34 % low (VBC and VCA voltage inputs read ~12.7 kV), so export is taken from P01 + P04 until it is repaired.</div>
        {(() => {
          const by = Object.fromEntries((g.feeders || []).map((x) => [x.key.slice(0, 3), x]));
          if (!by.P01 || !by.P04 || by.P01.p_kw === null || by.P04.p_kw === null) return null;
          const exp = by.P01.p_kw + by.P04.p_kw, p7 = by.P07?.p_kw;
          return <div className="sub" style={{ margin: "6px 0" }}><b>Export now (P01 + P04): {(exp / 1000).toFixed(2)} MW</b>
            {p7 !== null && p7 !== undefined && exp > 1000 ? ` · P07 reads ${Math.round((Math.abs(p7) / exp) * 100)} % of that (under-reading; VBC/VCA voltage inputs at fault)` : ""}</div>;
        })()}
        {g.missing || !g.feeders?.length ? <div className="empty">No feeder readings yet.</div> : (
          <div className="scroll" style={{ marginTop: 8, maxHeight: "none" }}>
            <table>
              <thead><tr><th>Feeder</th><th>Breaker</th><th className="num">Trips today / total</th><th>Faults</th>
                <th className="num">P (kW)</th><th className="num">Q (kvar)</th><th className="num">PF</th><th className="num">f (Hz)</th>
                <th className="num">V AB / BC / CA (kV)</th><th className="num">I A / B / C (A)</th></tr></thead>
              <tbody>
                {g.feeders.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td className={f.breaker === "closed" ? "" : "bad-text"}><span className={`dot ${f.breaker === "closed" ? "ok" : "off"}`} /> {f.breaker}</td>
                    <td className={`num ${f.trips_today > 0 ? "bad-text" : ""}`}>{f0(f.trips_today)} / {f0(f.trips_total)}</td>
                    <td className={f.phase_fault || f.earth_fault ? "bad-text" : ""}>{f.phase_fault ? "phase " : ""}{f.earth_fault ? "earth" : ""}{!f.phase_fault && !f.earth_fault ? "none" : ""}</td>
                    <td className="num">{f0(f.p_kw)}</td>
                    <td className="num">{f0(f.q_kvar)}</td>
                    <td className="num">{f0(f.pf, 2)}</td>
                    <td className={`num ${f.f_hz !== null && (f.f_hz > 50.5 || f.f_hz < 49.5) ? "warn-text" : ""}`}>{f0(f.f_hz, 2)}</td>
                    <td className="num">{[f.v_ab, f.v_bc, f.v_ca].map((x) => (x === null ? "—" : (x / 1000).toFixed(1))).join(" / ")}</td>
                    <td className="num">{[f.i_a, f.i_b, f.i_c].map((x) => f0(x)).join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel">
        <h2>DC strings</h2>
        <div className="sub">Daily check after 14:00 GMT: each inverter's 32 string currents averaged over the midday window and compared with its typical string. Dead = no current while the others carry over 2 A; weak = below 70 % of typical. Positions empty on most inverters of a station are treated as unused by design.</div>
        {!s ? <div className="empty">No string check yet – it runs daily after 14:00 GMT.</div> : (
          <>
            <div className="sub" style={{ margin: "8px 0" }}>Check of {s.date}, {s.window_gmt} GMT · {Object.keys(s.inverters || {}).length} inverters ·
              unused positions: {Object.entries(s.unused_by_station || {}).map(([k, v]) => `${k} ${v.join(", ")}`).join(" · ") || "none"}</div>
            {bad.length === 0 ? <div className="empty">No dead or weak strings.</div> : (
              <table>
                <thead><tr><th>Inverter</th><th>Dead strings</th><th>Weak strings</th><th className="num">Typical string (A)</th><th className="num">Strings in use</th></tr></thead>
                <tbody>
                  {bad.map(([inv, v]) => (
                    <tr key={inv}>
                      <td>{inv}</td>
                      <td className={v.dead?.length ? "bad-text" : ""}>{v.dead?.length ? v.dead.join(", ") : "—"}</td>
                      <td className={v.weak?.length ? "warn-text" : ""}>{v.weak?.length ? v.weak.join(", ") : "—"}</td>
                      <td className="num">{f0(v.median_a, 1)}</td>
                      <td className="num">{v.used_strings ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="sub" style={{ marginTop: 6 }}>{bad.length ? `${bad.reduce((n, [, v]) => n + (v.dead?.length || 0), 0)} dead strings in all: check the as-built string count, then fuses, connectors and DC isolators.` : ""}</div>
          </>
        )}
      </section>
    </>
  );
}
