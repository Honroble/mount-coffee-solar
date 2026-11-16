import { getLive } from "@/lib/live";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getLive(), { headers: { "Cache-Control": "no-store" } });
}
