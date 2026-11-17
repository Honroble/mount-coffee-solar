import { runAgent, agentConfigured } from "@/lib/agent/run";
import { SOURCE_URL } from "@/lib/live";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// A colleague's copy (MCSOLAR_SOURCE_URL set, no key of its own) asks the forecast PC's agent.
async function proxy(req, body) {
  const r = await fetch(`${SOURCE_URL}/api/agent`, { method: req ? "POST" : "GET", headers: { "content-type": "application/json" },
    body: req ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(240000) });
  return Response.json(await r.json(), { status: r.status });
}

export async function GET() {
  if (!agentConfigured() && SOURCE_URL) { try { return await proxy(null); } catch { /* fall through */ } }
  return Response.json({ configured: agentConfigured(), model: process.env.MCSOLAR_AGENT_MODEL || "claude-sonnet-5-5" });
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  if (!agentConfigured() && SOURCE_URL) {
    try { return await proxy(req, body); } catch (e) { return Response.json({ error: `Forecast PC not reachable: ${e.message}` }, { status: 502 }); }
  }
  const mode = ["chat", "report", "investigate"].includes(body.mode) ? body.mode : "chat";
  let messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content) : [];
  if (mode === "investigate") messages = [{ role: "user", content: `Alert (${body.kind || "alert"}) at ${body.time || new Date().toISOString()}:\n${body.text || ""}` }];
  if (mode === "report") messages = [{ role: "user", content: body.period === "morning" ? "Write the morning report: yesterday's production and today's outlook." : "Write the evening report for today." }];
  if (!messages.length || messages.at(-1).role !== "user") return Response.json({ error: "no question" }, { status: 400 });
  try {
    return Response.json(await runAgent({ messages, mode, period: body.period }));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 503 });
  }
}
