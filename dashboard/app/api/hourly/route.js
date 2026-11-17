import { hourlyByDate, hourlyProfile } from "@/lib/summary";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET() {
  if (SOURCE_URL) {
    try {
      const r = await fetch(`${SOURCE_URL}/api/hourly`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) return Response.json(await r.json(), { headers: { "Cache-Control": "no-store" } });
    } catch { /* fall back to this PC's files */ }
  }
  const byDate = hourlyByDate();
  return Response.json({ byDate, profile: hourlyProfile(byDate), now: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
}
