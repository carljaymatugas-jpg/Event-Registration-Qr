'use strict';
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('node:async_hooks');

const DATABASE_URL = process.env.DATABASE_URL;

let db;

if (DATABASE_URL) {
  const { Pool, types } = require('pg');
  // Return BIGINT (count, etc.) as JavaScript integer numbers instead of strings
  types.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10)));
  // Return NUMERIC as floats
  types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));
  // Return TIMESTAMP without timezone as formatted string
  types.setTypeParser(1114, (val) => val);

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000
  });

  // Handle unexpected errors on idle pool connections (prevents unhandled ECONNRESET process crashes)
  pool.on('error', (err) => {
    console.warn('Notice: Idle PostgreSQL client disconnected or connection reset (auto-reconnecting):', err && err.message);
  });

  const txStorage = new AsyncLocalStorage();

  function convertPlaceholders(sql) {
    let idx = 1;
    return sql.replace(/\?/g, () => `$${idx++}`);
  }

  function flattenArgs(args) {
    return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
  }

  db = {
    isPostgres: true,
    pool,
    prepare(sql) {
      let pgSql = convertPlaceholders(sql);
      const isInsert = /^\s*insert\s+into/i.test(pgSql);
      if (isInsert && !/returning\s+/i.test(pgSql)) {
        pgSql = pgSql.trim().replace(/;?\s*$/, '') + ' RETURNING id;';
      }

      return {
        async get(...args) {
          const client = txStorage.getStore() || pool;
          const res = await client.query(pgSql, flattenArgs(args));
          return res.rows[0] || null;
        },
        async all(...args) {
          const client = txStorage.getStore() || pool;
          const res = await client.query(pgSql, flattenArgs(args));
          return res.rows || [];
        },
        async run(...args) {
          const client = txStorage.getStore() || pool;
          const res = await client.query(pgSql, flattenArgs(args));
          return {
            lastInsertRowid: res.rows && res.rows[0] && res.rows[0].id ? res.rows[0].id : null,
            changes: res.rowCount
          };
        }
      };
    },
    transaction(fn) {
      return async (...args) => {
        const existingClient = txStorage.getStore();
        if (existingClient) {
          return await fn(...args);
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await txStorage.run(client, async () => {
            return await fn(...args);
          });
          await client.query('COMMIT');
          return result;
        } catch (err) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw err;
        } finally {
          client.release();
        }
      };
    },
    async exec(sql) {
      const client = txStorage.getStore() || pool;
      return await client.query(sql);
    },
    pragma() {
      // No-op for PostgreSQL
    }
  };

  // Check connection and ensure organizer account
  pool.query("SELECT id FROM staff_users WHERE username = 'organizer'")
    .then(res => {
      if (!res.rows.length) {
        console.log('Postgres connected: organizer account missing, seeding...');
        const seed = require('./seed');
        if (typeof seed === 'function') seed();
      }
    })
    .catch(err => {
      console.warn('Neon PostgreSQL initial check error:', err.message);
    });

} else {
  // SQLite fallback
  const dbDir = path.resolve(process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : './data');
  try {
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  } catch (err) {
    console.warn('Notice: Local database directory cannot be created (e.g. read-only serverless filesystem):', err.message);
  }

  const dbPath = path.resolve(process.env.DB_PATH || './data/eventreg.db');

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

  db.isPostgres = false;
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT    NOT NULL,
      description TEXT    NOT NULL DEFAULT '',
      venue       TEXT    NOT NULL,
      starts_at   TEXT    NOT NULL,
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

  module.exports = db;

  try {
    const org = db.prepare('SELECT id FROM staff_users WHERE username = ?').get('organizer');
    if (!org && process.env.SKIP_AUTO_SEED !== 'true') {
      const seed = require('./seed');
      if (typeof seed === 'function') seed().catch(e => console.warn('Auto-seed error:', e.message));
    }
  } catch (e) {
    console.warn('Auto-seed check:', e.message);
  }
}

module.exports = db;
