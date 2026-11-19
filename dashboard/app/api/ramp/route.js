import { getRamp } from "@/lib/ramp";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getRamp(), { headers: { "Cache-Control": "no-store" } });
}
