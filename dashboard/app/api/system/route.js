import { systemStatus } from "@/lib/system";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET() {
  if (SOURCE_URL) {
    try {
      const r = await fetch(`${SOURCE_URL}/api/system`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (r.ok) return Response.json(await r.json());
    } catch {
      return Response.json({ problems: [{ id: "source", text: `Cannot reach the forecast PC (${SOURCE_URL}). Check that it is on and on the network.` }] });
    }
  }
  return Response.json(systemStatus(), { headers: { "Cache-Control": "no-store" } });
}
