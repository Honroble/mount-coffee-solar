"use client";
import { useEffect, useState } from "react";

// Red banner when the data pipeline itself has a problem (checked every minute).
export default function SystemBanner() {
  const [s, setS] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch("/api/system", { cache: "no-store" }).then((r) => r.json()).then((j) => !stop && setS(j)).catch(() => {});
    load();
    const id = setInterval(load, 60000);
    return () => { stop = true; clearInterval(id); };
  }, []);
  if (!s?.problems?.length) return null;
  return (
    <div className="sysbanner">
      <b>⚠ Data system problem</b>
      {s.problems.map((p) => <div key={p.id}>• {p.text}</div>)}
    </div>
  );
}
