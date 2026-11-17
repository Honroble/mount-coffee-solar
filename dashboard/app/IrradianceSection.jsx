"use client";
import { useMemo, useState } from "react";
import { useNow } from "./LiveNow";
import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine } from "recharts";

const SERIES = [
  { key: "sts1_up", label: "STS1 horizontal", color: "#f5a524", width: 2 },
  { key: "sts3_up", label: "STS3 horizontal", color: "#e0af68", width: 2, dash: "6 3" },
  { key: "sts1_down", label: "STS1 reflected (down)", color: "#9ece6a", width: 1.4 },
  { key: "sts3_down", label: "STS3 reflected (down)", color: "#73daca", width: 1.4, dash: "6 3" },
  { key: "sat", label: "Satellite over plant", color: "#7aa2f7", width: 1.8 },
  { key: "ring", label: "Satellite, 20 km ring average", color: "#bb9af7", width: 1.2, dash: "3 3" },
  { key: "model", label: "Weather models (average of 6), 10° panel plane", color: "#f7768e", width: 1.6, dash: "8 4" },
  { key: "clear", label: "Clear-sky maximum (horizontal)", color: "#6b7a8c", width: 1.2, dash: "2 4" },
];
const fmt = (v) => (v === null || v === undefined ? "—" : Math.round(v));
const ms = (iso) => new Date(iso).getTime();
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const ago = (iso, now) => (iso ? Math.round((new Date(now) - new Date(iso)) / 60000) : null);

function Kpi({ label, value, note }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}<span style={{ fontSize: 14, color: "#8b98a8" }}> W/m²</span></div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

// Live zone sensors from the logger homepage (live_poller.py, every 10 s)
function MeteoNow({ n }) {
  const w = n?.latest;
  const f = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
  const fresh = w && n.ageS <= 90;
  const tile = (label, value, unit) => (
    <div className="lnk"><div className="tvl">{label}</div><div className="lnm">{value}<span> {unit}</span></div></div>
  );
  return (
    <>
      <div className="sub" style={{ marginBottom: 6 }}>
        <span className={`dot ${!w ? "off" : fresh ? "ok" : "stale"}`} /> Live zone sensors · {w ? `read ${n.ageS} s ago (${w.time_utc.slice(11, 19)} GMT)` : "waiting for the live poller"}
      </div>
      <div className="meteonow">
        {tile("Irradiance zone A", f(w?.zoneA_ghi_wm2, 0), "W/m²")}
        {tile("Irradiance zone 4", f(w?.zone4_ghi_wm2, 0), "W/m²")}
        {tile("Module temp A / 4", `${f(w?.zoneA_tmod_c)} / ${f(w?.zone4_tmod_c)}`, "°C")}
        {tile("Ambient temp A / 4", `${f(w?.zoneA_tamb_c)} / ${f(w?.zone4_tamb_c)}`, "°C")}
      </div>
    </>
  );
}

