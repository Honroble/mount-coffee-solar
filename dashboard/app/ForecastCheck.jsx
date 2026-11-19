"use client";
// Forecast check: is the short-term forecast late (lagging) or biased? Scored the way the model is built: each forecast
// against the mean output over the 15 minutes ending at its target time, from the logger's 1-minute data.
import { useState } from "react";

const f2 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));
const SLOT = { ramp: "Morning ramp (to 10:15)", midday: "Midday (10:15–14:30)", afternoon: "Afternoon (after 14:30)" };

function lagWord(s) {
  if (s === null || s === undefined) return "—";
  if (s <= 0) return "on time";
  if (s <= 5) return `${s} min (normal smoothing)`;
  return `${s} min late`;
}

export default function ForecastCheck({ score }) {
  const [win, setWin] = useState("last7");
  if (!score?.horizons?.length || !score.horizons.some((h) => h.n > 0)) return null;
  const pick = (h) => (win === "last7" ? h.last7 : h.check) || { n: 0 };
  const from = score.from ? new Date(score.from).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "";
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Forecast check: lag and bias</h2>
          <div className="sub">
            Each live forecast against what the plant then produced (mean over the 15 minutes ending at the target time, the
            quantity the model predicts). <b>Best match shift</b>: how far the actual must be moved for the forecast to fit it best;
            0–5 minutes is normal smoothing, more means the forecast is following rather than predicting. <b>Bias</b>: average
            signed miss (negative = too low). <b>Skill</b>: how much better than repeating the last 15 minutes.
          </div>
        </div>
        <select className="btn" value={win} onChange={(e) => setWin(e.target.value)}>
          <option value="last7">Last 7 days</option>
          <option value="all">Since {from}</option>
        </select>
      </div>
      <table className="tbl">
        <thead>
          <tr><th>Horizon</th><th style={{ textAlign: "right" }}>Forecasts</th><th style={{ textAlign: "right" }}>Error (MAE)</th>
            <th style={{ textAlign: "right" }}>Repeat-last</th><th style={{ textAlign: "right" }}>Skill</th>
            <th style={{ textAlign: "right" }}>Bias</th><th>Best match shift</th></tr>
        </thead>
        <tbody>
          {score.horizons.map((h) => {
            const s = pick(h);
            const late = s.best_shift_min > 5 && h.horizon_min <= 15;
            return (
              <tr key={h.horizon_min}>
                <td>{h.horizon_min} min</td>
                <td style={{ textAlign: "right" }}>{s.n || 0}</td>
                <td style={{ textAlign: "right" }}>{f2(s.mae_mw)} MW</td>
                <td style={{ textAlign: "right" }}>{f2(s.persistence_mae_mw)} MW</td>
                <td style={{ textAlign: "right" }} className={s.skill_pct < 0 ? "bad-text" : ""}>{s.skill_pct ?? "—"}{s.skill_pct !== null && s.skill_pct !== undefined ? " %" : ""}</td>
                <td style={{ textAlign: "right" }} className={Math.abs(s.bias_mw) > 0.5 ? "warn-text" : ""}>{f2(s.bias_mw)} MW</td>
                <td className={late ? "warn-text" : ""}>{s.n ? lagWord(s.best_shift_min) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 10, marginBottom: 4 }}>Bias by time of day (target time, GMT)</div>
      <table className="tbl">
        <thead>
          <tr><th>Period</th>{score.horizons.map((h) => <th key={h.horizon_min} style={{ textAlign: "right" }}>{h.horizon_min} min: error / bias</th>)}</tr>
        </thead>
        <tbody>
          {["ramp", "midday", "afternoon"].map((sl) => (
            <tr key={sl}>
              <td>{SLOT[sl]}</td>
              {score.horizons.map((h) => {
                const x = (pick(h).slots || []).find((y) => y.slot === sl);
                return <td key={h.horizon_min} style={{ textAlign: "right" }} className={x && Math.abs(x.bias_mw) > 1 ? "warn-text" : ""}>
                  {x && x.n ? `${f2(x.mae_mw)} / ${x.bias_mw > 0 ? "+" : ""}${f2(x.bias_mw)} MW` : "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sub" style={{ marginTop: 8 }}>
        A bias seen over a few days is often just the weather of those days: over the two months of testing the bias in every period
        was within ±0.25 MW. Act on a bias only if it lasts for weeks. The Forecast verification section below scores a slightly different set of forecasts (its own daylight and data-gap rules), so its figures can differ a little from these.
      </div>
    </section>
  );
}
