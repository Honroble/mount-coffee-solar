/**
 * Mount Coffee live forecast receiver (Google Apps Script).
 *
 * Paste this into the Google Sheet "Mount Coffee Solar – Live Forecast Log":
 *   Extensions > Apps Script > replace everything with this file > Save.
 * Then: Deploy > New deployment > type "Web app"
 *   Execute as: Me      Who has access: Anyone
 * Copy the Web app URL into live/config.json as "sheet_webhook_url".
 *
 * TOKEN below must match "sheet_token" in live/config.json. Only requests that carry it can add rows,
 * so keep it private. Change it here and in config.json if it is ever shared by mistake.
 */
const TOKEN = 'CHANGE-ME-to-the-same-secret-as-config.json';
const SHEET = 'Forecasts';
const COLUMNS = 12;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== TOKEN) return reply({ok: false, error: 'bad token'});
    const row = body.row;
    if (!Array.isArray(row) || row.length !== COLUMNS) return reply({ok: false, error: 'row must have ' + COLUMNS + ' values'});
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
      sh.getRange('A:A').setNumberFormat('@');   // keep the UTC time as plain text, not a local date
      sh.appendRow(row);
    } finally {
      lock.releaseLock();
    }
    return reply({ok: true});
  } catch (err) {
    return reply({ok: false, error: String(err)});
  }
}

function doGet() {
  return reply({ok: true, service: 'Mount Coffee forecast receiver'});
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
