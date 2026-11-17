// Is the data pipeline itself healthy? (collector, portal sign-in, live poller, forecast job). Server side only.
import fs from "fs";
import path from "path";
import { LIVE_DIR } from "@/lib/live";

const read = (f) => { try { return fs.readFileSync(path.join(LIVE_DIR, f), "utf8"); } catch { return null; } };
const ageMin = (t) => (t ? Math.round((Date.now() - t) / 60000) : null);

export function systemStatus(now = new Date()) {
  const problems = [];
  if (!fs.existsSync(LIVE_DIR)) return { problems, checked: now.toISOString(), local: false };
  const h = now.getUTCHours();
  const daytime = h >= 7 && h < 18;
  const log = (read("collector_log.txt") || "").split("\n").slice(-40);
  const since = new Date(now.getTime() - 20 * 60000).toISOString().slice(0, 16).replace("T", " ");
  const bad = log.filter((l) => l.slice(0, 16) >= since && /sign-in failed|invalid login/i.test(l));
  if (bad.length >= 2) problems.push({ id: "portal", text: "The forecast PC cannot sign in to the Gantner portal – data collection has stopped. On the forecast PC run: python live\\check_portal_login.py --try" });
  if (daytime) {
    try {
      const w = JSON.parse(read("widget_now.json"));
      const a = ageMin(Date.parse(w.time_utc));
      if (a > 10) problems.push({ id: "poller", text: `Live 10-second readings stopped ${a} min ago (task "MCSolar Live Now").` });
    } catch { problems.push({ id: "poller", text: "No live 10-second readings (task \"MCSolar Live Now\")." }); }
    const fl = (read("forecast_log.csv") || "").trim().split("\n").at(-1)?.split(",")[0];
    const fa = fl ? ageMin(Date.parse(fl.replace(" ", "T") + ":00Z")) : null;
    if (fa === null || fa > 25) problems.push({ id: "forecast", text: fa === null ? "No forecasts logged yet." : `No new forecast for ${fa} min (task "MCSolar Forecast").` });
    const day = now.toISOString().slice(0, 10).replace(/-/g, "");
    let st = null;
    try { st = fs.statSync(path.join(LIVE_DIR, `iv2_live_${day}.csv`)); } catch { /* none today */ }
    const ca = st ? ageMin(st.mtimeMs) : null;
    if (ca === null || ca > 30) problems.push({ id: "collector", text: ca === null ? "No plant data collected today." : `No plant data collected for ${ca} min (task "MCSolar Collector").` });
  }
  return { problems, checked: now.toISOString(), local: true };
}
