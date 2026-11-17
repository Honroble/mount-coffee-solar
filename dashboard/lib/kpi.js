// Daily KPIs and loss breakdown: history (17 Sep - 13 Nov, built from the logger exports) + days computed on the
// forecast PC by forecast/live/kpi.py (data/live/kpi_daily.json). Server side only.
import fs from "fs";
import path from "path";
import { LIVE_DIR } from "@/lib/live";
import history from "@/data/history/kpi_daily.json";

export function kpiDays() {
  const by = new Map(history.map((r) => [r.date, { ...r, source: "history" }]));
  try {
    for (const r of JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "kpi_daily.json"), "utf8"))) by.set(r.date, { ...r, source: "live" });
  } catch { /* not computed yet on this PC */ }
  return [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

const FULL = 1300; // minutes logged for a full day
const avg = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : null);

export function kpiSummary(days = kpiDays()) {
  const full = days.filter((d) => d.minutes >= FULL);
  const last30 = full.slice(-30);
  const sum = (k) => +last30.reduce((a, d) => a + (d.losses_mwh?.[k] || 0), 0).toFixed(1);
  return {
    last30: {
      days: last30.length, pr: avg(last30.map((d) => d.pr_pct).filter((v) => v != null)),
      pr_temp: avg(last30.map((d) => d.pr_temp_pct).filter((v) => v != null)),
      availability: avg(last30.map((d) => d.availability_pct).filter((v) => v != null)),
      specific_yield: avg(last30.map((d) => d.specific_yield).filter((v) => v != null)),
      losses: { cloud: sum("cloud"), clipping: sum("clipping"), curtailment: sum("curtailment"), plant_outage: sum("plant_outage"), inverters_down: sum("inverters_down"),
        soiling: sum("soiling"), other: sum("other"), actual: sum("actual"), clear_sky: sum("clear_sky") },
    },
  };
}
