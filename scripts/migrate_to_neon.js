'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is required.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const sqliteDbPath = path.resolve(__dirname, '../data/eventreg.db');
const sqlite = new DatabaseSync(sqliteDbPath);

async function migrate() {
  console.log('Connecting to Neon PostgreSQL...');
  const client = await pool.connect();

  try {
    console.log('Creating PostgreSQL schema...');
    await client.query('BEGIN');

    // 1. Events Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        venue TEXT NOT NULL,
        starts_at TIMESTAMP NOT NULL,
        ends_at TIMESTAMP NOT NULL,
        capacity INTEGER NOT NULL CHECK(capacity > 0),
        status TEXT NOT NULL DEFAULT 'Draft' CHECK(status IN ('Draft','Published','Closed')),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Staff Users Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS staff_users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'door' CHECK(role IN ('organizer','door')),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Registrations Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS registrations (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        full_name TEXT NOT NULL,
        email TEXT NOT NULL,
        mobile TEXT NOT NULL,
        ticket_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'Confirmed' CHECK(status IN ('Confirmed','CheckedIn','Waitlisted','Cancelled')),
        waitlist_pos INTEGER,
        registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        checked_in_at TIMESTAMP,
        checked_in_by INTEGER REFERENCES staff_users(id),
        undo_at TIMESTAMP,
        undo_by INTEGER REFERENCES staff_users(id)
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_event_email_active
      ON registrations(event_id, email)
      WHERE status IN ('Confirmed','CheckedIn','Waitlisted');
    `);

    // 4. Audit Logs Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        staff_user_id INTEGER,
        action TEXT NOT NULL,
        target_id INTEGER,
        detail TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 5. Connect-PG-Simple Session Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" varchar NOT NULL COLLATE "default",
        "sess" json NOT NULL,
        "expire" timestamp(6) NOT NULL,
        CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");`);

    await client.query('COMMIT');
    console.log('✓ PostgreSQL tables and indexes ready.');

    // Copy Events from SQLite
    const sqliteEvents = sqlite.prepare('SELECT * FROM events').all();
    console.log(`Copying ${sqliteEvents.length} events from SQLite to Neon...`);
    for (const ev of sqliteEvents) {
      await client.query(`
        INSERT INTO events (id, title, description, venue, starts_at, ends_at, capacity, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          venue = EXCLUDED.venue,
          starts_at = EXCLUDED.starts_at,
          ends_at = EXCLUDED.ends_at,
          capacity = EXCLUDED.capacity,
          status = EXCLUDED.status;
      `, [ev.id, ev.title, ev.description, ev.venue, ev.starts_at, ev.ends_at, ev.capacity, ev.status, ev.created_at || new Date().toISOString()]);
    }
    await client.query(`SELECT setval('events_id_seq', (SELECT COALESCE(MAX(id), 1) FROM events));`);

    // Copy Staff Users from SQLite
    const sqliteStaff = sqlite.prepare('SELECT * FROM staff_users').all();
    console.log(`Copying ${sqliteStaff.length} staff users from SQLite to Neon...`);
    for (const su of sqliteStaff) {
      await client.query(`
        INSERT INTO staff_users (id, name, username, password_hash, role, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          username = EXCLUDED.username,
          password_hash = EXCLUDED.password_hash,
          role = EXCLUDED.role;
      `, [su.id, su.name, su.username, su.password_hash, su.role, su.created_at || new Date().toISOString()]);
    }
    await client.query(`SELECT setval('staff_users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM staff_users));`);

    // Copy Registrations from SQLite
    const sqliteRegs = sqlite.prepare('SELECT * FROM registrations').all();
    console.log(`Copying ${sqliteRegs.length} registrations from SQLite to Neon...`);
    for (const reg of sqliteRegs) {
      await client.query(`
        INSERT INTO registrations (id, event_id, full_name, email, mobile, ticket_code, status, waitlist_pos, registered_at, checked_in_at, checked_in_by, undo_at, undo_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          waitlist_pos = EXCLUDED.waitlist_pos,
          checked_in_at = EXCLUDED.checked_in_at,
          checked_in_by = EXCLUDED.checked_in_by,
          undo_at = EXCLUDED.undo_at,
          undo_by = EXCLUDED.undo_by;
      `, [reg.id, reg.event_id, reg.full_name, reg.email, reg.mobile, reg.ticket_code, reg.status, reg.waitlist_pos, reg.registered_at, reg.checked_in_at, reg.checked_in_by, reg.undo_at, reg.undo_by]);
    }
    await client.query(`SELECT setval('registrations_id_seq', (SELECT COALESCE(MAX(id), 1) FROM registrations));`);

    // Copy Audit Logs
    const sqliteLogs = sqlite.prepare('SELECT * FROM audit_logs').all();
    console.log(`Copying ${sqliteLogs.length} audit logs from SQLite to Neon...`);
    for (const l of sqliteLogs) {
      await client.query(`
        INSERT INTO audit_logs (id, staff_user_id, action, target_id, detail, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING;
      `, [l.id, l.staff_user_id, l.action, l.target_id, l.detail, l.created_at]);
    }
    await client.query(`SELECT setval('audit_logs_id_seq', (SELECT COALESCE(MAX(id), 1) FROM audit_logs));`);

    console.log('\n========================================');
    console.log('🎉 SUCCESS: MIGRATED SQLITE DATA TO NEON!');
    console.log('========================================');

    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM staff_users) AS staff,
        (SELECT COUNT(*) FROM registrations) AS registrations,
        (SELECT COUNT(*) FROM audit_logs) AS logs
    `);
    console.log('Neon Database Summary:', counts.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  process.exit(1);
});
