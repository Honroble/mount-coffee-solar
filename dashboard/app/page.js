import Dashboard from "./Dashboard";
import { summary, daily, accuracy, inverters, frequency, replayDates, replayDay } from "@/lib/history";
import { liveSnapshot } from "@/lib/live";

export const dynamic = "force-dynamic";

export default function Page() {
  const s = summary();
  const lastDate = replayDates.at(-1);
  return (
    <Dashboard
      summary={s} daily={daily} accuracy={accuracy} inverterHealth={inverters} frequency={frequency}
      replayDates={replayDates} initialReplay={{ date: lastDate, rows: replayDay(lastDate) }}
      initialLive={liveSnapshot()}
    />
  );
}
