'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const dbDir = path.resolve(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.resolve(process.env.DB_PATH || './data/eventreg.db');

let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(dbPath);
} catch {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(dbPath);
  db.pragma = (str) => db.exec(`PRAGMA ${str};`);
  db.transaction = (fn) => {
    return (...args) => {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const res = fn(...args);
        db.exec('COMMIT;');
        return res;
      } catch (err) {
        try { db.exec('ROLLBACK;'); } catch (_) {}
        throw err;
      }
    };
  };
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const flatten = (args) => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args);
    return {
      run: (...args) => stmt.run(...flatten(args)),
      get: (...args) => stmt.get(...flatten(args)),
      all: (...args) => stmt.all(...flatten(args)),
    };
  };
}

// Enable WAL for concurrent writes (Level 3 race condition handling)
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    venue       TEXT    NOT NULL,
    starts_at   TEXT    NOT NULL,  -- ISO 8601 stored as Cebu time
    ends_at     TEXT    NOT NULL,
    capacity    INTEGER NOT NULL CHECK(capacity >= 1),
    status      TEXT    NOT NULL DEFAULT 'Draft'
                        CHECK(status IN ('Draft','Published','Closed')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER NOT NULL REFERENCES events(id),
    full_name       TEXT    NOT NULL,
    email           TEXT    NOT NULL,
    mobile          TEXT    NOT NULL,
    ticket_code     TEXT    NOT NULL UNIQUE,
    status          TEXT    NOT NULL DEFAULT 'Confirmed'
                            CHECK(status IN ('Confirmed','CheckedIn','Waitlisted','Cancelled')),
    waitlist_pos    INTEGER,
    registered_at   TEXT    NOT NULL DEFAULT (datetime('now','+8 hours')),
    checked_in_at   TEXT,
    checked_in_by   INTEGER REFERENCES staff_users(id),
    undo_at         TEXT,
    undo_by         INTEGER REFERENCES staff_users(id)
  );

  CREATE TABLE IF NOT EXISTS staff_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'door'
                          CHECK(role IN ('organizer','door'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    staff_user_id INTEGER REFERENCES staff_users(id),
    action        TEXT    NOT NULL,
    target_id     INTEGER,
    detail        TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','+8 hours'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_active_reg
    ON registrations(event_id, email)
    WHERE status IN ('Confirmed','CheckedIn','Waitlisted');
`);

// Self-healing auto-seed if organizer account does not exist
try {
  const org = db.prepare('SELECT id FROM staff_users WHERE username = ?').get('organizer');
  if (!org) {
    require('./seed');
  }
} catch (e) {
  console.warn('Auto-seed check:', e.message);
}

module.exports = db;
