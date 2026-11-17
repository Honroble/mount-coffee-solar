"use client";
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";

const tip = { contentStyle: { background: "#171e26", border: "1px solid #263241", fontSize: 12 }, labelStyle: { color: "#e6edf3" } };
const hh = (h) => `${String(h).padStart(2, "0")}:00`;

// Highest 1-minute output in each hour of a day, against the typical (median) and record peak for that hour.
export default function HourlyPeak() {
  const [data, setData] = useState(null);
  const [date, setDate] = useState(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/hourly", { cache: "no-store" });
        if (r.ok && !stop) setData(await r.json());
      } catch { /* keep the last values */ }
    };
    tick();
    const id = setInterval(tick, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  const dates = useMemo(() => (data ? Object.keys(data.byDate).sort().reverse() : []), [data]);
  const day = date ?? dates[0];
  const rows = useMemo(() => {
    if (!data || !day) return [];
    const got = new Map((data.byDate[day] || []).map((r) => [r.h, r]));
    return (data.profile || []).filter((p) => p.h >= 6 && p.h <= 18).map((p) => ({
      label: hh(p.h), h: p.h, peak: got.get(p.h)?.peak ?? null, at: got.get(p.h)?.at ?? null, mwh: got.get(p.h)?.mwh ?? null,
      median: p.median, record: p.record, recordDate: p.recordDate,
    }));
  }, [data, day]);
  const top = rows.reduce((a, b) => ((b.peak ?? -1) > (a?.peak ?? -1) ? b : a), null);
  const topE = rows.reduce((a, b) => ((b.mwh ?? -1) > (a?.mwh ?? -1) ? b : a), null);
  const today = data?.now?.slice(0, 10);
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Hourly peak</h2>
          <div className="sub">Highest 1-minute output in each hour (GMT), against the typical day (median of normal days) and the record for that hour.</div>
        </div>
        <select className="btn" value={day || ""} onChange={(e) => setDate(e.target.value)}>
          {dates.map((d) => <option key={d} value={d}>{d}{d === today ? " (today)" : ""}</option>)}
        </select>
      </div>
      <div className="grid kpis" style={{ marginBottom: 8 }}>
        <div className="kpi"><div className="label">Peak of the day</div><div className="value">{top?.peak != null ? top.peak.toFixed(2) : "—"}<span style={{ fontSize: 14, color: "#8b98a8" }}> MW</span></div>
          <div className="note">{top?.at ? `at ${top.at} GMT` : ""}</div></div>
        <div className="kpi"><div className="label">Best hour (energy)</div><div className="value">{topE?.mwh != null ? topE.mwh.toFixed(1) : "—"}<span style={{ fontSize: 14, color: "#8b98a8" }}> MWh</span></div>
          <div className="note">{topE?.mwh != null ? `${topE.label}–${hh(topE.h + 1)} GMT` : ""}</div></div>
        <div className="kpi"><div className="label">Hours at export limit</div><div className="value">{rows.filter((r) => (r.peak ?? 0) >= 16.5).length}</div>
          <div className="note">peak ≥ 16.5 MW (limit 16.64 MW)</div></div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={rows} margin={{ top: 6, right: 12, left: -8, bottom: 0 }}>
          <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
          <XAxis dataKey="label" tick={{ fill: "#8b949e", fontSize: 11 }} />
          <YAxis domain={[0, 18]} tick={{ fill: "#8b949e", fontSize: 11 }} unit=" MW" width={56} />
          <Tooltip {...tip} formatter={(v, n, p) => (v == null ? ["—", n] : n === "Peak" ? [`${Number(v).toFixed(2)} MW${p.payload.at ? ` at ${p.payload.at}` : ""} · ${p.payload.mwh?.toFixed(1)} MWh in the hour`, n]
            : n === "Record" ? [`${Number(v).toFixed(2)} MW (${p.payload.recordDate})`, n] : [`${Number(v).toFixed(2)} MW`, n])} labelFormatter={(l) => `${l}–${hh(Number(l.slice(0, 2)) + 1)} GMT`} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="peak" name="Peak" fill="#f0b429" isAnimationActive={false} barSize={22} />
          <Line dataKey="median" name="Typical day" stroke="#58a6ff" dot={false} strokeWidth={2} isAnimationActive={false} />
          <Line dataKey="record" name="Record" stroke="#8b949e" strokeDasharray="4 3" dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </section>
  );
}
