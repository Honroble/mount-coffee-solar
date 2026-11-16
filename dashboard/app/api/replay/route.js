import { replayDay } from "@/lib/history";
export async function GET(req) {
  const date = new URL(req.url).searchParams.get("date") || "";
  return Response.json(replayDay(date));
}
