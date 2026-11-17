# Mount Coffee AI assistant

Claude (Anthropic) with **read-only** tools over the forecast PC's data: live output, forecasts, history, hourly
peaks, weather station, weather models, inverters and alerts. It cannot send anything to the logger, inverters or portal.

| Where | What |
|---|---|
| Dashboard | **Ask AI** button (bottom right): chat in plain English. Colleagues' copies use the forecast PC's assistant. |
| Alert e-mails | low-output forecast, output-below-satellite, curtailment, inverter and ramp alerts get an "AI analysis" section (likely cause, evidence, checks). |
| Shift reports | e-mailed to the ALERT_TO list at 07:00 (yesterday + today's outlook) and 19:05 GMT (today's review). Task "MCSolar AI Reports". |
| Telegram | operators ask from their phones; `/status` gives live numbers without AI. Only allowed chats get answers. Task "MCSolar Telegram". |

## Setup (forecast PC, once)
```
cd C:\Users\Admin\Downloads\mcsolar\dashboard
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup_agent.ps1
```
Needs an Anthropic API key (console.anthropic.com). It is stored only in `dashboard\.env.local` (not in git).
Optional settings in that file: `MCSOLAR_AGENT_MODEL` (default claude-sonnet-5-5), `MCSOLAR_AGENT_DAILY_LIMIT` (default 300 questions/day).
Usage per day is counted in `data\live\agent_usage.json`.

Telegram: create a bot with @BotFather, run setup_agent.ps1 (or `python live\set_telegram.py`), then each operator sends
`/start` to the bot and you allow their chat id with `python live\set_telegram.py --allow <id>`.

Code: `dashboard/lib/agent/` (tools, agent loop), `dashboard/app/api/agent/route.js`, `dashboard/app/AskAI.jsx`,
`forecast/live/agent_report.py`, `forecast/live/telegram_bot.py`, `forecast/live/alerts.py` (ai_analysis).
