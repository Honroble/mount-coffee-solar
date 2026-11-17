import { getNow } from "@/lib/now";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getNow(), { headers: { "Cache-Control": "no-store" } });
}
