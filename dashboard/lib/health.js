// Automatic plant health checks for today. Server side only.
//   expected vs actual: satellite sunlight over the plant -> expected MW, compared with the logger every 10 min
//   inverters: off or far below the others in strong sun; identical readings (duplicate Modbus address)
//   sensors: STS1 vs STS3 pyranometers, and each against the satellite
//   logger: disk, channel errors, power limit, collector freshness (homepage values saved by the collector)
import fs from "fs";
import path from "path";
import { LIVE_DIR, parseCsv } from "@/lib/live";

const SENT = new Set([655.35, 6553.5, 65535]);
const MW_PER_WM2 = 0.02063, LIMIT = 16.64;
const INVERTERS = [];
for (const [s, n, pad] of [["STS1", 14, true], ["STS2", 14, true], ["STS3", 12, true], ["STS4", 12, false]])
  for (let i = 1; i <= n; i++) INVERTERS.push(`${s}.INV${pad ? String(i).padStart(2, "0") : i}`);

function readDay(group, day) {
  let text;
  try { text = fs.readFileSync(path.join(LIVE_DIR, `${group}_live_${day.replace(/-/g, "")}.csv`), "latin1"); } catch { return []; }
  const rows = parseCsv(text, ";");
  const head = rows[0] || [];
  const out = [];
  for (const r of rows.slice(1)) {
    if (!r[0] || r[0].startsWith("[")) continue;
    const [dd, mm, yyyy] = r[0].split(".");
    const t = Date.parse(`${yyyy}-${mm}-${dd}T${r[1]}Z`);
    if (isNaN(t)) continue;
    const v = {};
    for (let i = 3; i < head.length; i++) {
      const x = r[i] === undefined || r[i] === "" ? null : Number(String(r[i]).replace(",", "."));
      v[head[i]] = x === null || !Number.isFinite(x) || SENT.has(x) ? null : x;
    }
    out.push({ t, v });
  }
  return out;
}

