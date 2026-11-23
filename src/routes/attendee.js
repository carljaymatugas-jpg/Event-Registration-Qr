'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { nowCebu } = require('../utils/time');
const { generateTicketCode } = require('../utils/ticket');
const { sendConfirmationEmail } = require('../utils/mailer');

const PH_MOBILE_RE = /^09\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Home — event list (attendee)
router.get('/', (req, res) => {
  const now = nowCebu();
  const events = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count
    FROM events e
    WHERE e.status = 'Published'
    ORDER BY e.starts_at ASC
  `).all();

  events.forEach(ev => {
    ev.spots_left = ev.capacity - ev.confirmed_count;
    ev.is_full = ev.spots_left <= 0;
    ev.is_past = ev.ends_at < now;
  });

  res.render('index.html', { events, now });
});

// Event detail page
router.get('/events/:id', (req, res) => {
  const event = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count
    FROM events e WHERE e.id = ? AND e.status = 'Published'
  `).get(req.params.id);

  if (!event) return res.status(404).render('404.html');

  const now = nowCebu();
  event.spots_left = event.capacity - event.confirmed_count;
  event.is_full = event.spots_left <= 0;
  event.is_past = event.ends_at < now;

  res.render('event_detail.html', { event });
});

// GET registration form
router.get('/events/:id/register', (req, res) => {
  const event = db.prepare(`SELECT * FROM events WHERE id = ? AND status = 'Published'`).get(req.params.id);
  if (!event) return res.status(404).render('404.html');
  res.render('register.html', { event, errors: {}, values: {} });
});

// POST registration form
router.post('/events/:id/register', (req, res) => {
  const event = db.prepare(`SELECT * FROM events WHERE id = ? AND status = 'Published'`).get(req.params.id);
  if (!event) return res.status(404).render('404.html');

  const { full_name, email, mobile } = req.body;
  const errors = {};

  if (!full_name || full_name.trim().length < 2) errors.full_name = 'Full name is required.';
  if (!email || !EMAIL_RE.test(email.trim())) errors.email = 'A valid email address is required.';
  if (!mobile || !PH_MOBILE_RE.test(mobile.trim())) errors.mobile = 'Mobile must be 11 digits starting with 09 (e.g. 09171234567).';

  if (Object.keys(errors).length) {
    return res.render('register.html', { event, errors, values: req.body });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanMobile = mobile.trim();
  const cleanName = full_name.trim();

  const register = db.transaction(() => {
    const dup = db.prepare(`
      SELECT id, status FROM registrations
      WHERE event_id = ? AND email = ? AND status IN ('Confirmed','CheckedIn','Waitlisted')
    `).get(event.id, cleanEmail);
    if (dup) return { error: 'duplicate', status: dup.status };

    const confirmed = db.prepare(`
      SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status IN ('Confirmed','CheckedIn')
    `).get(event.id).c;

    const prefix = event.title.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'EVT';
    const ticketCode = generateTicketCode(prefix);
    const now = nowCebu();

    if (confirmed < event.capacity) {
      db.prepare(`INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?,?,?,?,?,'Confirmed',?)`)
        .run(event.id, cleanName, cleanEmail, cleanMobile, ticketCode, now);
      return { ticketCode, status: 'Confirmed' };
    } else {
      const pos = db.prepare(`SELECT COUNT(*) + 1 AS pos FROM registrations WHERE event_id = ? AND status = 'Waitlisted'`).get(event.id).pos;
      db.prepare(`INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos, registered_at) VALUES (?,?,?,?,?,'Waitlisted',?,?)`)
        .run(event.id, cleanName, cleanEmail, cleanMobile, ticketCode, pos, now);
      return { ticketCode, status: 'Waitlisted', waitlistPos: pos };
    }
  });

  let result;
  try {
    result = register();
  } catch (err) {
    if (err.message.includes('UNIQUE constraint')) {
      return res.render('register.html', { event, errors: { email: 'This email is already registered for this event.' }, values: req.body });
    }
    throw err;
  }

  if (result.error === 'duplicate') {
    const msg = result.status === 'Waitlisted' ? 'You are already on the waitlist.' : 'This email is already registered for this event.';
    return res.render('register.html', { event, errors: { email: msg }, values: req.body });
  }

  if (result.status === 'Confirmed') {
    const reg = db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(result.ticketCode);
    sendConfirmationEmail(reg, event).catch(console.error);
  }

  res.redirect(`/ticket/${result.ticketCode}?email=${encodeURIComponent(cleanEmail)}`);
});

// GET ticket lookup form
router.get('/lookup', (req, res) => {
  res.render('ticket_lookup.html', { error: null });
});

// POST ticket lookup
router.post('/lookup', (req, res) => {
  const { ticket_code, email, identifier } = req.body;
  const idVal = (identifier || email || '').trim();
  if (!ticket_code || !idVal) return res.render('ticket_lookup.html', { error: 'Both fields are required.' });
  res.redirect(`/ticket/${ticket_code.trim().toUpperCase()}?identifier=${encodeURIComponent(idVal)}`);
});

module.exports = router;