export default function IrradianceSection({ live }) {
  const ir = live.irradiance;
  const n = useNow();
  const [hidden, setHidden] = useState({ ring: true });
  const day = live.now.slice(0, 10);

  const data = useMemo(() => {
    if (!ir || ir.error) return [];
    const m = new Map();
    const put = (t, k, v) => { if (v === null || v === undefined) return; const x = ms(t); const o = m.get(x) || { x }; o[k] = v; m.set(x, o); };
    for (const s of ir.sensors) for (const k of ["sts1_up", "sts3_up", "sts1_down", "sts3_down"]) put(s.t, k, s[k]);
    for (const s of ir.satellite.series) { put(s.t, "sat", s.plant); put(s.t, "ring", s.ring); }
    for (const h of ir.models.hourly) put(h.t, "model", h.gti);
    for (const c of ir.clearSky) put(c.t, "clear", c.ghi);
    const from = ms(day + "T05:00:00Z"), to = ms(day + "T19:30:00Z");
    return [...m.values()].filter((o) => o.x >= from && o.x <= to).sort((a, b) => a.x - b.x);
  }, [ir, day]);

  if (!ir || ir.error) {
    return <section className="panel"><h2>Meteo Station</h2><div className="empty">No irradiance data yet.{ir?.error ? ` ${ir.error}` : ""}</div></section>;
  }
  const L = ir.sensorsLatest || {};
  const sat = ir.satellite.latest;
  const from = ms(day + "T05:00:00Z"), to = ms(day + "T19:30:00Z");
  const nowModel = (() => {
    const h = ir.models.hourly.filter((x) => ms(x.t) - 1800000 <= ms(live.now)).at(-1);
    return h ? h.gti : null;
  })();

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Meteo Station</h2>
          <div className="sub">Weather measured at the plant: live zone sensors (every 10 s), then all sunlight measurements and forecasts for today in W/m². The plant's pyranometers measure horizontal sunlight (up) and light reflected from the ground (down); the panels face south at 10°, so they receive slightly more than the horizontal sensors around midday.</div>
        </div>
        {L.time && <div className="sub">sensors {hhmm(L.time)} GMT · satellite {sat ? `${hhmm(sat.end)} GMT (${ago(sat.end, live.now)} min old)` : "—"}</div>}
      </div>

      <MeteoNow n={n} />
      <div className="grid kpis" style={{ margin: "4px 0 10px" }}>
        <Kpi label="STS1 horizontal" value={fmt(L.sts1_up)} note={`reflected ${fmt(L.sts1_down)} W/m²`} />
        <Kpi label="STS3 horizontal" value={fmt(L.sts3_up)} note={ir.sensorsMissing.includes("sts3_down") ? "reflected: collected from tomorrow" : `reflected ${fmt(L.sts3_down)} W/m²`} />
        <Kpi label="Satellite over plant" value={fmt(sat?.plant)} note={`20 km ring average ${fmt(sat?.ring)} W/m²`} />
        <Kpi label="Weather models, now" value={fmt(nowModel)} note="average of 6, this hour, 10° panel plane" />
        <Kpi label="Clear-sky maximum, now" value={fmt(ir.clearSkyNow)} note={L.sts1_up != null && ir.clearSkyNow > 50 ? `STS1 at ${Math.round((100 * L.sts1_up) / ir.clearSkyNow)} % of clear sky` : "horizontal, no clouds"} />
      </div>

      <div className="legend">
        {SERIES.map((s) => (
          <span key={s.key} style={{ cursor: "pointer", opacity: hidden[s.key] ? 0.4 : 1 }} onClick={() => setHidden((h) => ({ ...h, [s.key]: !h[s.key] }))}>
            <i style={{ background: s.dash ? "transparent" : s.color, borderTop: s.dash ? `2px dashed ${s.color}` : "none" }} />{s.label}
          </span>
        ))}
        <span className="sub">(click a name to show or hide it)</span>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
          <XAxis dataKey="x" type="number" scale="time" domain={[from, to]} tickFormatter={hhmm} stroke="#8b98a8" fontSize={11}
                 ticks={Array.from({ length: 15 }, (_, i) => from + i * 3600000)} />
          <YAxis stroke="#8b98a8" fontSize={11} width={56} domain={[0, 1200]} unit="" label={{ value: "W/m²", angle: -90, position: "insideLeft", fill: "#8b98a8", fontSize: 11 }} />
          <Tooltip contentStyle={{ background: "#171e26", border: "1px solid #263241", fontSize: 12 }} labelFormatter={(t) => `${hhmm(t)} GMT`}
                   formatter={(v, n) => [`${Math.round(v)} W/m²`, n]} />
          <ReferenceLine x={ms(live.now)} stroke="#3fb6c9" strokeOpacity={0.5} />
          {SERIES.filter((s) => !hidden[s.key]).map((s) => (
            <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={s.width} strokeDasharray={s.dash}
                  dot={false} connectNulls isAnimationActive={false} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="sub" style={{ marginTop: 6 }}>
        Sensors: 5-minute averages of the logger's 1-minute readings. Satellite: EUMETSAT/DWD via Open-Meteo, 10-minute, arrives about 20 minutes late; the 20 km ring shows clouds before they reach the plant.
        Weather models: hourly average of the 6 models on the panel plane. Clear sky: Haurwitz model at 6.505 N, 10.648 W. Not logged by the logger, so not shown: WS600 global radiation and the IEC "M_Irradiation" value.
      </div>
    </section>
  );
}
