"use client";
// Dispatch banner: fast solar drop (WATCH / ALARM / TRIP) and the reserve to hold for the current sky.
// Polls /api/ramp every 15 s. ALARM and TRIP beep once when they start (the browser allows sound after the page has
// been clicked once; the control-room screen should be clicked after it is opened). Decision support only.
import { useEffect, useRef, useState } from "react";

const STYLE = {
  watch: { background: "#3d2f00", border: "1px solid #d29922", color: "#f2cc60" },
  alarm: { background: "#4a1210", border: "1px solid #f85149", color: "#ffb1aa" },
  trip: { background: "#6e0b0b", border: "2px solid #ff6b6b", color: "#ffffff" },
};
const LABEL = { watch: "WATCH", alarm: "ALARM", trip: "PLANT TRIP?" };
const SKY = { steady: "steady", moderate: "moderate swings", variable: "variable – big drops possible" };

function beep(times) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.45;
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.start(t); o.stop(t + 0.36);
    }
  } catch { /* no sound available */ }
}

export default function RampBanner({ big = false, showReserve = true }) {
  const [s, setS] = useState(null);
  const last = useRef("none");
  useEffect(() => {
    let stop = false;
    const load = () => fetch("/api/ramp", { cache: "no-store" }).then((r) => r.json()).then((j) => {
      if (stop) return;
      setS(j);
      const lv = j.stale ? "none" : j.shown_level || "none";
      if ((lv === "alarm" || lv === "trip") && lv !== last.current) beep(lv === "trip" ? 4 : 2);
      last.current = lv;
    }).catch(() => {});
    load();
    const id = setInterval(load, 15000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  if (!s || s.missing) return null;
  const lv = s.stale ? "none" : s.shown_level || "none";
  const reserve = !s.stale && s.reserve_mw !== null && s.reserve_mw !== undefined && s.pv_mw > 2;
  if (lv === "none" && !(showReserve && reserve)) return null;
  const fs = big ? 22 : 14;
  if (lv === "none") {
    return (
      <div className="rampinfo" style={{ fontSize: big ? 18 : 13, padding: big ? "8px 14px" : "6px 12px", margin: "0 0 10px", borderRadius: 6, background: "#14202c", border: "1px solid #263241", color: "#c9d1d9" }}>
        Sky {SKY[s.sky] || s.sky} (swing {s.swing30_mw} MW in 30 min) · hold about <b>{s.reserve_mw} MW</b> reserve against solar ({s.reserve_pct} % of {s.pv_mw} MW)
      </div>
    );
  }
  return (
    <div role="alert" style={{ ...STYLE[lv], fontSize: fs, padding: big ? "12px 16px" : "8px 12px", margin: "0 0 10px", borderRadius: 6 }}>
      <b>⚠ {LABEL[lv]}</b> · {s.shown_message}
      {reserve && <span> · sky {SKY[s.sky] || s.sky}: hold about <b>{s.reserve_mw} MW</b> reserve against solar</span>}
      <div style={{ fontSize: big ? 14 : 11, opacity: 0.85, marginTop: 2 }}>Decision support – the dispatcher decides. Started {String(s.held?.started || "").slice(11, 16)} GMT; clears after 15 min without a new drop.</div>
    </div>
  );
}