function satellite(day) {
  let text;
  try { text = fs.readFileSync(path.join(LIVE_DIR, "sat_recent.csv"), "utf8"); } catch { return []; }
  return parseCsv(text).slice(1).filter((r) => r[0]?.startsWith(day) && r[1] !== "").map((r) => ({ end: Date.parse(r[0] + ":00Z"), ghi: Number(r[1]) }));
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const status = (ok, warn) => (ok ? "ok" : warn ? "warn" : "bad");

export function healthSnapshot(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const iv2 = readDay("iv2", day), iv1 = readDay("iv1", day);
  let w = {};
  try { w = JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "widget_latest.json"), "utf8")); } catch { /* collector not updated yet */ }
  const limitPct = w.power_limit_user_pct ?? 100;
  const checks = [];

  // expected vs actual, per satellite period
  const sat = satellite(day);
  const compare = sat.map((s) => {
    const vals = iv2.filter((x) => x.t > s.end - 600000 && x.t <= s.end).map((x) => x.v["Information.Inverter sum P"]).filter((x) => x !== null);
    const expected = Math.min(s.ghi * MW_PER_WM2, LIMIT * limitPct / 100);
    return { t: new Date(s.end - 300000).toISOString(), expected: +expected.toFixed(2), actual: vals.length ? +mean(vals).toFixed(2) : null };
  }).filter((c) => c.actual !== null);
  const sunny = compare.filter((c) => c.expected > 4);
  const ratio = sunny.length ? mean(sunny.map((c) => c.actual / c.expected)) : null;
  const lowPeriods = sunny.filter((c) => c.actual < 0.6 * c.expected).length;
  let run = 0, longest = 0;
  for (const c of compare) { run = c.expected > 4 && c.actual < 0.6 * c.expected ? run + 1 : 0; longest = Math.max(longest, run); }
  // passing clouds give single low periods (the satellite reads high in broken cloud); 3 in a row = 30 min is a real loss
  checks.push({ id: "expected", label: "Output vs satellite sunlight", state: ratio === null ? "na" : status(longest <= 1, longest <= 2),
    text: ratio === null ? "Not enough sunny satellite periods yet today." :
      `Plant gave ${Math.round(100 * ratio)} % of the satellite-implied output on average today; ${lowPeriods} of ${sunny.length} sunny 10-minute periods were below 60 %, longest run ${longest * 10} min.` });

  // inverters, last 30 minutes of strong sun
  const recent = iv2.filter((x) => now.getTime() - x.t <= 30 * 60000);
  const plantOn = recent.length >= 10 && recent.every((x) => (x.v["Information.Inverter sum P"] ?? 0) > 5);
  const inv = INVERTERS.map((n) => {
    const s = recent.map((x) => x.v[`${n}.active_power_total`]).filter((x) => x !== null);
    return { name: n, mean: mean(s), series: s };
  });
  const med = (() => { const v = inv.map((i) => i.mean).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })();
  const off = plantOn ? inv.filter((i) => i.mean !== null && i.mean < 5).map((i) => i.name) : [];
  const low = plantOn && med ? inv.filter((i) => i.mean !== null && i.mean >= 5 && i.mean < 0.6 * med).map((i) => i.name) : [];
  const dup = [];
  for (let a = 0; a < inv.length; a++) for (let b = a + 1; b < inv.length; b++) {
    const A = inv[a].series, B = inv[b].series;
    if (A.length >= 10 && A.length === B.length && A.every((x, i) => x === B[i]) && mean(A) > 10) dup.push(`${inv[a].name} = ${inv[b].name}`);
  }
  checks.push({ id: "inverters", label: "Inverters (last 30 min)", state: !plantOn ? "na" : status(!off.length && !low.length && !dup.length, !off.length),
    text: !plantOn ? "Checked when the plant makes more than 5 MW." :
      [off.length ? `No output: ${off.join(", ")}.` : "", low.length ? `Below 60 % of the median (${Math.round(med)} kW): ${low.join(", ")}.` : "",
       dup.length ? `Identical readings, likely a duplicate Modbus address: ${dup.join("; ")}.` : "", (!off.length && !low.length && !dup.length) ? "All 52 producing normally." : ""].filter(Boolean).join(" ") });

  // sensors: STS1 vs STS3 and vs satellite (sunny satellite periods)
  const s1 = "FPE.PV.STS1.Pyranometer.up.irradiation_temp_compensated", s3 = "FPE.PV.STS3.Pyranometer.up.irradiation_temp_compensated";
  const pairs = sat.filter((s) => s.ghi > 500).map((s) => {
    const rows = iv1.filter((x) => x.t > s.end - 600000 && x.t <= s.end);
    return { sat: s.ghi, a: mean(rows.map((x) => x.v[s1]).filter((x) => x !== null)), b: mean(rows.map((x) => x.v[s3]).filter((x) => x !== null)) };
  }).filter((p) => p.a !== null && p.b !== null);
  const r13 = pairs.length ? mean(pairs.map((p) => p.a / p.b)) : null;
  const r1s = pairs.length ? mean(pairs.map((p) => p.a / p.sat)) : null, r3s = pairs.length ? mean(pairs.map((p) => p.b / p.sat)) : null;
  checks.push({ id: "sensors", label: "Pyranometers", state: r13 === null ? "na" : status(Math.abs(r13 - 1) < 0.1 && r1s > 0.85 && r3s > 0.85, Math.abs(r13 - 1) < 0.2),
    text: r13 === null ? "Compared in sunny periods (satellite above 500 W/m²)." :
      `STS1 reads ${Math.round(100 * r13)} % of STS3; against the satellite STS1 ${Math.round(100 * r1s)} %, STS3 ${Math.round(100 * r3s)} % (${pairs.length} periods). Clouds over one station cause some difference; a steady gap on clear days points to soiling or calibration.` });

  // logger and collector
  const last = iv2.at(-1)?.t ?? null;
  const ageMin = last ? Math.round((now.getTime() - last) / 60000) : null;
  checks.push({ id: "collector", label: "Data collection", state: ageMin === null ? "bad" : status(ageMin <= 15, ageMin <= 45),
    text: ageMin === null ? "No plant data saved today." : `Last minute saved ${ageMin} min ago; ${iv2.length} minutes today.` });
  if (w.disk_used_pct != null) {
    const daysLeft = (() => {
      try {
        const rows = parseCsv(fs.readFileSync(path.join(LIVE_DIR, "widget_log.csv"), "utf8")).slice(1).filter((r) => r[2]);
        if (rows.length < 2) return null;
        const a = rows[0], b = rows.at(-1);
        const dtDays = (Date.parse(b[0]) - Date.parse(a[0])) / 864e5, used = Number(a[2]) - Number(b[2]);
        return dtDays > 0.2 && used > 0 ? Number(b[2]) / (used / dtDays) : null;
      } catch { return null; }
    })();
    checks.push({ id: "disk", label: "Logger disk", state: status(w.disk_used_pct < 90, w.disk_used_pct < 97),
      text: `${w.disk_used_pct} % used, ${w.disk_free_mb} MB free${daysLeft ? `, full in about ${daysLeft.toFixed(1)} days at the current rate` : ""}. The logger then deletes its oldest data files to make room (it keeps only the last few weeks): the PC's copy in data\\live and the nightly Drive backup are the long-term record.` });
    checks.push({ id: "limit", label: "Power limit", state: status(limitPct >= 100, limitPct >= 80),
      text: `PowerLimit_User ${limitPct} %, plant setpoint ${w.power_setpoint_mw} MW.` });
    checks.push({ id: "channels", label: "Logger channels", state: status(!w.channel_errors, w.channel_errors <= 10),
      text: `${w.channel_errors} of ${w.channels} channels in error.` });
  } else {
    checks.push({ id: "disk", label: "Logger disk", state: "na", text: "Read from the logger homepage once the updated collector runs." });
  }
  return { checks, compare };
}
