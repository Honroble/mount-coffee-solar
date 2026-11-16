import Dashboard from "./Dashboard";
import { summary, daily, accuracy, inverters, frequency, replayDates, replayDay } from "@/lib/history";
import { getLive } from "@/lib/live";

export const dynamic = "force-dynamic";

export default async function Page() {
  const s = summary();
  const lastDate = replayDates.at(-1);
  return (
    <Dashboard
      summary={s} daily={daily} accuracy={accuracy} inverterHealth={inverters} frequency={frequency}
      replayDates={replayDates} initialReplay={{ date: lastDate, rows: replayDay(lastDate) }}
      initialLive={await getLive()}
    />
  );
}
