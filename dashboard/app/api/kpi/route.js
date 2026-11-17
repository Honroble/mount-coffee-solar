import { kpiDays, kpiSummary } from "@/lib/kpi";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET() {
  if (SOURCE_URL) {
    try {
      const r = await fetch(`${SOURCE_URL}/api/kpi`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) return Response.json(await r.json(), { headers: { "Cache-Control": "no-store" } });
    } catch { /* fall back to this PC's files */ }
  }
  const days = kpiDays();
  return Response.json({ days, summary: kpiSummary(days) }, { headers: { "Cache-Control": "no-store" } });
}
