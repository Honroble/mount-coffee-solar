import Dashboard from "./Dashboard";
import { summary, daily, inverters, frequency, replayDates, replayDay, energySinceCommissioning } from "@/lib/history";
import { getLive } from "@/lib/snapshot";
import { summaryAll, liveScore } from "@/lib/summary";
import { dailyEnergy, frequencyDays, inverterHealth } from "@/lib/liveHistory";

export const dynamic = "force-dynamic";

export default async function Page() {
  let s, score = null;
  try { s = summaryAll(); } catch { s = null; }
  if (!s) {   // no live folder: history only
    const h = summary();
    s = { ...h, missing: [], partial: [], normal_days: h.days, peak_mw: null, peak_day: "", best_hour: null };
  }
  try { score = liveScore(); } catch { score = null; }
  let dailyRows = daily, freqRows = frequency, inv = { rows: inverters, live_range: null, live_days: 0 };
  try { dailyRows = dailyEnergy(); } catch { /* history only */ }
  try { freqRows = frequencyDays(); } catch { /* history only */ }
  try { inv = inverterHealth(); } catch { /* history only */ }
  const lastDate = replayDates.at(-1);
  return (
    <Dashboard
      summary={s} liveScore={score} daily={dailyRows} energyAll={energySinceCommissioning()} inverterHealth={inv} frequency={freqRows}
      replayDates={replayDates} initialReplay={{ date: lastDate, rows: replayDay(lastDate) }}
      initialLive={await getLive()}
    />
  );
}
