import Dashboard from "./Dashboard";
import { summary, daily, accuracy, inverters, frequency, replayDates, replayDay, energySinceCommissioning } from "@/lib/history";
import { getLive } from "@/lib/snapshot";
import { summaryAll, liveScore } from "@/lib/summary";

export const dynamic = "force-dynamic";

export default async function Page() {
  let s, score = null;
  try { s = summaryAll(); } catch { s = null; }
  if (!s) {   // no live folder: history only
    const h = summary();
    s = { ...h, missing: [], partial: [], normal_days: h.days, peak_mw: null, peak_day: "", best_hour: null };
  }
  try { score = liveScore(); } catch { score = null; }
  const lastDate = replayDates.at(-1);
  return (
    <Dashboard
      summary={s} liveScore={score} daily={daily} energyAll={energySinceCommissioning()} accuracy={accuracy} inverterHealth={inverters} frequency={frequency}
      replayDates={replayDates} initialReplay={{ date: lastDate, rows: replayDay(lastDate) }}
      initialLive={await getLive()}
    />
  );
}
