// Inverter state and alarm codes as the inverters report them to the logger (work_state_01, alarm_code).
// The values match Sungrow's published Modbus lists (work state register and fault codes); the inverter make should
// be confirmed against the nameplate. Unknown codes are shown as their number.
export const STATES = {
  0x0000: ["Run", "ok"], 0x8000: ["Stop", "off"], 0x1300: ["Key stop", "off"], 0x1500: ["Emergency stop", "bad"],
  0x1400: ["Standby", "idle"], 0x1200: ["Initial standby", "idle"], 0x1600: ["Starting", "idle"], 0x9100: ["Alarm run", "warn"],
  0x8100: ["Derating run", "warn"], 0x8200: ["Dispatch run", "warn"], 0x5500: ["Fault", "bad"], 0x2500: ["Communication fault", "bad"],
};
export const ALARMS = {
  2: "Grid overvoltage", 3: "Grid transient overvoltage", 4: "Grid undervoltage", 5: "Grid low voltage", 7: "AC instantaneous overcurrent",
  8: "Grid over-frequency", 9: "Grid under-frequency", 10: "Grid power outage", 11: "Device abnormal", 12: "Excessive leakage current",
  13: "Grid abnormal", 14: "10-minute grid overvoltage", 15: "Grid overvoltage", 16: "Output overload", 17: "Grid voltage unbalance",
  19: "Device abnormal", 20: "Device abnormal", 21: "Device abnormal", 22: "Device abnormal", 23: "PV connection fault",
  24: "Device abnormal", 25: "Device abnormal", 28: "PV reverse connection", 36: "Module temperature too high", 37: "Ambient temperature too high",
  38: "Device abnormal", 39: "Low insulation resistance (PV array to earth)", 40: "Device abnormal", 41: "Device abnormal",
  42: "Device abnormal", 43: "Ambient temperature too low", 44: "Device abnormal", 45: "Device abnormal", 46: "Device abnormal",
  47: "PV input configuration abnormal", 48: "Device abnormal", 53: "Device abnormal", 56: "Device abnormal", 59: "Device abnormal",
  70: "Fan alarm", 87: "Arc detection device abnormal", 88: "Electric arc fault", 89: "Arc detection disabled", 105: "Grid-side protection self-check failure",
  106: "Grounding cable fault", 116: "Device abnormal", 117: "Device abnormal", 220: "PV string abnormal", 532: "PV string reverse connection",
  548: "PV string output current abnormal",
};
export const stateName = (c) => (c === null || c === undefined ? "—" : STATES[c]?.[0] || `state ${c}`);
export const stateKind = (c) => (c === null || c === undefined ? "off" : STATES[c]?.[1] || "warn");
export const alarmName = (c) => ALARMS[c] || `code ${c}`;
