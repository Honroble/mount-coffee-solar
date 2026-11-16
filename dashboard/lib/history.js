// Results from the 17 Sep - 13 Nov 2026 logger exports (built by build_dash_data.py).
import replay15 from "@/data/history/replay15.json";
import daily from "@/data/history/daily.json";
import accuracy from "@/data/history/accuracy.json";
import inverters from "@/data/history/inverters.json";
import frequency from "@/data/history/frequency.json";

export { replay15, daily, accuracy, inverters, frequency };

export function summary() {
  const energy = daily.reduce((s, d) => s + (d.energy_mwh || 0), 0);
  const normal = daily.filter((d) => d.status === "Normal");
  const avg = normal.reduce((s, d) => s + d.energy_mwh, 0) / normal.length;
  const best = daily.reduce((a, b) => (b.energy_mwh > a.energy_mwh ? b : a));
  const a15 = accuracy.find((a) => a.horizon_min === 15);
  const hz = frequency.map((f) => f.median_hz).sort((a, b) => a - b);
  return {
    days: daily.length, first: daily[0].date, last: daily.at(-1).date,
    energy_mwh: Math.round(energy), avg_day_mwh: +avg.toFixed(1),
    best_day: best.date, best_mwh: best.energy_mwh,
    mae15: a15.with_satellite_mae_mw, persist15: a15.persistence_mae_mw,
    median_hz: hz[Math.floor(hz.length / 2)],
  };
}

export function replayDay(date) {
  return replay15.filter((r) => r.date === date);
}
export const replayDates = [...new Set(replay15.map((r) => r.date))];
