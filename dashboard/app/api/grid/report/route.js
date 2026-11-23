import { gridReport, gridCsv, hourlyCsv } from "@/lib/gridreport";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET(req) {
  const fmt = new URL(req.url).searchParams.get("format");
  const csv = fmt === "csv" || fmt === "hourly-csv";
  const fname = fmt === "hourly-csv" ? "mount_coffee_hourly.csv" : "mount_coffee_grid_daily.csv";
  if (SOURCE_URL) {
    try {
      const r = await fetch(`${SOURCE_URL}/api/grid/report${fmt ? `?format=${fmt}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) return new Response(await r.text(), { headers: { "Content-Type": csv ? "text/csv" : "application/json", "Cache-Control": "no-store", ...(csv ? { "Content-Disposition": `attachment; filename=${fname}` } : {}) } });
    } catch { /* fall back to local files */ }
  }
  if (csv) return new Response(fmt === "hourly-csv" ? hourlyCsv() : gridCsv(), { headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename=${fname}`, "Cache-Control": "no-store" } });
  return Response.json(gridReport(), { headers: { "Cache-Control": "no-store" } });
}
