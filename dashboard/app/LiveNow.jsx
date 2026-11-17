"use client";
import { useEffect, useState } from "react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

// Polls /api/now (logger homepage gauges, read by live_poller.py every 10 s).
export function useNow(everyMs = 10000) {
  const [now, setNow] = useState(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/now", { cache: "no-store" });
        if (r.ok && !stop) setNow(await r.json());
      } catch { /* keep the last values */ }
    };
    tick();
    const id = setInterval(tick, everyMs);
    return () => { stop = true; clearInterval(id); };
  }, [everyMs]);
  return now;
}

const f1 = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const mw = (kw) => (kw === null || kw === undefined ? null : kw / 1000);

export default function LiveNow() {
  const n = useNow();
  const w = n?.latest;
  const age = n?.ageS;
  const state = !w ? "off" : age > 90 ? "stale" : "ok";
  const text = {
    off: "Waiting for the live poller (task \"MCSolar Live Now\")",
    stale: `Live values ${Math.round(age / 60)} min old`,
    ok: `Live · read ${age} s ago`,
  }[state];
  const pts = (n?.points || []).map((p) => ({ x: Date.parse(p.t), mw: p.mw }));
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Live now</h2>
          <div className="sub">Straight from the logger homepage gauges, refreshed every 10 seconds (read-only).</div>
        </div>
        <span className="status"><span className={`dot ${state}`} />{text}</span>
      </div>
      <div className="livenow">
        <div className="lnbig"><div className="tvl">PV sum</div><div className="lnv">{f1(w?.pv_sum_mw, 2)}<span> MW</span></div>
          <div className="sub">limit {f1(w?.power_limit_user_pct, 0)} % · {w?.time_utc ? w.time_utc.slice(11, 19) : "—"} UTC</div></div>
        <div className="lngrid">
          {[1, 2, 3, 4].map((s) => (
            <div key={s} className="lnk"><div className="tvl">STS{s}</div><div className="lnm">{f1(mw(w?.[`sts${s}_kw`]), 2)} MW</div></div>
          ))}
          <div className="lnk"><div className="tvl">Irradiance A</div><div className="lnm">{f1(w?.zoneA_ghi_wm2, 0)} W/m²</div></div>
          <div className="lnk"><div className="tvl">Irradiance 4</div><div className="lnm">{f1(w?.zone4_ghi_wm2, 0)} W/m²</div></div>
          <div className="lnk"><div className="tvl">Module A / 4</div><div className="lnm">{f1(w?.zoneA_tmod_c)} / {f1(w?.zone4_tmod_c)} °C</div></div>
          <div className="lnk"><div className="tvl">Ambient A / 4</div><div className="lnm">{f1(w?.zoneA_tamb_c)} / {f1(w?.zone4_tamb_c)} °C</div></div>
        </div>
        <div className="lnchart">
          <ResponsiveContainer width="100%" height={150}>
            <AreaChart data={pts} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#30363d" strokeDasharray="3 3" />
              <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} scale="time" tick={{ fill: "#8b949e", fontSize: 11 }}
                     tickFormatter={(x) => new Date(x).toISOString().slice(11, 16)} />
              <YAxis domain={[0, 18]} tick={{ fill: "#8b949e", fontSize: 11 }} unit=" MW" width={56} />
              <Tooltip labelFormatter={(x) => new Date(x).toISOString().slice(11, 19) + " UTC"} formatter={(v) => [`${Number(v).toFixed(2)} MW`, "PV sum"]}
                       contentStyle={{ background: "#161b22", border: "1px solid #30363d" }} />
              <Area dataKey="mw" stroke="#e6edf3" fill="rgba(230,237,243,.12)" isAnimationActive={false} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          <div className="sub">Last 90 minutes, every 10 seconds</div>
        </div>
      </div>
    </section>
  );
}
