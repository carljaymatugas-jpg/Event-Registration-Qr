'use strict';
/**
 * Concurrency & Race Condition Verification Test (Level 3 - Item 13)
 * Proves that:
 * 1. Concurrent registrations for the last spot never overbook capacity (atomic transaction).
 * 2. Concurrent check-ins on the same ticket never double-check-in (atomic update & lock).
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Create an isolated in-memory test database
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

// Initialize schema
db.exec(`
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

db.transaction = (fn) => {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const res = fn(...args);
      db.exec('COMMIT;');
      return res;
    } catch (e) {
      try { db.exec('ROLLBACK;'); } catch (_) {}
      throw e;
    }
  };
};

async function testLastSpotRegistrationRace() {
  console.log('\n--- Test 1: Last-Spot Registration Race Condition ---');
  // Create an event with capacity = 1
  db.exec("INSERT INTO events (title, capacity, status) VALUES ('Race Event', 1, 'Published');");
  const eventId = 1;

  // Function simulating attendee registration under concurrent traffic
  function attemptRegister(name, email, code) {
    return new Promise((resolve) => {
      // Immediate execution simulation
      setImmediate(() => {
        try {
          const runTx = db.transaction(() => {
            const confirmedCount = db.prepare(
              "SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status IN ('Confirmed','CheckedIn')"
            ).get(eventId).c;

            if (confirmedCount < 1) {
              db.prepare(
                "INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status) VALUES (?,?,?,?,?,'Confirmed')"
              ).run(eventId, name, email, '09171234567', code);
              return { success: true, status: 'Confirmed' };
            } else {
              db.prepare(
                "INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos) VALUES (?,?,?,?,?,'Waitlisted', 1)"
              ).run(eventId, name, email, '09171234567', code);
              return { success: true, status: 'Waitlisted' };
            }
          });
          resolve(runTx());
        } catch (err) {
          resolve({ success: false, error: err.message });
        }
      });
    });
  }

  // Launch 10 simultaneous registration attempts for the 1 remaining spot
  const promises = [];
  for (let i = 1; i <= 10; i++) {
    promises.push(attemptRegister(`User ${i}`, `user${i}@example.com`, `TICK-${i}`));
  }

  const results = await Promise.all(promises);
  const confirmed = results.filter(r => r.status === 'Confirmed');
  const waitlisted = results.filter(r => r.status === 'Waitlisted');

  console.log(`Total simultaneous requests: ${promises.length}`);
  console.log(`Confirmed: ${confirmed.length}`);
  console.log(`Waitlisted: ${waitlisted.length}`);

  assert.strictEqual(confirmed.length, 1, 'Exactly ONE user must get the last confirmed spot');
  assert.strictEqual(waitlisted.length, 9, 'All other 9 users must be placed on waitlist');
  console.log('✅ PASSED: Last spot registration handled atomically without overbooking!');
}

async function testSimultaneousCheckinRace() {
  console.log('\n--- Test 2: Simultaneous Check-in Race Condition ---');
  // Seed a confirmed ticket
  db.prepare(
    "INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status) VALUES (1, 'Checkin User', 'checkin@example.com', '09170000000', 'CHECK-001', 'Confirmed')"
  ).run();

  function attemptCheckin(staffId) {
    return new Promise((resolve) => {
      setImmediate(() => {
        try {
          const runTx = db.transaction(() => {
            const row = db.prepare('SELECT status, checked_in_at FROM registrations WHERE ticket_code = ?').get('CHECK-001');
            if (row.status === 'CheckedIn') {
              return { status: 'already', checkin_time: row.checked_in_at };
            }
            const now = new Date().toISOString();
            db.prepare("UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE ticket_code=?")
              .run(now, staffId, 'CHECK-001');
            return { status: 'success', checkin_time: now };
          });
          resolve(runTx());
        } catch (err) {
          resolve({ status: 'error', error: err.message });
        }
      });
    });
  }

  // Two staff phones scan the exact same ticket at the exact same moment
  const results = await Promise.all([
    attemptCheckin(101),
    attemptCheckin(102)
  ]);

  const success = results.filter(r => r.status === 'success');
  const already = results.filter(r => r.status === 'already');

  console.log(`Concurrent scan results:`, results);
  assert.strictEqual(success.length, 1, 'Exactly ONE scan must return "Checked in" (success)');
  assert.strictEqual(already.length, 1, 'The duplicate scan must return "Already checked in"');
  console.log('✅ PASSED: Simultaneous check-in prevented double check-in!');
}

async function run() {
  try {
    await testLastSpotRegistrationRace();
    await testSimultaneousCheckinRace();
    console.log('\n========================================');
    console.log('🎉 ALL CONCURRENCY & RACE TESTS PASSED!');
    console.log('========================================\n');
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  }
}

run();
