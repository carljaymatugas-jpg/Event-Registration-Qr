'use strict';
require('dotenv').config();
const db = require('./db');
const bcrypt = require('bcryptjs');

// ── Seed staff ───────────────────────────────────────────────────────────────
const existing = db.prepare('SELECT id FROM staff_users WHERE username = ?').get('organizer');
if (!existing) {
  const hash = bcrypt.hashSync('organizer123', 12);
  db.prepare(`INSERT INTO staff_users (name, username, password_hash, role) VALUES (?,?,?,?)`)
    .run('Event Organizer', 'organizer', hash, 'organizer');
  console.log('Seeded organizer / organizer123');
}

const existingDoor = db.prepare('SELECT id FROM staff_users WHERE username = ?').get('doorstaff');
if (!existingDoor) {
  const hash = bcrypt.hashSync('door123', 12);
  db.prepare(`INSERT INTO staff_users (name, username, password_hash, role) VALUES (?,?,?,?)`)
    .run('Door Staff', 'doorstaff', hash, 'door');
  console.log('Seeded doorstaff / door123');
}

// ── Seed events ──────────────────────────────────────────────────────────────
function seedEvent(title, desc, venue, startsAt, endsAt, capacity, status) {
  const ex = db.prepare('SELECT id FROM events WHERE title = ?').get(title);
  if (!ex) {
    db.prepare(`INSERT INTO events (title,description,venue,starts_at,ends_at,capacity,status)
                VALUES (?,?,?,?,?,?,?)`)
      .run(title, desc, venue, startsAt, endsAt, capacity, status);
    console.log(`Seeded event: ${title}`);
  }
}

seedEvent(
  'Cebu Dev Meetup 2026',
  'Join Cebu\'s tech community for an evening of talks on AI, Web, and Mobile development. Networking session follows.',
  'Ayala Center Cebu, Function Room 2',
  '2026-12-15 14:00:00',
  '2026-12-15 18:00:00',
  30,
  'Published'
);

seedEvent(
  'UX Design Workshop',
  'A hands-on half-day workshop on user research, wireframing, and prototyping with Figma. Bring your laptop.',
  'IT Park, Cebu City – Co-Lab Space',
  '2026-12-20 09:00:00',
  '2026-12-20 13:00:00',
  20,
  'Published'
);

seedEvent(
  'Draft: Future PHP Conf',
  'Draft event — not visible to attendees yet.',
  'TBD',
  '2027-01-15 09:00:00',
  '2027-01-15 17:00:00',
  50,
  'Draft'
);

// ── Seed a FULL event (30/30 so testers see "Full") ───────────────────────────
const { nanoid } = require('nanoid');
const crypto = require('crypto');

function makeTicketCode(prefix) {
  const rand = nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
  const raw = `${prefix}-${rand}`;
  const hmac = crypto.createHmac('sha256', process.env.TICKET_HMAC_SECRET || 'dev')
    .update(raw).digest('hex').slice(0, 4).toUpperCase();
  return `${raw}-${hmac}`;
}

const fullEvent = db.prepare('SELECT id,capacity FROM events WHERE title = ?').get('Cebu Dev Meetup 2026');
if (fullEvent) {
  const regCount = db.prepare(`SELECT COUNT(*) as c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`).get(fullEvent.id).c;
  if (regCount < fullEvent.capacity) {
    const toAdd = fullEvent.capacity - regCount;
    const insertReg = db.prepare(`INSERT INTO registrations (event_id,full_name,email,mobile,ticket_code,status) VALUES (?,?,?,?,?,?)`);
    const insertMany = db.transaction((n) => {
      for (let i = 1; i <= n; i++) {
        const code = makeTicketCode('CDM');
        insertReg.run(fullEvent.id, `Test Attendee ${i}`, `testattendee${i}@example.com`, `09${String(100000000 + i)}`, code, 'Confirmed');
      }
    });
    insertMany(toAdd);
    console.log(`Seeded ${toAdd} registrations to fill Cebu Dev Meetup 2026`);
  }
}

console.log('Seed complete.');
