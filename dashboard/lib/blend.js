// Best estimate for the next 6 hours: the plant-data forecast for the first hour, then a smooth hand-over to the
// weather models. After +60 min the plant-data forecast's clear-sky index is carried forward (persistence of
// "how cloudy it is now") and its weight decays with a 90-minute time constant; the rest comes from the models.
import { clearSkyGhi } from "@/lib/irradiance";

const MW_PER_WM2 = 0.02063, CS_CAP = 16.9, LIMIT = 16.64, TAU = 90;
const csMw = (t) => Math.min(clearSkyGhi(t) * MW_PER_WM2, CS_CAP);

function nwpAt(hourly, t) {
  // hourly values are plotted at mid-hour: interpolate linearly between them
  const x = t.getTime();
  for (let i = 1; i < hourly.length; i++) {
    const a = hourly[i - 1], b = hourly[i];
    const ta = Date.parse(a.t), tb = Date.parse(b.t);
    if (x >= ta && x <= tb) {
      const f = (x - ta) / (tb - ta);
      return { mw: a.new + f * (b.new - a.new), low: a.low + f * (b.low - a.low), high: a.high + f * (b.high - a.high) };
    }
  }
  return null;
}

export function blend(latest, nwp) {
  if (!latest || !latest.issued) return null;
  const t0 = new Date(latest.issued);
  const hourly = nwp?.forecast?.hourly || [];
  const pts = [];
  const nowcast = [[0, latest.p_now], [15, latest.p15], [30, latest.p30], [60, latest.p60]];
  const kt = latest.p60 != null && latest.cs60 > 0.5 ? latest.p60 / latest.cs60 : null;
  for (let m = 0; m <= 360; m += 15) {
    const t = new Date(t0.getTime() + m * 60000);
    const n = nwpAt(hourly, t);
    let mw = null, src = "";
    const nc = nowcast.find(([mm]) => mm === m);
    if (nc && nc[1] != null) { mw = nc[1]; src = "plant data"; }
    else if (m === 45 && latest.p30 != null && latest.p60 != null) { mw = (latest.p30 + latest.p60) / 2; src = "plant data"; }
    else if (m > 60) {
      const persisted = kt != null ? Math.min(kt * csMw(t), LIMIT) : null;
      const w = persisted != null ? Math.exp(-(m - 60) / TAU) : 0;
      if (n || persisted != null) {
        mw = w * (persisted ?? 0) + (1 - w) * (n ? n.mw : persisted);
        src = w > 0.5 ? "mostly plant data" : "mostly weather models";
      }
    }
    if (mw === null) continue;
    pts.push({ t: t.toISOString(), mw: +Math.max(0, mw).toFixed(2), nwp: n ? +n.mw.toFixed(2) : null, src });
  }
  return { issued: latest.issued, points: pts };
}
