"use client";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";

const COLORS = { ok: "#3fb950", warn: "#d29922", bad: "#f85149", na: "#6b7a8c" };
const hhmm = (t) => new Date(t).toISOString().slice(11, 16);

export default function HealthSection({ live }) {
  const h = live.health;
  if (!h || h.error) return <section className="panel"><h2>Plant health</h2><div className="empty">Not available{h?.error ? `: ${h.error}` : ""}.</div></section>;
  return (
    <section className="panel" id="health">
      <div className="panel-head">
        <div><h2>Plant health</h2><div className="sub">Automatic checks for today. Green = fine, amber = watch, red = act, grey = not enough data yet.</div></div>
      </div>
      <div className="checks">
        {h.checks.map((c) => (
          <div key={c.id} className="check">
            <span className="dot" style={{ background: COLORS[c.state] }} />
            <div><b>{c.label}</b><div className="sub" style={{ color: "#c9d1d9" }}>{c.text}</div></div>
          </div>
        ))}
      </div>
      {h.compare.length > 0 && (
        <>
          <div className="legend" style={{ marginTop: 10 }}>
            <span><i style={{ background: "#e6edf3" }} />Actual (10-min average)</span>
            <span><i style={{ background: "#7aa2f7" }} />Expected from satellite sunlight</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={h.compare} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
              <XAxis dataKey="t" tickFormatter={hhmm} stroke="#8b98a8" fontSize={11} minTickGap={40} />
              <YAxis stroke="#8b98a8" fontSize={11} width={56} unit=" MW" domain={[0, 18]} />
              <Tooltip contentStyle={{ background: "#171e26", border: "1px solid #263241", fontSize: 12 }} labelFormatter={(t) => `${hhmm(t)} GMT`} formatter={(v, n) => [`${Number(v).toFixed(2)} MW`, n]} />
              <Line dataKey="expected" name="Expected" stroke="#7aa2f7" dot={false} isAnimationActive={false} />
              <Line dataKey="actual" name="Actual" stroke="#e6edf3" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
          <div className="sub">Expected = satellite sunlight over the plant × 0.0206 MW per W/m² (the plant's clear-sky ratio), capped at the export limit. The satellite reads high in broken cloud, so only large, lasting gaps matter.</div>
        </>
      )}
    </section>
  );
}
