// Everything the page shows that changes: live readings + the weather-model forecast.
import { liveSnapshot, lanAddresses, SOURCE_URL } from "@/lib/live";
import { nwpSnapshot } from "@/lib/nwp";

function localSnapshot() {
  const live = liveSnapshot();
  let nwp = null;
  try { nwp = nwpSnapshot(); } catch (e) { nwp = { error: String(e) }; }
  return { ...live, nwp };
}

export async function getLive() {
  if (!SOURCE_URL) return { ...localSnapshot(), source: "this PC", servedFrom: lanAddresses() };
  try {
    const r = await fetch(`${SOURCE_URL}/api/live`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return { ...j, source: SOURCE_URL, servedFrom: lanAddresses() };
  } catch (e) {
    const local = localSnapshot();
    return { ...local, source: SOURCE_URL, sourceError: `Cannot reach the forecast PC at ${SOURCE_URL} (${e.message})`,
             servedFrom: lanAddresses() };
  }
}
