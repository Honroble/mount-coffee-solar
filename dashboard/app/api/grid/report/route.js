import { gridReport, gridCsv } from "@/lib/gridreport";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET(req) {
  const csv = new URL(req.url).searchParams.get("format") === "csv";
  if (SOURCE_URL) {
    try {
      const r = await fetch(`${SOURCE_URL}/api/grid/report${csv ? "?format=csv" : ""}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) return new Response(await r.text(), { headers: { "Content-Type": csv ? "text/csv" : "application/json", "Cache-Control": "no-store", ...(csv ? { "Content-Disposition": "attachment; filename=mount_coffee_grid_daily.csv" } : {}) } });
    } catch { /* fall back to local files */ }
  }
  if (csv) return new Response(gridCsv(), { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=mount_coffee_grid_daily.csv", "Cache-Control": "no-store" } });
  return Response.json(gridReport(), { headers: { "Cache-Control": "no-store" } });
}
