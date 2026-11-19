// Fast-drop alarms and sky-state reserve written by forecast/live/ramp_watch.py every minute (data/live/ramp_state.json).
import fs from "fs";
import path from "path";
import { LIVE_DIR, SOURCE_URL } from "@/lib/live";

function local() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "ramp_state.json"), "utf8"));
    const ageS = s.time_utc ? Math.round((Date.now() - Date.parse(s.time_utc)) / 1000) : null;
    return { ...s, ageS, stale: ageS === null || ageS > 300 };
  } catch {
    return { shown_level: "none", stale: true, missing: true };
  }
}

export async function getRamp() {
  if (!SOURCE_URL) return local();
  try {
    const r = await fetch(`${SOURCE_URL}/api/ramp`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch {
    return local();
  }
}
