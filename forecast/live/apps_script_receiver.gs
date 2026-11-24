/**
 * Mount Coffee live forecast receiver (Google Apps Script).
 *
 * TOKEN below must match "sheet_token" in live/config.json. Only requests that carry it can write,
 * so keep it private. Change it here and in config.json if it is ever shared by mistake.
 *
 * POST {token, row}                                    -> appends one row to "Forecasts" (skipped if that issued_utc is already the last row)
 * POST {token, action:"replace", sheet, header, rows}  -> rewrites one of the REPLACEABLE tabs (weather-model forecast, daily energy, verification)
 * POST {token, action:"notify", kind, subject, text, summary_row?} -> logs the alert in tab "Alerts" (and the summary row in
 *      "DailySummary") and e-mails it to the addresses in the script property ALERT_TO (comma-separated).
 *
 * E-mail needs a one-time permission: in the editor pick the function "authorize" and press Run, then allow.
 */
const TOKEN = 'CHANGE-ME-to-the-same-secret-as-config.json';
const SHEET = 'Forecasts';
const SPREADSHEET_ID = 'PASTE-THE-SPREADSHEET-ID';
const COLUMNS = 12;
const REPLACEABLE = ['WeatherHourly', 'WeatherDays', 'WeatherAlerts', 'DailyEnergy', 'Verification', 'VerificationLedger', 'Trips'];

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return reply({ok: false, error: 'bad token'});
    if (body.action === 'backup') return saveBackup(body);   // BACKUP (backup.gs): nightly data files to Drive
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
      if (body.action === 'replace') return replaceTab(ss, body);
      if (body.action === 'notify') return notify(ss, body);
      const row = body.row;
      if (!Array.isArray(row) || row.length !== COLUMNS) return reply({ok: false, error: 'row must have ' + COLUMNS + ' values'});
      const sh = ss.getSheetByName(SHEET);
      sh.getRange('A:A').setNumberFormat('@');   // keep the UTC time as plain text, not a local date
      const last = sh.getLastRow();
      if (last > 1 && String(sh.getRange(last, 1).getDisplayValue()) === String(row[0])) return reply({ok: true, duplicate: true});
      sh.appendRow(row);
      return reply({ok: true});
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply({ok: false, error: String(err)});
  }
}

function replaceTab(ss, body) {
  if (REPLACEABLE.indexOf(body.sheet) < 0) return reply({ok: false, error: 'sheet not replaceable'});
  const header = body.header, rows = body.rows || [];
  if (!Array.isArray(header) || !header.length) return reply({ok: false, error: 'header missing'});
  if (rows.length > 2000 || rows.some(function (r) { return !Array.isArray(r) || r.length !== header.length; }))
    return reply({ok: false, error: 'rows must be arrays of ' + header.length + ' values (max 2000)'});
  const sh = ss.getSheetByName(body.sheet) || ss.insertSheet(body.sheet);
  sh.clearContents();
  sh.getRange('A:B').setNumberFormat('@');      // times and dates stay plain text
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  return reply({ok: true, rows: rows.length});
}

function notify(ss, body) {
  const when = Utilities.formatDate(new Date(), 'GMT', "yyyy-MM-dd HH:mm");
  const kind = String(body.kind || 'alert').slice(0, 40), subject = String(body.subject || 'Mount Coffee solar').slice(0, 200);
  const text = String(body.text || '').slice(0, 5000);
  const to = PropertiesService.getScriptProperties().getProperty('ALERT_TO') || '';
  let mailed = 'no', mailError = '';
  if (to) {
    try { MailApp.sendEmail(to, subject, text); mailed = 'yes'; } catch (err) { mailError = String(err).slice(0, 200); }
  } else mailError = 'ALERT_TO not set';
  const log = ss.getSheetByName('Alerts') || ss.insertSheet('Alerts');
  if (log.getLastRow() === 0) log.appendRow(['time_utc', 'kind', 'text', 'emailed', 'email_error']);
  log.getRange('A:A').setNumberFormat('@');
  log.appendRow([when, kind, text, mailed, mailError]);
  if (kind === 'summary' && Array.isArray(body.summary_row) && body.summary_row.length === 8) {
    const sh = ss.getSheetByName('DailySummary') || ss.insertSheet('DailySummary');
    if (sh.getLastRow() === 0) sh.appendRow(['date', 'energy_mwh', 'peak_mw', 'dayahead_forecast_mwh', 'nowcast15_mae_mw', 'alerts', 'logger_disk_pct', 'channel_errors']);
    sh.getRange('A:A').setNumberFormat('@');
    sh.appendRow(body.summary_row);
  }
  return reply({ok: true, emailed: mailed, email_error: mailError});
}

// Run once by hand from the editor to grant the e-mail permission (and send yourself a test message).
function authorize() {
  const to = PropertiesService.getScriptProperties().getProperty('ALERT_TO') || Session.getEffectiveUser().getEmail();
  PropertiesService.getScriptProperties().setProperty('ALERT_TO', to);
  MailApp.sendEmail(to, 'Mount Coffee solar alerts are set up', 'Alerts and the daily summary will be sent to: ' + to);
}

function doGet() {
  return reply({ok: true, service: 'Mount Coffee forecast receiver'});
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
