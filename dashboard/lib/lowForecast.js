// Same rule as forecast/live/alerts.py: output forecast to fall below 1 MW in the next hour while the sun is up.
export function lowForecastWarning(f, nowIso) {
  if (!f || !f.issued || !(f.status || "").startsWith("ok")) return null;
  if (Date.parse(nowIso) - Date.parse(f.issued) > 20 * 60000) return null;
  const low = [15, 30, 60].filter((m) => f[`p${m}`] != null && f[`p${m}`] < 1 && (f[`cs${m}`] ?? 0) >= 3);
  if (!low.length) return null;
  const vals = [15, 30, 60].filter((m) => f[`p${m}`] != null).map((m) => `+${m} min ${f[`p${m}`].toFixed(1)} MW`).join(", ");
  return `Output forecast to fall below 1 MW in about ${low[0]} minutes (${vals}; issued ${f.issued.slice(11, 16)} UTC). Be ready to cover the shortfall.`;
}
