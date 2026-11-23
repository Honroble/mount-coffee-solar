// Plant KPIs per day from the logger's 1-minute files on the forecast PC (read-only):
//   iv1_live_YYYYMMDD.csv  weather: two pyranometers (STS1, STS3; up and down), module and ambient temperature,
//                          WS600 humidity, pressure, wind, rain, DustIQ soiling
//   iv2_live_YYYYMMDD.csv  "Inverter sum P", export setpoint and the 52 inverter powers
//   grid_live_YYYYMMDD.csv 22 kV relay states for the event log (breakers, trips, frequency)
// The "up" pyranometers are used as the plane-of-array reference for PR; this assumes they are mounted at module
// tilt, which should be confirmed on site.
import fs from "fs";
import path from "path";
import { LIVE_DIR } from "@/lib/live";

export const DC_KWP = 21170;
const GAMMA = -0.0035;                 // module power temperature coefficient per °C (typical crystalline; confirm datasheet)
const LIGHT = 50, SUN = 200;           // W/m²: daylight for temperature weighting, sunny for soiling readings

const num = (v) => { const x = Number(v); return v === "" || v === undefined || !Number.isFinite(x) ? null : x; };
const r = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function read(prefix, ymd) {
  const f = path.join(LIVE_DIR, `${prefix}_live_${ymd}.csv`);
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, "latin1").trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const header = lines[0].split(";");
  const rows = new Map();                                   // "HH:MM" -> cells (first occurrence wins)
  for (const l of lines.slice(2)) { const c = l.split(";"); const k = (c[1] || "").slice(0, 5); if (k && !rows.has(k)) rows.set(k, c); }
  return { header, rows, ix: (name) => header.indexOf(name) };
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function plantDay(date) {
  const ymd = date.replace(/-/g, "");
  const w = read("iv1", ymd), p = read("iv2", ymd), g = read("grid", ymd);
  if (!w && !p) return null;
  const W = w && {
    up: ["FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated", "FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated"].map(w.ix),
    dn: ["FPE.PV.STS1.Pyranometer.down.irradiation_temp_compensated", "FPE.PV.STS3.Pyranometer.down.irradiation_temp_compensated"].map(w.ix),
    tmod: w.ix("FPE.PV.STS1.temperature.Temp01 - Module"), tamb: w.ix("FPE.PV.STS1.temperature.Temp02 - Ambient"),
    soil: ["FPE.PV.STS1.DustIQ.soiling_ratio_Sensor01", "FPE.PV.STS1.DustIQ.soiling_ratio_Sensor02"].map(w.ix),
    rh: w.ix("FPE.PV.STS1.WS600.relative_humidity_avg"), pa: w.ix("FPE.PV.STS1.WS600.absolute_air_preassure_avg."),
    ws: w.ix("FPE.PV.STS1.WS600.wind_speed_avg."), wmax: w.ix("FPE.PV.STS1.WS600.wind_speed_max"),
    rain: w.ix("FPE.PV.STS1.WS600.precipitation_intense"), wd: w.ix("FPE.PV.STS1.WS600.wind_direction_compass_corr."),
  };
  const invCols = p ? p.header.map((h, i) => [h, i]).filter(([h]) => /^STS\d\.INV\d+\.active_power_total$/.test(h)) : [];
  const iSet = p ? p.ix("Active Power.Power_Setpoint") : -1;

  let H = 0, Hw = 0, tw = 0, rain = 0, wmax = null, invE = 0, availOk = 0, availAll = 0, limitMin = 0;
  const up1 = [], up2 = [], soil = [], rh = [], pa = [], ws = [], tamb = [], sinW = [], cosW = [];
  const sts = {}, invE1 = {};
  const outage = {}, events = [];
  let tmodMax = null;

  // grid state for events
  const G = g && ["P07 (OUTGOING FEEDER )", "P01 - MVSTS 1..2", "P04 - MVSTS 3..5"].map((k) => ({
    k: k.slice(0, 3), on: g.ix(`${k}.C.B ON`), off: g.ix(`${k}.C.B OFF`), trip: g.ix(`${k}.total number of happened trip`),
    pf: g.ix(`${k}.General Phase Fault`), ef: g.ix(`${k}.General Earth Fault`),
  }));
  const fI = g ? g.ix("P07 (OUTGOING FEEDER ).Frequency") : -1;
  const prev = {}; let fOut = null;

  for (let m = 0; m < 1440; m++) {
    const t = hhmm(m);
    // weather
    let G0 = null;
    const wr = w && w.rows.get(t);
    if (wr) {
      const ups = W.up.map((i) => (i >= 0 ? num(wr[i]) : null));
      if (ups[0] !== null) up1.push(ups[0]); if (ups[1] !== null) up2.push(ups[1]);
      const v = ups.filter((x) => x !== null && x >= 0);
      if (v.length) { G0 = mean(v); H += G0 / 60; }
      const tm = num(wr[W.tmod]);
      if (G0 !== null && tm !== null && G0 > LIGHT) { Hw += G0; tw += G0 * tm; }
      if (tm !== null) tmodMax = tmodMax === null ? tm : Math.max(tmodMax, tm);
      const push = (a, i) => { const x = i >= 0 ? num(wr[i]) : null; if (x !== null) a.push(x); return x; };
      push(tamb, W.tamb); push(rh, W.rh); push(pa, W.pa); push(ws, W.ws);
      const wm = num(wr[W.wmax]); if (wm !== null) wmax = wmax === null ? wm : Math.max(wmax, wm);
      const rr = num(wr[W.rain]); if (rr !== null && rr > 0) rain += rr / 60;
      const d = num(wr[W.wd]); if (d !== null) { sinW.push(Math.sin((d * Math.PI) / 180)); cosW.push(Math.cos((d * Math.PI) / 180)); }
      if (G0 !== null && G0 > SUN) W.soil.forEach((i) => { const s = i >= 0 ? num(wr[i]) : null; if (s !== null && s > 50 && s <= 105) soil.push(s); });
    }
    // inverters
    const pr = p && p.rows.get(t);
    if (pr) {
      const kws = invCols.map(([h, i]) => [h, num(pr[i])]).filter(([, v]) => v !== null);
      const sorted = kws.map(([, v]) => v).sort((a, b) => a - b);
      const medKw = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      let tot = 0;
      for (const [h, kw] of kws) {
        const s = h.slice(0, 4), inv = h.slice(0, h.indexOf(".active"));
        if (kw > 0) { tot += kw; sts[s] = (sts[s] || 0) + kw / 60; invE1[inv] = (invE1[inv] || 0) + kw / 60; }
        // availability and outages only while the plant as a whole is producing (median inverter above 20 kW),
        // so morning start-up and evening shading are not counted against single inverters
        if (medKw > 20) { availAll++; if (kw > 1) availOk++; if (kw <= 1) (outage[inv] ||= []).push(m); }
      }
      invE += tot / 60;
      const set = num(pr[iSet]);                            // export setpoint, MW
      if (set !== null && set > 0 && tot >= 0.97 * set * 1000) limitMin++;
    }
    // grid events
    const gr = g && g.rows.get(t);
    if (gr) {
      for (const x of G) {
        const st = num(gr[x.on]) === 1 && num(gr[x.off]) !== 1 ? "closed" : num(gr[x.off]) === 1 ? "open" : null;
        const tr = num(gr[x.trip]), fault = (num(gr[x.pf]) ? "phase fault" : "") + (num(gr[x.ef]) ? " earth fault" : "");
        const pv = prev[x.k];
        if (pv) {
          if (st && pv.st && st !== pv.st) events.push({ time: t, kind: st === "open" ? "breaker open" : "breaker closed", what: x.k });
          if (tr !== null && pv.tr !== null && tr > pv.tr) events.push({ time: t, kind: "trip", what: `${x.k} (${tr - pv.tr})` });
          if (fault && !pv.fault) events.push({ time: t, kind: "fault", what: `${x.k}${fault ? ` ${fault.trim()}` : ""}` });
        }
        prev[x.k] = { st: st || pv?.st || null, tr: tr ?? pv?.tr ?? null, fault };
      }
      const f = fI >= 0 ? num(gr[fI]) : null;
      const bad = f !== null && f > 40 && (f > 50.5 || f < 49.5);
      if (bad && !fOut) fOut = { from: t, min: f, max: f };
      if (bad) { fOut.min = Math.min(fOut.min, f); fOut.max = Math.max(fOut.max, f); fOut.to = t; }
      if (!bad && fOut) { events.push({ time: fOut.from, kind: "frequency", what: `${fOut.min < 49.5 ? fOut.min.toFixed(2) : fOut.max.toFixed(2)} Hz until ${fOut.to}` }); fOut = null; }
    }
  }
  if (fOut) events.push({ time: fOut.from, kind: "frequency", what: `${fOut.min < 49.5 ? fOut.min.toFixed(2) : fOut.max.toFixed(2)} Hz until ${fOut.to}` });

  // forced outages: an inverter at zero for 15+ consecutive sunny minutes
  for (const [inv, mins] of Object.entries(outage)) {
    let s = mins[0], last = mins[0];
    const flush = () => { if (last - s + 1 >= 15) events.push({ time: hhmm(s), kind: "inverter outage", what: `${inv} off while the plant produced, ${last - s + 1} min (to ${hhmm(last)})` }); };
    for (const m of mins.slice(1)) { if (m === last + 1) { last = m; continue; } flush(); s = last = m; }
    flush();
  }
  events.sort((a, b) => a.time.localeCompare(b.time));

  const Hk = H / 1000;                                     // kWh/m²
  const tEff = Hw > 0 ? tw / Hw : null;                    // irradiance-weighted module temperature
  const invMwh = invE / 1000;
  const pr = Hk > 0.2 ? (invE / (Hk * DC_KWP)) * 100 : null;
  const prT = pr !== null && tEff !== null ? pr / (1 + GAMMA * (tEff - 25)) : null;
  const station = Object.fromEntries(Object.entries(sts).sort().map(([k, v]) => {
    const n = invCols.filter(([h]) => h.startsWith(k)).length;
    return [k, { mwh: r(v / 1000, 2), inverters: n, mwh_per_inv: r(v / 1000 / Math.max(1, n), 3) }];
  }));
  const invVals = Object.values(invE1);
  const med = invVals.length ? invVals.slice().sort((a, b) => a - b)[Math.floor(invVals.length / 2)] : 0;
  const lowInv = Object.entries(invE1).filter(([, v]) => med > 0 && v < 0.85 * med).map(([k, v]) => `${k} ${Math.round((v / med) * 100)}%`).sort();
  const sensor = [];
  if (up1.length > 60 && up2.length > 60) {
    const a = mean(up1), b = mean(up2);
    if (Math.max(a, b) > 100 && Math.abs(a - b) / Math.max(a, b) > 0.15) sensor.push(`pyranometers differ by ${Math.round((Math.abs(a - b) / Math.max(a, b)) * 100)} % (STS1 ${Math.round(a)}, STS3 ${Math.round(b)} W/m² average)`);
  }
  if (w && !up1.length) sensor.push("STS1 pyranometer: no readings");
  if (w && !up2.length) sensor.push("STS3 pyranometer: no readings");
  if (w && !ws.length) sensor.push("weather station WS600: no readings");
  const wd = sinW.length ? ((Math.atan2(mean(sinW), mean(cosW)) * 180) / Math.PI + 360) % 360 : null;

  return {
    irradiation_kwh_m2: r(Hk, 2),
    inverter_mwh: r(invMwh, 2),
    pr_pct: r(pr, 1), pr_temp_corr_pct: r(prT, 1), tmod_weighted_c: r(tEff, 1), tmod_max_c: r(tmodMax, 1),
    availability_pct: availAll ? r((availOk / availAll) * 100, 1) : null,
    minutes_at_limit: limitMin,
    tamb_mean_c: r(mean(tamb), 1), rh_mean_pct: r(mean(rh), 0), pressure_hpa: r(mean(pa), 1),
    wind_mean_ms: r(mean(ws) === null ? null : mean(ws) / 3.6, 1), wind_max_ms: r(wmax, 1), wind_dir_deg: r(wd, 0),
    rain_mm: r(rain, 1), soiling_pct: soil.length ? r(mean(soil), 1) : null,
    station, low_inverters: lowInv, sensor_status: sensor.length ? sensor : ["normal"], events,
  };
}
