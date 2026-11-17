"use client";
import { lowForecastWarning } from "@/lib/lowForecast";
import { useEffect, useState } from "react";
import { ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";

const f1 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(1));
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);
const ms = (s) => new Date(s).getTime();

export default function TvScreen({ initial }) {
  const [live, setLive] = useState(initial);
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const a = setInterval(async () => { try { const r = await fetch("/api/live", { cache: "no-store" }); if (r.ok) setLive(await r.json()); } catch { /* keep last */ } }, 60000);
    const b = setInterval(() => setClock(new Date()), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  const f = live.latestForecast;
  const day = live.now.slice(0, 10);
  const from = ms(day + "T05:30:00Z"), to = ms(day + "T19:00:00Z");
  const hourly = (live.nwp?.forecast?.hourly || []).filter((h) => ms(h.t) >= from && ms(h.t) <= to).map((h) => ({ x: ms(h.t), band: [h.low, h.high], nwp: h.new }));
  const actual = (live.actual || []).filter((a) => ms(a.t) >= from).map((a) => ({ x: ms(a.t), act: a.mw }));
  const best = (live.blend?.points || []).filter((p) => ms(p.t) <= to).map((p) => ({ x: ms(p.t), best: p.mw }));
  const today = live.nwp?.actualToday;
  const todayFc = live.nwp?.forecast?.days?.find((d) => d.date === day);
  const lowWarn = lowForecastWarning(live.latestForecast, live.now);
  const alerts = [...(lowWarn ? [`LOW OUTPUT FORECAST · ${lowWarn}`] : []), ...(live.nwp?.forecast?.alerts || []).filter((a) => a.time.slice(0, 10) >= day && a.kind !== "reserve").map((a) => a.text),
    ...(live.health?.checks || []).filter((c) => c.state === "bad").map((c) => `${c.label}: ${c.text}`)];
  const age = live.collector?.lastPlant ? Math.round((Date.now() - ms(live.collector.lastPlant)) / 60000) : null;
  const Big = ({ label, v, sub, accent }) => (
    <div className="tvk"><div className="tvl">{label}</div><div className="tvv" style={accent ? { color: accent } : {}}>{f1(v)}<span> MW</span></div>{sub && <div className="tvs">{sub}</div>}</div>
  );
  return (
    <main className="tv">
      <div className="tvhead">
        <div className="tvbrand"><img src="/lec-logo.png" alt="LEC" width={44} height={44} /><span><b>Mount Coffee Solar</b> · 21.17 MWp · export limit 16.64 MW</span></div>
        <div>{clock.toISOString().slice(11, 19)} UTC · data {age === null ? "—" : `${age} min old`}</div>
      </div>
      <div className="tvgrid">
        <Big label="Now" v={f?.p_now ?? live.plant?.p_mw} sub={`${live.inverters?.filter((i) => i.online).length ?? "—"} of 52 inverters`} accent="#e6edf3" />
        <Big label="+15 min" v={f?.p15} accent="#f5a524" />
        <Big label="+30 min" v={f?.p30} accent="#f5a524" />
        <Big label="+60 min" v={f?.p60} accent="#f5a524" />
        <div className="tvk"><div className="tvl">Energy today</div><div className="tvv">{f1(today?.mwh)}<span> MWh</span></div><div className="tvs">forecast {f1(todayFc?.newMwh)} MWh</div></div>
      </div>
      <div className="tvchart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
            <XAxis dataKey="x" type="number" scale="time" domain={[from, to]} tickFormatter={hhmm} stroke="#8b98a8" fontSize={16} ticks={Array.from({ length: 14 }, (_, i) => ms(day + "T06:00:00Z") + i * 3600000)} />
            <YAxis stroke="#8b98a8" fontSize={16} width={50} domain={[0, 18]} />
            <ReferenceLine x={Date.now()} stroke="#3fb6c9" />
            <Area data={hourly} dataKey="band" stroke="none" fill="#f5a524" fillOpacity={0.15} isAnimationActive={false} />
            <Line data={hourly} dataKey="nwp" stroke="#f5a524" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line data={best} dataKey="best" stroke="#3fb950" strokeWidth={4} dot={false} isAnimationActive={false} />
            <Line data={actual} dataKey="act" stroke="#e6edf3" strokeWidth={3} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="tvlegend"><span style={{ color: "#e6edf3" }}>━ actual</span><span style={{ color: "#3fb950" }}>━ best estimate, next 6 h</span><span style={{ color: "#f5a524" }}>━ weather models + range</span></div>
      <div className="tvalerts">{alerts.length ? alerts.slice(0, 3).map((a, i) => <div key={i} className="tva">⚠ {a}</div>) : <div className="tvok">No alerts</div>}</div>
    </main>
  );
}
