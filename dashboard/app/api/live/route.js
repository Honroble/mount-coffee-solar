import { liveSnapshot } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(liveSnapshot(), { headers: { "Cache-Control": "no-store" } });
}
