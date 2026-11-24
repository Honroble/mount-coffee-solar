// The Mount Coffee AI agent: Claude + read-only plant-data tools. Server side only.
// Settings (dashboard/.env.local on the forecast PC):
//   ANTHROPIC_API_KEY   required
//   MCSOLAR_AGENT_MODEL  optional, default claude-sonnet-5-5
//   MCSOLAR_AGENT_DAILY_LIMIT  optional, default 300 questions per day (cost guard)
import fs from "fs";
import path from "path";
import { TOOLS, runTool } from "@/lib/agent/tools";
import { LIVE_DIR } from "@/lib/live";

const API = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
const MODEL = process.env.MCSOLAR_AGENT_MODEL || "claude-sonnet-5-5";
const LIMIT = Number(process.env.MCSOLAR_AGENT_DAILY_LIMIT || 300);
const MAX_ROUNDS = 10;

const BASE = `You are the Mount Coffee Solar assistant for the Liberia Electricity Corporation (LEC) SCADA/EMS team and the control-room operators.
You answer questions about the LEC Mount Coffee PV plant (21.17 MWp DC, 17.79 MWac, export limit 16.64 MW, 52 inverters in STS1-STS4) using the tools, which read the plant's logger data, forecasts, weather station, satellite and weather-model data.
Rules:
- Always get the numbers from the tools; never guess or invent values. If the data is not there, say so plainly.
- All times are GMT (Liberia time). Today is {{TODAY}}; the time now is {{NOW}} GMT.
- You can only read data. You cannot change anything on the plant, logger, inverters or portal; if asked to, say that operators must do it at the plant or in the portal.
- Be brief and practical: operators read this on a screen or a phone. Lead with the answer, give the key numbers with units (MW, MWh, W/m2), then one or two lines of explanation. No long preambles.
- When explaining output drops, compare actual output with irradiance (pyranometers), clear-sky, the forecast and the inverters, and say what is most likely (cloud/rain, curtailment or power limit, inverter trips, grid frequency, data gap).
- Forecast terms: "+15 min" is the mean output over the 15 minutes ending 15 minutes after the forecast was issued. "Repeat-last" means assuming output stays at the last 15-minute average.`;

const MODES = {
  chat: "",
  report: `
Task: write the {{PERIOD}} shift report for the operators, to be sent by e-mail. Use the tools first (live status, today's or yesterday's power series, forecast vs actual, daily energy, hourly peaks, weather outlook, alerts, inverters).
Format: plain text, no markdown tables, max ~250 words. Sections: Summary (2-3 lines), Production, Forecast performance, Equipment & data issues, Outlook / what to watch. Use numbers.`,
  weekly: `
Task: write the weekly plant review for the SCADA/EMS team lead (Julius), to be sent by e-mail. Call get_plant_issues (days 7, and 14 for comparison if useful), get_daily_energy and get_alerts first.
Format: plain text, no markdown tables, max ~400 words. Sections:
1. Week in numbers: energy produced, PR, availability, total estimated losses (MWh and % of potential), split by cause.
2. What got worse / what improved compared with the week before (only if the data covers it; say when it does not).
3. Open contractor issues: one line each for the open issues in the tool result, with what this week's data shows (still occurring / improved / looks fixed / cannot tell) and the number behind it.
4. Grid: trips (count, causes, frequency range, energy lost) - for discussion with NLDC.
5. Top 3 actions for next week, most energy first.
Be factual; all loss numbers are estimates and should be called that.`,
  investigate: `
Task: an alert just fired. Investigate it with the tools (data around the alert time: power series, meteo, inverters, forecast vs actual, live status) and write a short analysis to append to the alert e-mail.
Format: plain text, max ~120 words: "Likely cause:", "Evidence:" (2-4 bullet lines with numbers), "Suggested checks:" (1-3 lines). Be honest about uncertainty.`,
};

function usageFile() { return path.join(LIVE_DIR, "agent_usage.json"); }
function countToday() {
  const day = new Date().toISOString().slice(0, 10);
  let u = { day, n: 0 };
  try { const x = JSON.parse(fs.readFileSync(usageFile(), "utf8")); if (x.day === day) u = x; } catch { /* new day */ }
  return u;
}
function bump(u, tokens) {
  u.n += 1; u.input_tokens = (u.input_tokens || 0) + tokens.in; u.output_tokens = (u.output_tokens || 0) + tokens.out;
  try { fs.writeFileSync(usageFile(), JSON.stringify(u)); } catch { /* read-only folder */ }
}

export function agentConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * messages: [{role:"user"|"assistant", content:string}]  (chat history, last one from the user)
 * mode: "chat" | "report" | "weekly" | "investigate";  period: "morning" | "evening" (reports)
 */
export async function runAgent({ messages, mode = "chat", period = "evening" }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("The AI agent is not set up on this PC yet (no ANTHROPIC_API_KEY). Run dashboard\\setup_agent.ps1.");
  const u = countToday();
  if (u.n >= LIMIT) throw new Error(`Daily limit of ${LIMIT} AI questions reached; it resets at 00:00 GMT.`);
  const now = new Date();
  const system = (BASE + (MODES[mode] ?? "")).replaceAll("{{TODAY}}", now.toISOString().slice(0, 10))
    .replaceAll("{{NOW}}", now.toISOString().slice(11, 16)).replaceAll("{{PERIOD}}", period);
  const convo = messages.slice(-12).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  const used = [];
  const tokens = { in: 0, out: 0 };
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await fetch(`${API}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages: convo }),
      signal: AbortSignal.timeout(90000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`AI service error ${r.status}: ${j?.error?.message || "no details"}`);
    tokens.in += j.usage?.input_tokens || 0; tokens.out += j.usage?.output_tokens || 0;
    convo.push({ role: "assistant", content: j.content });
    const calls = (j.content || []).filter((b) => b.type === "tool_use");
    if (j.stop_reason !== "tool_use" || !calls.length) {
      bump(u, tokens);
      const text = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { answer: text || "(no answer)", tools: used, model: MODEL, usage: tokens };
    }
    const results = [];
    for (const c of calls) {
      used.push(c.name);
      const out = await runTool(c.name, c.input);
      let text = JSON.stringify(out);
      if (text.length > 60000) text = text.slice(0, 60000) + "...(truncated)";
      results.push({ type: "tool_result", tool_use_id: c.id, content: text });
    }
    convo.push({ role: "user", content: results });
  }
  bump(u, tokens);
  return { answer: "I could not finish within the step limit. Please ask a narrower question.", tools: used, model: MODEL, usage: tokens };
}
