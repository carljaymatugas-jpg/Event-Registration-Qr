'use strict';
require('dotenv').config();
const db = require('./db');
const bcrypt = require('bcryptjs');
const { generateTicketCode } = require('../utils/ticket');
const { nowCebu } = require('../utils/time');

let activeSeedPromise = null;

/**
 * Idempotently seeds staff accounts, canonical events, and fills Cebu Dev Meetup 2026 (30/30).
 * Pass { reset: true } ONLY when ALLOW_RESEED=true to reset events/registrations/audit_logs.
 */
async function runSeed(options = {}) {
  const reset = Boolean(options.reset);
  const closePool = Boolean(options.closePool);

  const allowReseed = process.env.ALLOW_RESEED === 'true' || process.argv.includes('--allow-reseed');
  if (reset && !allowReseed) {
    throw new Error('Refusing reset/reseed: set ALLOW_RESEED=true or pass --allow-reseed explicitly.');
  }

  const orgArg = process.argv.find(a => a.startsWith('--org-password='));
  const doorArg = process.argv.find(a => a.startsWith('--door-password='));
  const orgPassword = (orgArg ? orgArg.slice('--org-password='.length) : null) || process.env.SEED_ORGANIZER_PASSWORD || 'organizer123';
  const doorPassword = (doorArg ? doorArg.slice('--door-password='.length) : null) || process.env.SEED_DOOR_PASSWORD || 'door123';

  if (reset) {
    console.log('ALLOW_RESEED=true detected — resetting events, registrations, and audit logs...');
    const resetTx = db.transaction(async () => {
      if (db.isPostgres) {
        await db.exec('TRUNCATE TABLE audit_logs, registrations, events RESTART IDENTITY CASCADE');
      } else {
        db.exec('DELETE FROM audit_logs');
        db.exec('DELETE FROM registrations');
        db.exec('DELETE FROM events');
        try {
          db.exec("DELETE FROM sqlite_sequence WHERE name IN ('audit_logs','registrations','events')");
        } catch (_) {}
      }
    });
    await resetTx();
  }

  // Staff accounts (idempotent insert; update passwords when resetting)
  async function ensureStaffUser(name, username, password, role) {
    const existing = await db.prepare('SELECT id FROM staff_users WHERE username = ?').get(username);
    if (!existing) {
      const hash = bcrypt.hashSync(password, 12);
      await db.prepare('INSERT INTO staff_users (name, username, password_hash, role) VALUES (?,?,?,?)')
        .run(name, username, hash, role);
      console.log(`Seeded staff user: ${username} (${role})`);
    } else if (reset || process.argv.includes('--update-passwords')) {
      const hash = bcrypt.hashSync(password, 12);
      await db.prepare('UPDATE staff_users SET name = ?, password_hash = ?, role = ? WHERE username = ?')
        .run(name, hash, role, username);
      console.log(`Updated staff user credentials for: ${username}`);
    }
  }

  await ensureStaffUser('Event Organizer', 'organizer', orgPassword, 'organizer');
  await ensureStaffUser('Door Staff', 'doorstaff', doorPassword, 'door');

  // Events
  async function seedEvent(title, desc, venue, startsAt, endsAt, capacity, status) {
    const ex = await db.prepare('SELECT id FROM events WHERE title = ?').get(title);
    if (!ex) {
      await db.prepare(`INSERT INTO events (title,description,venue,starts_at,ends_at,capacity,status)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(title, desc, venue, startsAt, endsAt, capacity, status);
      console.log(`Seeded event: ${title}`);
    }
  }

  await seedEvent(
    'Cebu Dev Meetup 2026',
    'Join Cebu\'s developer and tech community for an evening of engineering talks on AI, Web, and Mobile development, followed by networking.',
    'Ayala Center Cebu, Function Room 2',
    '2026-12-15 14:00:00',
    '2026-12-15 18:00:00',
    30,
    'Published'
  );

  await seedEvent(
    'UX Design Workshop',
    'A hands-on half-day workshop on user research, wireframing, and prototyping with Figma. Bring your laptop.',
    'IT Park, Cebu City – Co-Lab Space',
    '2026-12-20 09:00:00',
    '2026-12-20 13:00:00',
    20,
    'Published'
  );

  await seedEvent(
    'Draft: Future PHP Conf',
    'Draft event — not visible to attendees yet.',
    'TBD',
    '2027-01-15 09:00:00',
    '2027-01-15 17:00:00',
    50,
    'Draft'
  );

  // Fill Cebu Dev Meetup 2026 to full capacity (30/30 Confirmed) idempotently
  const fullEvent = await db.prepare('SELECT id, capacity FROM events WHERE title = ?').get('Cebu Dev Meetup 2026');
  if (fullEvent) {
    const regCountRow = await db.prepare(
      `SELECT COUNT(*) as c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`
    ).get(fullEvent.id);
    const regCount = Number((regCountRow && regCountRow.c) || 0);
    if (regCount < fullEvent.capacity) {
      const needed = fullEvent.capacity - regCount;
      const now = nowCebu();
      const fillTx = db.transaction(async () => {
        let added = 0;
        let idx = 1;
        while (added < needed && idx <= 200) {
          const email = `testattendee${idx}@example.com`;
          const dup = await db.prepare(
            `SELECT id FROM registrations WHERE event_id = ? AND LOWER(email) = ? AND status IN ('Confirmed','CheckedIn','Waitlisted')`
          ).get(fullEvent.id, email);
          if (!dup) {
            const code = generateTicketCode('CDM');
            await db.prepare(
              `INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?,?,?,?,?,?,?)`
            ).run(fullEvent.id, `Test Attendee ${idx}`, email, `09${String(100000000 + idx)}`, code, 'Confirmed', now);
            added++;
          }
          idx++;
        }
        return added;
      });
      const added = await fillTx();
      console.log(`Seeded ${added} registrations to fill Cebu Dev Meetup 2026`);
    }
  }

  console.log('Seed complete.');
  if (closePool && db.isPostgres && db.pool) {
    await db.pool.end();
  }
}

function seed(options = {}) {
  if (options.reset) {
    return runSeed(options);
  }
  if (!activeSeedPromise) {
    activeSeedPromise = runSeed(options).finally(() => {
      activeSeedPromise = null;
    });
  }
  return activeSeedPromise;
}

if (require.main === module) {
  const isReset = process.argv.includes('--reset');
  seed({ reset: isReset, closePool: true })
    .then(() => process.exit(0))
    .catch(err => {
      console.error('Seed error:', err.message);
      process.exit(1);
    });
}

module.exports = seed;
