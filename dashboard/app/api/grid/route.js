import { getGrid } from "@/lib/gridlive";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getGrid(), { headers: { "Cache-Control": "no-store" } });
}
