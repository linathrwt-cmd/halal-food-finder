const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
 
// On Render, set the DB_PATH environment variable to something under your
// persistent disk's mount path (e.g. /var/data/halalfinder.sqlite).
// Locally, it just defaults to a file next to this script.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'halalfinder.sqlite');
 
// Loud, unmissable startup diagnostics — check your Render logs after every
// deploy. This tells you definitively whether the app is pointing at your
// persistent disk, and whether it found existing data there.
const fileExistedBefore = fs.existsSync(dbPath);
console.log('========================================');
console.log('[DB STARTUP] Resolved DB_PATH env var:', process.env.DB_PATH || '(not set — using local default!)');
console.log('[DB STARTUP] Actual database file path:', dbPath);
console.log('[DB STARTUP] Did this file already exist on disk before this boot?', fileExistedBefore);
if (fileExistedBefore) {
  const stats = fs.statSync(dbPath);
  console.log('[DB STARTUP] Existing file size (bytes):', stats.size);
  console.log('[DB STARTUP] Existing file last modified:', stats.mtime.toISOString());
}
console.log('========================================');
 
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
 
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    is_email_verified INTEGER NOT NULL DEFAULT 0,
    is_id_verified INTEGER NOT NULL DEFAULT 0,
    verification_token TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
 
  CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('restaurant','supermarket','butcher')),
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT '',
    details TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    confidence TEXT NOT NULL CHECK(confidence IN ('certified','community','self')),
    has_certificate INTEGER NOT NULL DEFAULT 0,
    submitted_by_user_id TEXT NOT NULL,
    submitted_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (submitted_by_user_id) REFERENCES users(id)
  );
 
  CREATE TABLE IF NOT EXISTS votes (
    place_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    vote_type TEXT NOT NULL CHECK(vote_type IN ('up','down')),
    weight INTEGER NOT NULL DEFAULT 1,
    voted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (place_id, user_id),
    FOREIGN KEY (place_id) REFERENCES places(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
 
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    place_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (place_id) REFERENCES places(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);
 
// Safe migration for databases created before the `country` column existed.
// Harmless no-op if the column is already there.
try {
  db.exec("ALTER TABLE places ADD COLUMN country TEXT NOT NULL DEFAULT ''");
} catch (err) {
  // Column already exists — expected on every run after the first.
}
 
// One more loud diagnostic: how much data does this database actually have
// right now, at this exact moment of startup?
try {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const placeCount = db.prepare('SELECT COUNT(*) as c FROM places').get().c;
  console.log(`[DB STARTUP] Row counts at boot — users: ${userCount}, places: ${placeCount}`);
} catch (err) {
  console.log('[DB STARTUP] Could not count rows (tables may be brand new):', err.message);
}
 
db.dbPath = dbPath; // exposed so server.js can offer downloads/backups of the real file
module.exports = db;
