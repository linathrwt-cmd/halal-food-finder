const Database = require('better-sqlite3');
const path = require('path');

// The .sqlite file lives alongside this code — on most hosts (Render, Railway,
// a VPS) you'll want this on a persistent disk/volume so it survives restarts.
const db = new Database(path.join(__dirname, 'halalfinder.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    is_email_verified INTEGER NOT NULL DEFAULT 0,
    is_id_verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('restaurant','supermarket','butcher')),
    address TEXT NOT NULL,
    city TEXT NOT NULL,
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

module.exports = db;
