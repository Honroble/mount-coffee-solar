/**
 * Mount Coffee watchdog: runs on Google's servers every 10 minutes, so it still works when the forecast PC is
 * off, asleep, has no internet or has stopped collecting. During daylight (07:00-18:00 GMT) it e-mails the
 * ALERT_TO list if the Forecasts tab has had no new row for 30 minutes, and again when rows come back.
 *
 * Install once (in the same Apps Script project as the receiver):
 *   1) File > New > Script, name it "watchdog", paste this whole file, Save.
 *   2) Choose the function installWatchdog in the toolbar and click Run; allow the permission
 *      ("run when you are not present").  Nothing else to deploy: time triggers use the saved code.
 * Uses SPREADSHEET_ID from the receiver file and the ALERT_TO script property (comma-separated e-mails).
 */
var WATCH_SHEET = 'Forecasts';
var WATCH_MAX_MIN = 30;

function installWatchdog() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'watchdog') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('watchdog').timeBased().everyMinutes(10).create();
  watchdog();
  Logger.log('Watchdog installed: checks every 10 minutes.');
}

function watchdog() {
  var now = new Date();
  var h = now.getUTCHours();
  var props = PropertiesService.getScriptProperties();
  var down = props.getProperty('WATCHDOG_DOWN');            // time we sent the "silent" e-mail
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(WATCH_SHEET);
  var last = sh.getRange(sh.getLastRow(), 1).getDisplayValue();   // e.g. 2026-11-17 17:05 (GMT)
  var t = new Date(last.replace(' ', 'T') + ':00Z');
  var age = Math.round((now - t) / 60000);
  var to = props.getProperty('ALERT_TO');
  if (!to || isNaN(age)) return;
  var daylight = h >= 7 && h < 18;
  if (daylight && age > WATCH_MAX_MIN && !down) {
    MailApp.sendEmail(to, 'Mount Coffee solar: FORECAST PC SILENT',
      'No new forecast has reached the Google Sheet for ' + age + ' minutes (last ' + last + ' GMT).\n\n' +
      'The forecast PC may be off, asleep, without internet, or its collector may have stopped (e.g. portal sign-in).\n' +
      'Check the PC; the dashboard at http://<forecast PC>:3000 shows the problem in a red banner.\n\n' +
      '(Sent by the Google watchdog, which runs even when the PC is off.)');
    props.setProperty('WATCHDOG_DOWN', now.toISOString());
    logWatch_('watchdog', 'Forecast PC silent for ' + age + ' min (last ' + last + ' GMT)');
  } else if (down && age <= 15) {
    MailApp.sendEmail(to, 'Mount Coffee solar: forecast PC back',
      'Forecasts are reaching the Google Sheet again (latest ' + last + ' GMT). Silent since ' + down.slice(11, 16) + ' GMT.');
    props.deleteProperty('WATCHDOG_DOWN');
    logWatch_('watchdog_ok', 'Forecast PC back (latest ' + last + ' GMT)');
  }
}

function logWatch_(kind, text) {
  try {
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var a = ss.getSheetByName('Alerts') || ss.insertSheet('Alerts');
    a.appendRow([Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd HH:mm'), kind, text, 'yes']);
  } catch (e) { /* logging only */ }
}
