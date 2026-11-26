'use strict';
/**
 * Concurrency & Race Condition Verification Test (Level 3 - T8)
 * Runs against:
 * 1. Isolated in-memory SQLite (BEGIN IMMEDIATE + atomic check-in UPDATE)
 * 2. PostgreSQL (Neon) when DATABASE_URL is set (SELECT ... FOR UPDATE + atomic UPDATE + uq_event_email_active)
 */
require('dotenv').config();
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');

function createSqliteTestDb() {
  const sdb = new DatabaseSync(':memory:');
  sdb.exec('PRAGMA foreign_keys = ON;');
  sdb.exec('PRAGMA journal_mode = WAL;');
  sdb.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      capacity INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Published'
    );
    CREATE TABLE registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id),
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      mobile TEXT NOT NULL,
      ticket_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('Confirmed','CheckedIn','Waitlisted','Cancelled')),
      waitlist_pos INTEGER,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      checked_in_at TEXT,
      checked_in_by INTEGER
    );
    CREATE UNIQUE INDEX uq_active_reg ON registrations(event_id, email)
      WHERE status IN ('Confirmed','CheckedIn','Waitlisted');
  `);
  sdb.transaction = (fn) => (...args) => {
    sdb.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn(...args);
      sdb.exec('COMMIT;');
      return res;
    } catch (e) {
      try { sdb.exec('ROLLBACK;'); } catch (_) {}
      throw e;
    }
  };
  return sdb;
}

async function runSqliteRaceTests() {
  const sdb = createSqliteTestDb();
  console.log('\n--- [SQLite] Test 1: Last-Spot Registration Race Condition ---');
  sdb.exec("INSERT INTO events (title, capacity, status) VALUES ('SQLite Race Event', 1, 'Published');");
  const eventId = 1;

  function attemptRegister(name, email, code) {
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const runTx = sdb.transaction(() => {
            const confirmedCount = sdb.prepare(
              "SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status IN ('Confirmed','CheckedIn')"
            ).get(eventId).c;

            if (confirmedCount < 1) {
              sdb.prepare(
                "INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status) VALUES (?,?,?,?,?,'Confirmed')"
              ).run(eventId, name, email, '09171234567', code);
              return { success: true, status: 'Confirmed' };
            }
            sdb.prepare(
              "INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos) VALUES (?,?,?,?,?,'Waitlisted', 1)"
            ).run(eventId, name, email, '09171234567', code);
            return { success: true, status: 'Waitlisted' };
          });
          resolve(runTx());
        } catch (err) {
          resolve({ success: false, error: err.message });
        }
      });
    });
  }

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => attemptRegister(`User ${i + 1}`, `user${i + 1}@example.com`, `SQL-${i + 1}`))
  );
  const confirmed = results.filter(r => r.status === 'Confirmed');
  const waitlisted = results.filter(r => r.status === 'Waitlisted');
  assert.strictEqual(confirmed.length, 1, 'SQLite: Exactly ONE confirmed');
  assert.strictEqual(waitlisted.length, 9, 'SQLite: Exactly NINE waitlisted');
  console.log('✅ PASSED [SQLite]: 1 Confirmed, 9 Waitlisted out of 10 simultaneous requests.');

  console.log('\n--- [SQLite] Test 2: Simultaneous Atomic Check-in Race ---');
  sdb.prepare(
    "INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status) VALUES (1, 'Checkin User', 'checkin@example.com', '09170000000', 'SQLCHK-001', 'Confirmed')"
  ).run();

  function attemptCheckin(staffId) {
    return new Promise((resolve) => {
      setImmediate(() => {
        const now = new Date().toISOString();
        const upd = sdb.prepare(
          "UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE ticket_code=? AND status='Confirmed'"
        ).run(now, staffId, 'SQLCHK-001');
        if (upd.changes === 0) {
          const row = sdb.prepare('SELECT checked_in_at FROM registrations WHERE ticket_code=?').get('SQLCHK-001');
          resolve({ status: 'already', checkin_time: row.checked_in_at });
        } else {
          resolve({ status: 'success', checkin_time: now });
        }
      });
    });
  }

  const chkResults = await Promise.all([attemptCheckin(1), attemptCheckin(2)]);
  assert.strictEqual(chkResults.filter(r => r.status === 'success').length, 1);
  assert.strictEqual(chkResults.filter(r => r.status === 'already').length, 1);
  console.log('✅ PASSED [SQLite]: Simultaneous check-in prevented double check-in.');
}

async function runPostgresRaceTests() {
  if (!process.env.DATABASE_URL) {
    console.log('\n[PostgreSQL] Skipped (DATABASE_URL not set).');
    return;
  }

  console.log('\n--- [PostgreSQL] Connecting for Neon concurrency tests ---');
  process.env.SKIP_AUTO_SEED = 'true';
  const db = require('../src/db/db');
  const { getConfirmedCount } = require('../src/utils/availability');
  const { nowCebu } = require('../src/utils/time');

  const insEv = await db.prepare(
    `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status)
     VALUES (?, ?, ?, ?, ?, ?, 'Published')`
  ).run(`__pg_race_test_${Date.now()}`, 'Temporary concurrency test', 'Test Lab', '2029-12-30 10:00:00', '2029-12-30 12:00:00', 1);
  const testEventId = insEv.lastInsertRowid;

  try {
    // 1. 10 concurrent registration transactions against Postgres using FOR UPDATE
    console.log('--- [PostgreSQL] Test 1: Last-Spot Registration Race (SELECT ... FOR UPDATE) ---');
    const regAttempts = Array.from({ length: 10 }, (_, i) => {
      const email = `pgrace${i + 1}_${Date.now()}@example.com`;
      const code = `PGR-${String(i + 1).padStart(5, '0')}-${Date.now().toString(36).slice(-8).toUpperCase()}`;
      return db.transaction(async () => {
        await db.prepare('SELECT id FROM events WHERE id = ? FOR UPDATE').get(testEventId);
        const currentConfirmed = await getConfirmedCount(testEventId);
        const now = nowCebu();
        if (currentConfirmed < 1) {
          await db.prepare(
            `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at)
             VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)`
          ).run(testEventId, `PG User ${i + 1}`, email, `09170000${String(i).padStart(3, '0')}`, code, now);
          return { status: 'Confirmed', code };
        }
        await db.prepare(
          `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos, registered_at)
           VALUES (?, ?, ?, ?, ?, 'Waitlisted', ?, ?)`
        ).run(testEventId, `PG User ${i + 1}`, email, `09170000${String(i).padStart(3, '0')}`, code, i, now);
        return { status: 'Waitlisted', code };
      })();
    });

    const pgRegResults = await Promise.all(regAttempts);
    const pgConfirmed = pgRegResults.filter(r => r.status === 'Confirmed');
    const pgWaitlisted = pgRegResults.filter(r => r.status === 'Waitlisted');
    assert.strictEqual(pgConfirmed.length, 1, `PG: Expected 1 Confirmed, got ${pgConfirmed.length}`);
    assert.strictEqual(pgWaitlisted.length, 9, `PG: Expected 9 Waitlisted, got ${pgWaitlisted.length}`);
    console.log('✅ PASSED [PostgreSQL]: 1 Confirmed, 9 Waitlisted under 10 concurrent FOR UPDATE transactions.');

    // 2. Simultaneous atomic check-in against Postgres on that confirmed row
    console.log('--- [PostgreSQL] Test 2: Simultaneous Atomic Check-in (WHERE status = Confirmed) ---');
    const confirmedCode = pgConfirmed[0].code;
    const confirmedRow = await db.prepare('SELECT id FROM registrations WHERE ticket_code = ?').get(confirmedCode);

    const attemptPgCheckin = async (delayOffsetMs) => {
      const ts = new Date(Date.now() + delayOffsetMs).toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).replace('T', ' ');
      const upd = await db.prepare(
        `UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=NULL WHERE id=? AND status='Confirmed'`
      ).run(ts, confirmedRow.id);
      if (upd.changes === 0) {
        const fresh = await db.prepare('SELECT checked_in_at FROM registrations WHERE id = ?').get(confirmedRow.id);
        return { status: 'already', checkin_time: fresh.checked_in_at };
      }
      return { status: 'success', checkin_time: ts };
    };

    const pgChkResults = await Promise.all([attemptPgCheckin(0), attemptPgCheckin(500)]);
    assert.strictEqual(pgChkResults.filter(r => r.status === 'success').length, 1, 'PG: Exactly 1 check-in succeeds');
    assert.strictEqual(pgChkResults.filter(r => r.status === 'already').length, 1, 'PG: Concurrent scan returns already');
    console.log('✅ PASSED [PostgreSQL]: Atomic conditional UPDATE prevented double check-in.');

    // 3. Unique partial index prevents duplicate active email in Postgres
    console.log('--- [PostgreSQL] Test 3: Unique Partial Index Verification ---');
    let dupBlocked = false;
    try {
      const dupEmail = `pgdup_${Date.now()}@example.com`;
      await db.prepare(
        `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status)
         VALUES (?, 'Dup 1', ?, '09171119991', ?, 'Confirmed')`
      ).run(testEventId, dupEmail, `DUP-A-${Date.now()}`);
      await db.prepare(
        `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status)
         VALUES (?, 'Dup 2', ?, '09171119992', ?, 'Confirmed')`
      ).run(testEventId, dupEmail, `DUP-B-${Date.now()}`);
    } catch (err) {
      dupBlocked = err.code === '23505';
    }
    assert.strictEqual(dupBlocked, true, 'PG: uq_event_email_active must reject duplicate active email with 23505');
    console.log('✅ PASSED [PostgreSQL]: Unique partial index enforced active email uniqueness.');
  } finally {
    await db.prepare('DELETE FROM registrations WHERE event_id = ?').run(testEventId);
    await db.prepare('DELETE FROM events WHERE id = ?').run(testEventId);
    if (db.pool) await db.pool.end();
  }
}

async function run() {
  try {
    await runSqliteRaceTests();
    await runPostgresRaceTests();
    console.log('\n========================================');
    console.log('🎉 ALL CONCURRENCY & RACE TESTS PASSED!');
    console.log('========================================\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

run();
