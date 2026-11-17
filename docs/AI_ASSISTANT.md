# Mount Coffee assistant

Read-only: it only reads the forecast PC's data (live output, forecasts, history, hourly peaks, weather station,
weather models, inverters, alerts). It cannot send anything to the logger, inverters or portal.

## Free mode (default, no API key)
| Where | What |
|---|---|
| Dashboard | **Assistant** button (bottom right): quick answers - Status now, Today so far, Forecast, Inverters, Alerts, Plant health. |
| Alert e-mails | low-output forecast, output-below-satellite, curtailment, inverter and ramp alerts get the plant data at that moment and a likely cause (curtailment, inverters at zero, cloud/rain, or sunlight normal but output low). |
| Shift reports | 07:00 (yesterday + today's outlook) and 19:05 GMT (today) to the ALERT_TO list. Task "MCSolar AI Reports". |

## Paid AI (optional)
With an Anthropic API key, operators can also type questions in plain English, alert e-mails get a written analysis and
reports are written by Claude. Roughly $20-55/month on Claude Sonnet 5.5 at normal use, or $1-3 on Claude Haiku 5.5.
Key in `dashboard\.env.local` only (not in git). Optional: `MCSOLAR_AGENT_MODEL`, `MCSOLAR_AGENT_DAILY_LIMIT` (default 300/day).

## Setup (forecast PC, once)
```
cd C:\Users\Admin\Downloads\mcsolar\dashboard
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_agent.ps1
```
Press Enter at the key prompt for free mode. Run it again later to add a key.

Code: `dashboard/lib/agent/` (tools, quick answers, AI loop), `dashboard/app/api/agent/route.js`, `dashboard/app/AskAI.jsx`,
`forecast/live/agent_report.py`, `forecast/live/alerts.py` (ai_analysis).
