"use client";
import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";

// Forecast verification (forecast/live/verify.py): sealed records, scores against the logger, day by day, reports.
const tip = { contentStyle: { background: "#171e26", border: "1px solid #263241", fontSize: 12 }, labelStyle: { color: "#e6edf3" } };
const f = (v, d = 2) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
const signed = (v, d = 2) => (v === null || v === undefined ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
const SKIES = ["sunny", "mixed", "cloudy"];
const STATUS = { scored: "", partial: "warn-text", excluded: "bad-text", today: "" };

function Kpi({ label, value, unit, note, warn }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}{unit && <span style={{ fontSize: 14, color: "#8b98a8" }}> {unit}</span>}</div>
      {note && <div className={`note ${warn ? "warn-text" : ""}`}>{note}</div>}
    </div>
  );
}

function skillText(o, refs) {
  const parts = Object.entries(o?.refs || {}).map(([k, r]) => `${f(r.skill_pct, 0)} % vs ${refs?.[k] || k}`);
  return parts.length ? parts.join(" · ") : "—";
}

function rel(p, o) {
  return p.unit === "MW" ? `${f(o.nmae_pct, 1)} %` : `${f(o.mae_pct_of_actual, 1)} % of actual`;
}

export default function VerificationSection() {
  const [data, setData] = useState(null);
  const [key, setKey] = useState("st15");
  useEffect(() => {
    let stop = false;
    const load = () => fetch("/api/verification", { cache: "no-store" }).then((r) => r.json()).then((j) => !stop && setData(j)).catch(() => {});
    load();
    const id = setInterval(load, 600000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  const products = data?.products || [];
  const byKey = Object.fromEntries(products.map((p) => [p.key, p]));
  const sel = byKey[key] || products[0];
  const hours = useMemo(() => {
    if (!sel?.by_hour) return [];
    const ref = Object.keys(sel.overall?.refs || {})[0];
    return Object.entries(sel.by_hour).map(([h, o]) => ({ h: `${String(h).padStart(2, "0")}:00`, mae: o.mae, baseline: o.refs?.[ref]?.mae ?? null, n: o.n }));
  }, [sel]);
  if (!data) return null;
  if (data.missing) {
    return (
      <section className="panel" id="verification">
        <h2>Forecast verification</h2>
        <div className="empty">Not computed yet: verify.py runs once an hour with the alerts task (or run python live\verify.py --config live\config.json).</div>
      </section>
    );
  }
  const I = data.integrity || {};
  const refName = Object.keys(sel?.overall?.refs || {})[0];
  const tile = (k, title, extra) => {
    const p = byKey[k]; const o = p?.overall || {};
    if (!o.n) return <Kpi label={title} value="—" note="no scored forecasts yet" />;
    return <Kpi label={title} value={f(o.mae, p.unit === "MWh" ? 1 : 2)} unit={p.unit} warn={p.provisional}
      note={`${extra(o)} · ${o.days} day${o.days === 1 ? "" : "s"}${p.provisional ? ` · provisional until ${p.min_days} days` : ""}`} />;
  };
  const days = [...(data.days || [])].reverse();
  return (
    <section className="panel" id="verification">
      <div className="panel-head">
        <div>
          <h2>Forecast verification</h2>
          <div className="sub">
            Every forecast is logged when it is issued and each finished day is sealed with a hash chain, so the record cannot be changed afterwards
            without it showing here. Each forecast is then scored against the logger. Bias = forecast − actual (+ means too high). Skill = how much smaller
            the error is than a simple reference. Updated {data.generated_utc?.slice(0, 16).replace("T", " ")} GMT · {data.period?.from} to {data.period?.to}.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(data.reports || []).slice(-6).reverse().map((m) => (
            <a key={m} className="btn" href={`/api/verification?report=${m}`}>Report {m}</a>
          ))}
        </div>
      </div>

      <div className="check" style={{ marginBottom: 12 }}>
        <span className="dot" style={{ background: I.status === "ok" ? "#3fb950" : "#f85149" }} />
        <div>
          <b>{I.status === "ok" ? "Forecast records intact" : "Forecast records changed after sealing"}</b>
          <div className="sub" style={{ color: "#c9d1d9" }}>
            {I.sealed_days ? `${I.sealed_days} days sealed (${I.first_sealed} to ${I.last_sealed}; sealing began ${I.first_sealed_utc} GMT). Latest chain hash ${I.last_chain_sha256?.slice(0, 16)}…, copied to the Google Sheet tab VerificationLedger.`
              : "No day sealed yet: the first day is sealed an hour after it ends."}
            {(I.issues || []).map((x) => <div key={x} className="bad-text">{x}</div>)}
          </div>
        </div>
      </div>

      <div className="grid kpis">
        {tile("st15", "15 min ahead, MAE", (o) => `${f(o.refs?.persistence?.skill_pct, 0)} % better than repeat-last`)}
        {tile("st60", "60 min ahead, MAE", (o) => `${f(o.refs?.persistence?.skill_pct, 0)} % better than repeat-last`)}
        {tile("nwp_h_dayahead", "Hourly, day-ahead, MAE", (o) => `${f(o.coverage_pct, 0)} % inside range`)}
        {tile("daily_dayahead", "Daily energy, day-ahead, MAE", (o) => `bias ${signed(o.bias, 1)} MWh · ${f(o.coverage_pct, 0)} % inside range`)}
      </div>

      <div style={{ marginTop: 12, overflowX: "auto" }}>
        <table>
          <thead><tr><th>Forecast</th><th className="num">Days</th><th className="num">Samples</th><th className="num">MAE</th><th className="num">MAE relative</th>
            <th className="num">Bias</th><th>Skill</th><th className="num">Inside range</th><th>Status</th></tr></thead>
          <tbody>
            {products.filter((p) => p.overall?.n).map((p) => {
              const o = p.overall;
              return (
                <tr key={p.key} onClick={() => setKey(p.key)} style={{ cursor: "pointer", background: p.key === sel?.key ? "#1c2632" : undefined }}>
                  <td>{p.label}</td><td className="num">{o.days}</td><td className="num">{o.n}</td>
                  <td className="num">{f(o.mae, p.unit === "MWh" ? 1 : 2)} {p.unit}</td><td className="num">{rel(p, o)}</td>
                  <td className={`num ${Math.abs(o.bias) > (p.unit === "MWh" ? 5 : 0.5) ? "warn-text" : ""}`}>{signed(o.bias, p.unit === "MWh" ? 1 : 2)}</td>
                  <td>{skillText(o, data.references)}</td>
                  <td className="num">{o.coverage_pct === undefined ? "—" : `${f(o.coverage_pct, 0)} %`}</td>
                  <td className={p.provisional ? "warn-text" : ""}>{p.provisional ? `provisional (${o.days}/${p.min_days} days)` : "established"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sub">MAE relative: % of the 17.79 MWac rating (MW forecasts) or of the actual daily energy. Inside range: share of actuals within the forecast&apos;s low–high range; about 80 % is the aim. Click a row for its breakdown.</div>

      {sel && (
        <div className="grid two" style={{ marginTop: 12 }}>
          <div>
            <h3 style={{ margin: "4px 0", fontSize: 14 }}>{sel.label}: by sky type</h3>
            <table>
              <thead><tr><th>Sky</th><th className="num">Days</th><th className="num">MAE</th><th className="num">Bias</th><th className="num">Skill</th><th className="num">Inside range</th></tr></thead>
              <tbody>
                {SKIES.filter((s) => sel.by_sky?.[s]?.n).map((s) => {
                  const o = sel.by_sky[s];
                  return <tr key={s}><td>{s}</td><td className="num">{o.days}</td><td className="num">{f(o.mae)} {sel.unit}</td><td className="num">{signed(o.bias)}</td>
                    <td className="num">{refName && o.refs?.[refName] ? `${f(o.refs[refName].skill_pct, 0)} %` : "—"}</td>
                    <td className="num">{o.coverage_pct === undefined ? "—" : `${f(o.coverage_pct, 0)} %`}</td></tr>;
                })}
              </tbody>
            </table>
            <div className="sub">Sky type of a day = its energy ÷ clear-sky potential: sunny ≥ {data.rules?.sky_classes?.sunny}, mixed ≥ {data.rules?.sky_classes?.mixed}, cloudy below.</div>
            {sel.by_month && Object.keys(sel.by_month).length > 0 && (
              <>
                <h3 style={{ margin: "12px 0 4px", fontSize: 14 }}>By month</h3>
                <table>
                  <thead><tr><th>Month</th><th className="num">Days</th><th className="num">MAE</th><th className="num">Bias</th><th className="num">Skill</th></tr></thead>
                  <tbody>
                    {Object.entries(sel.by_month).map(([m, o]) => (
                      <tr key={m}><td>{m}</td><td className="num">{o.days}</td><td className="num">{f(o.mae)} {sel.unit}</td><td className="num">{signed(o.bias)}</td>
                        <td className="num">{refName && o.refs?.[refName] ? `${f(o.refs[refName].skill_pct, 0)} %` : "—"}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
          <div>
            {hours.length > 0 ? (
              <>
                <h3 style={{ margin: "4px 0", fontSize: 14 }}>By hour of day (GMT): MAE against {data.references?.[refName] || "the reference"}</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={hours} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="#263241" strokeDasharray="3 3" />
                    <XAxis dataKey="h" stroke="#8b98a8" fontSize={11} />
                    <YAxis stroke="#8b98a8" fontSize={11} width={56} unit=" MW" />
                    <Tooltip {...tip} formatter={(v, n) => [`${Number(v).toFixed(2)} MW`, n]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="mae" name="Forecast" fill="#f5a524" isAnimationActive={false} />
                    <Bar dataKey="baseline" name={data.references?.[refName] || "Reference"} fill="#4b5a6c" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </>
            ) : <div className="sub">No hour-of-day breakdown for daily energy.</div>}
          </div>
        </div>
      )}

      <h3 style={{ margin: "16px 0 4px", fontSize: 14 }}>Day by day</h3>
      <div className="scroll" style={{ maxHeight: 320 }}>
        <table>
          <thead><tr><th>Date</th><th className="num">Actual MWh</th><th>Sky</th><th className="num">Day-ahead</th><th className="num">Range</th><th className="num">Miss</th>
            <th className="num">15-min MAE</th><th className="num">60-min MAE</th><th className="num">Hourly MAE</th><th>Status / cause</th></tr></thead>
          <tbody>
            {days.map((d) => {
              const da = d.daily_dayahead;
              const none = !da && !d.daily_sameday && d.st15_mae === null && d.st60_mae === null && d.nwp_h_dayahead_mae === null;
              return (
                <tr key={d.date}>
                  <td>{d.date}</td><td className="num">{f(d.actual_mwh, 1)}</td><td>{d.sky || "—"}</td>
                  <td className="num">{da ? f(da.f, 1) : "—"}</td>
                  <td className={`num ${da && da.in_range === false ? "warn-text" : ""}`}>{da && da.low !== null ? `${f(da.low, 0)}–${f(da.high, 0)}` : "—"}</td>
                  <td className={`num ${d.cause ? "bad-text" : ""}`}>{da ? signed(da.miss, 1) : "—"}</td>
                  <td className="num">{f(d.st15_mae)}</td><td className="num">{f(d.st60_mae)}</td><td className="num">{f(d.nwp_h_dayahead_mae)}</td>
                  <td className={STATUS[d.status] || ""}>{d.status === "scored" ? (d.cause || (none ? "no forecasts logged" : "scored")) : `${d.status}${d.reason ? ` – ${d.reason}` : ""}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="sub">
        Not scored: outage and curtailment days (the forecast is for the plant running freely). Data-gap days are scored where data exists, but not their daily energy.
        Big misses (daily ≥ {data.rules?.big_daily_mwh} MWh and ≥ {Math.round((data.rules?.big_daily_frac || 0) * 100)} % of the day) carry a cause.
      </div>
    </section>
  );
}
