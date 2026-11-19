/**
 * Nightly backup of the forecast PC's data files to Google Drive (added to the same Apps Script project as the receiver).
 *
 * The PC (live/backup_drive.py) sends each finished day's files, gzip-compressed:
 *   POST {token, action:"backup", folder:"2026-11", name:"iv2_live_20261118.csv.gz", b64:"..."}
 * They are saved in Drive under "Mount Coffee solar backup/<folder>/". A file with the same name is replaced.
 *
 * Setup (once): paste this file into the project as backup.gs, add the line marked BACKUP to doPost in Code.gs,
 * pick "authorizeDrive" in the function list, press Run and allow, then Deploy > Manage deployments > edit > New version.
 */
const BACKUP_ROOT = 'Mount Coffee solar backup';

function saveBackup(body) {
  const name = String(body.name || '');
  const folderName = String(body.folder || 'misc');
  if (!/^[A-Za-z0-9_.()\- ]{1,120}$/.test(name) || !/^[A-Za-z0-9_\-]{1,40}$/.test(folderName))
    return reply({ok: false, error: 'bad name or folder'});
  const bytes = Utilities.base64Decode(String(body.b64 || ''));
  if (!bytes.length) return reply({ok: false, error: 'empty file'});
  const root = childFolder(DriveApp.getRootFolder(), BACKUP_ROOT);
  const folder = childFolder(root, folderName);
  const old = folder.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);       // only earlier copies of this same backup file
  const file = folder.createFile(Utilities.newBlob(bytes, 'application/gzip', name));
  return reply({ok: true, id: file.getId(), bytes: bytes.length});
}

function childFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// Run once by hand from the editor to grant the Drive permission.
function authorizeDrive() {
  const root = childFolder(DriveApp.getRootFolder(), BACKUP_ROOT);
  Logger.log('Backups will be saved in Drive folder: ' + root.getName() + ' (' + root.getUrl() + ')');
}
