import { runAgent, agentConfigured } from "@/lib/agent/run";
import { quickAnswer, quickReport, quickContext, quickWeekly, TOPICS } from "@/lib/agent/quick";
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
  return Response.json({ configured: agentConfigured(), model: process.env.MCSOLAR_AGENT_MODEL || "claude-sonnet-5-5", topics: TOPICS });
}

export async function POST(req) {
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  if (!agentConfigured() && SOURCE_URL) {
    try { return await proxy(req, body); } catch (e) { return Response.json({ error: `Forecast PC not reachable: ${e.message}` }, { status: 502 }); }
  }
  const mode = ["chat", "report", "weekly", "investigate"].includes(body.mode) ? body.mode : "chat";
  // Free answers (no AI): quick topics always; reports and alert facts when no API key is set
  try {
    if (body.topic) return Response.json({ answer: await quickAnswer(body.topic), free: true });
    if (!agentConfigured() && mode === "report") return Response.json({ answer: await quickReport(body.period), free: true });
    if (!agentConfigured() && mode === "weekly") return Response.json({ answer: quickWeekly(), free: true });
    if (!agentConfigured() && mode === "investigate") return Response.json({ answer: await quickContext(), free: true });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
  if (!agentConfigured()) return Response.json({ error: "Free mode: typed questions need the paid AI (setup_agent.ps1). Use the quick buttons for live status, today, forecast, inverters, alerts and health.", free: true }, { status: 503 });
  let messages = Array.isArray(body.messages) ? body.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content) : [];
  if (mode === "weekly") messages = [{ role: "user", content: "Write the weekly plant review for the last 7 days." }];
  if (mode === "investigate") messages = [{ role: "user", content: `Alert (${body.kind || "alert"}) at ${body.time || new Date().toISOString()}:\n${body.text || ""}` }];
  if (mode === "report") messages = [{ role: "user", content: body.period === "morning" ? "Write the morning report: yesterday's production and today's outlook." : "Write the evening report for today." }];
  if (!messages.length || messages.at(-1).role !== "user") return Response.json({ error: "no question" }, { status: 400 });
  try {
    return Response.json(await runAgent({ messages, mode, period: body.period }));
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 503 });
  }
}
