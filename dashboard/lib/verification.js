// Forecast verification written by forecast/live/verify.py (server side only).
//   <liveDir>/verification.json                 scores, integrity of the sealed records, day table
//   <liveDir>/reports/verification_YYYY-MM.md   monthly report
import fs from "fs";
import path from "path";
import { LIVE_DIR } from "@/lib/live";

export function verification() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LIVE_DIR, "verification.json"), "utf8"));
  } catch {
    return null;
  }
}

export function verificationReport(month) {
  if (!/^\d{4}-\d{2}$/.test(month || "")) return null;
  try {
    return fs.readFileSync(path.join(LIVE_DIR, "reports", `verification_${month}.md`), "utf8");
  } catch {
    return null;
  }
}
