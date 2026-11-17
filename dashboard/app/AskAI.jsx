"use client";
import { useEffect, useRef, useState } from "react";

const EXAMPLES = [
  "Why did output drop this morning?",
  "How much will we produce this afternoon?",
  "How good was the forecast today?",
  "Are any inverters not producing?",
  "Compare today with yesterday",
];

// Floating "Ask AI" button and chat panel. Questions go to /api/agent on the forecast PC (read-only tools).
export default function AskAI() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef(null);

  useEffect(() => {
    try { const s = sessionStorage.getItem("mcsolar-ai"); if (s) setMsgs(JSON.parse(s)); } catch { /* none */ }
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem("mcsolar-ai", JSON.stringify(msgs.slice(-30))); } catch { /* storage off */ }
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);
  useEffect(() => {
    if (open && !status) fetch("/api/agent").then((r) => r.json()).then(setStatus).catch(() => setStatus({ configured: false }));
  }, [open, status]);

  async function quick(topic, label) {
    if (busy) return;
    const history = [...msgs, { role: "user", content: label, quick: true }];
    setMsgs(history); setBusy(true);
    try {
      const r = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic }) });
      const j = await r.json();
      setMsgs([...history, j.error ? { role: "assistant", content: j.error, error: true } : { role: "assistant", content: j.answer, quick: true }]);
    } catch (e) {
      setMsgs([...history, { role: "assistant", content: `Could not reach the dashboard: ${e.message}`, error: true }]);
    } finally { setBusy(false); }
  }

  async function ask(text) {
    const question = (text ?? q).trim();
    if (!question || busy) return;
    const history = [...msgs, { role: "user", content: question }];
    setMsgs(history); setQ(""); setBusy(true);
    try {
      const r = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: history.filter((m) => !m.error && !m.quick).map(({ role, content }) => ({ role, content })) }) });
      const j = await r.json();
      setMsgs([...history, j.error ? { role: "assistant", content: j.error, error: true } : { role: "assistant", content: j.answer, tools: j.tools }]);
    } catch (e) {
      setMsgs([...history, { role: "assistant", content: `Could not reach the assistant: ${e.message}`, error: true }]);
    } finally { setBusy(false); }
  }

  return (
    <>
      <button className="ai-fab" onClick={() => setOpen((o) => !o)} title="Ask the Mount Coffee AI assistant">{open ? "×" : "Assistant"}</button>
      {open && (
        <div className="ai-panel">
          <div className="ai-head">
            <div><b>Mount Coffee assistant</b><div className="sub">Answers from the live plant data, forecasts and history. Read-only.</div></div>
            {msgs.length > 0 && <button className="btn" onClick={() => setMsgs([])}>Clear</button>}
          </div>
          <div className="ai-body">
            {status && !status.configured && <div className="sub">Free mode: quick answers straight from the plant data. Typed questions need the paid AI (see docs/AI_ASSISTANT.md).</div>}
            <div className="ai-quick">
              {Object.entries(status?.topics || { status: "Status now", today: "Today so far", forecast: "Forecast", inverters: "Inverters", alerts: "Alerts", health: "Plant health" })
                .map(([k, label]) => <button key={k} className="btn" disabled={busy} onClick={() => quick(k, label)}>{label}</button>)}
            </div>
            {status?.configured && !msgs.length && (
              <div className="ai-examples">
                <div className="sub">Try:</div>
                {EXAMPLES.map((e) => <button key={e} className="btn" onClick={() => ask(e)}>{e}</button>)}
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={`ai-msg ${m.role}${m.error ? " err" : ""}${m.quick && m.role === "assistant" ? " mono" : ""}`}>
                {m.content}
                {m.tools?.length > 0 && <div className="ai-tools">looked at: {[...new Set(m.tools)].map((t) => t.replace(/^get_/, "").replaceAll("_", " ")).join(", ")}</div>}
              </div>
            ))}
            {busy && <div className="ai-msg assistant"><span className="ai-dots">Reading the plant data</span></div>}
            <div ref={end} />
          </div>
          {status?.configured && <form className="ai-input" onSubmit={(e) => { e.preventDefault(); ask(); }}>
            <textarea rows={2} value={q} placeholder="Ask about output, forecasts, weather, inverters…" onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }} />
            <button className="btn primary" disabled={busy || !q.trim()}>Send</button>
          </form>}
        </div>
      )}
    </>
  );
}
