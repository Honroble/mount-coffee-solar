import { verification, verificationReport } from "@/lib/verification";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";

// GET /api/verification               -> verification.json
// GET /api/verification?report=2026-11 -> that month's report (Markdown download)
export async function GET(req) {
  const month = new URL(req.url).searchParams.get("report");
  if (SOURCE_URL) {
    try {
      const r = await fetch(`${SOURCE_URL}/api/verification${month ? `?report=${encodeURIComponent(month)}` : ""}`,
        { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) return new Response(await r.arrayBuffer(), { headers: { "Content-Type": r.headers.get("Content-Type") || "application/json",
        "Content-Disposition": r.headers.get("Content-Disposition") || "", "Cache-Control": "no-store" } });
    } catch { /* fall back to this PC's files */ }
  }
  if (month) {
    const text = verificationReport(month);
    if (!text) return new Response("No report for that month yet.", { status: 404 });
    return new Response(text, { headers: { "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="mount-coffee-forecast-verification-${month}.md"`, "Cache-Control": "no-store" } });
  }
  return Response.json(verification() || { missing: true }, { headers: { "Cache-Control": "no-store" } });
}
