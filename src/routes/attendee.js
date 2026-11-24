'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { nowCebu } = require('../utils/time');
const { generateTicketCode } = require('../utils/ticket');
const { sendConfirmationEmail } = require('../utils/mailer');
const { normalizePHMobile, isValidPHMobile } = require('../utils/phone');
const { getEventCategory } = require('../utils/category');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeInput(str) {
  if (!str) return '';
  return String(str)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // strip script tags and content
    .replace(/<[^>]+>/g, '') // strip remaining HTML tags
    .trim();
}

// Helper to decorate event object
function decorateEvent(ev, now) {
  ev.spots_left = Math.max(0, ev.capacity - (ev.confirmed_count || 0));
  ev.is_full = ev.spots_left <= 0;
  ev.has_started = ev.starts_at <= now;
  ev.has_ended = ev.ends_at <= now;
  ev.is_past = ev.has_ended;
  ev.is_closed = ev.has_started || ev.is_full || ev.status === 'Closed';
  ev.category = getEventCategory(ev.title, ev.description);
  ev.is_free = true; // All community events currently have free admission
  return ev;
}

// Home — event list (attendee)
router.get('/', async (req, res, next) => {
  try {
    const now = nowCebu();
    const events = await db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count
      FROM events e
      WHERE e.status = 'Published'
      ORDER BY e.starts_at ASC
    `).all();

    events.forEach(ev => decorateEvent(ev, now));

    res.render('index.html', { events, now });
  } catch (err) {
    next(err);
  }
});

// Event detail page
router.get('/events/:id', async (req, res, next) => {
  try {
    const event = await db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count
      FROM events e WHERE e.id = ? AND e.status = 'Published'
    `).get(req.params.id);

    if (!event) return res.status(404).render('404.html');

    const now = nowCebu();
    decorateEvent(event, now);

    res.render('event_detail.html', { event, now });
  } catch (err) {
    next(err);
  }
});

// GET registration form
router.get('/events/:id/register', async (req, res, next) => {
  try {
    const event = await db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count
      FROM events e WHERE e.id = ? AND e.status = 'Published'
    `).get(req.params.id);

    if (!event) return res.status(404).render('404.html');

    const now = nowCebu();
    decorateEvent(event, now);

    res.render('register.html', { event, errors: {}, values: {}, now });
  } catch (err) {
    next(err);
  }
});

// POST registration form
router.post('/events/:id/register', async (req, res, next) => {
  try {
    const now = nowCebu();
    const event = await db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count
      FROM events e WHERE e.id = ? AND e.status = 'Published'
    `).get(req.params.id);

    if (!event) {
      if (req.xhr || req.headers.accept?.includes('json')) {
        return res.status(404).json({ error: 'Event not found or not published.' });
      }
      return res.status(404).render('404.html');
    }

    decorateEvent(event, now);

    const isJson = req.xhr || req.headers.accept?.includes('json');

    // TC-07 & Phase 2: Close registration automatically for started or concluded events
    if (event.has_started) {
      const closeMsg = event.has_ended
        ? 'Registration is closed because this event has already concluded.'
        : 'Registration is closed because this event has already started.';
      if (isJson) return res.status(400).json({ error: closeMsg });
      return res.status(400).render('register.html', {
        event,
        errors: { form: closeMsg },
        values: req.body,
        now
      });
    }

    // TC-04: Sold out capacity enforcement
    if (event.is_full) {
      const soldOutMsg = 'This event is sold out. No spots remaining.';
      if (isJson) return res.status(400).json({ error: soldOutMsg });
      return res.status(400).render('register.html', {
        event,
        errors: { form: soldOutMsg },
        values: req.body,
        now
      });
    }

    const { full_name, email, mobile } = req.body;
    const errors = {};

    // TC-01 & TC-05: Required fields, input sanitization & XSS prevention
    const rawName = sanitizeInput(full_name || '');
    if (!rawName || rawName.length < 2) {
      errors.full_name = 'Full name is required (minimum 2 characters, without HTML tags).';
    } else if (rawName.length > 100) {
      errors.full_name = 'Full name cannot exceed 100 characters.';
    }

    // TC-02a: Invalid email formats
    const rawEmail = (email || '').trim().toLowerCase();
    if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
      errors.email = 'A valid email address is required (e.g. name@example.com).';
    } else if (rawEmail.length > 150) {
      errors.email = 'Email address cannot exceed 150 characters.';
    }

    // TC-02b: Invalid phone formats (support 09XXXXXXXXX and +639XXXXXXXXX)
    const rawMobile = (mobile || '').trim();
    const cleanMobile = normalizePHMobile(rawMobile);
    if (!cleanMobile || !isValidPHMobile(cleanMobile)) {
      errors.mobile = 'Mobile must be a valid 11-digit Philippine number (e.g. 09171234567 or +639171234567).';
    }

    if (Object.keys(errors).length > 0) {
      if (isJson) return res.status(400).json({ errors });
      return res.status(400).render('register.html', { event, errors, values: req.body, now });
    }

    // Atomic transaction for capacity check and duplicate check
    const registerTx = db.transaction(async () => {
      // TC-03: Duplicate registration by email OR phone
      const dup = await db.prepare(`
        SELECT id, email, mobile, ticket_code FROM registrations
        WHERE event_id = ? AND (LOWER(email) = ? OR mobile = ?) AND status IN ('Confirmed','CheckedIn')
      `).get(event.id, rawEmail, cleanMobile);

      if (dup) {
        const field = dup.email.toLowerCase() === rawEmail ? 'email' : 'mobile';
        const msg = field === 'email'
          ? 'This email address is already registered for this event.'
          : 'This mobile number is already registered for this event.';
        return { error: 'duplicate', field, message: msg };
      }

      // Re-read current confirmed count atomically inside the transaction
      const confirmedRow = await db.prepare(`
        SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status IN ('Confirmed','CheckedIn')
      `).get(event.id);
      const currentConfirmed = (confirmedRow && confirmedRow.c) || 0;

      if (currentConfirmed >= event.capacity) {
        return { error: 'sold_out', message: 'This event is sold out. No spots remaining.' };
      }

      const prefix = event.title.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'EVT';
      const ticketCode = generateTicketCode(prefix);

      await db.prepare(`
        INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at)
        VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)
      `).run(event.id, rawName, rawEmail, cleanMobile, ticketCode, now);

      return { ticketCode, status: 'Confirmed' };
    });

    let result;
    try {
      result = await registerTx();
    } catch (err) {
      if (err.code === '23505' || err.message.includes('UNIQUE constraint') || err.message.includes('duplicate key')) {
        const dupMsg = 'You are already registered for this event.';
        if (isJson) return res.status(400).json({ error: dupMsg });
        return res.status(400).render('register.html', {
          event,
          errors: { email: dupMsg },
          values: req.body,
          now
        });
      }
      throw err;
    }

    if (result.error === 'duplicate') {
      if (isJson) return res.status(400).json({ error: result.message, field: result.field });
      return res.status(400).render('register.html', {
        event,
        errors: { [result.field]: result.message },
        values: req.body,
        now
      });
    }

    if (result.error === 'sold_out') {
      if (isJson) return res.status(400).json({ error: result.message });
      return res.status(400).render('register.html', {
        event,
        errors: { form: result.message },
        values: req.body,
        now
      });
    }

    // Asynchronously send email without blocking the response or losing registration on fail
    const reg = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(result.ticketCode);
    if (reg) {
      sendConfirmationEmail(reg, event).catch(err => {
        console.error('Email dispatch notice (non-fatal):', err && err.message);
      });
    }

    if (isJson) {
      return res.status(201).json({
        success: true,
        ticketCode: result.ticketCode,
        redirectUrl: `/ticket/${result.ticketCode}?email=${encodeURIComponent(rawEmail)}`
      });
    }

    // Redirect to ticket confirmation page
    res.redirect(`/ticket/${result.ticketCode}?email=${encodeURIComponent(rawEmail)}`);
  } catch (err) {
    next(err);
  }
});

// GET ticket lookup form
router.get('/lookup', (req, res) => {
  res.render('ticket_lookup.html', { error: null });
});

// POST ticket lookup
router.post('/lookup', (req, res) => {
  const { ticket_code, email, identifier } = req.body;
  const idVal = (identifier || email || '').trim();
  const codeVal = (ticket_code || '').trim().toUpperCase();

  if (!codeVal || !idVal) {
    return res.status(400).render('ticket_lookup.html', { error: 'Both ticket code and email (or mobile) are required.' });
  }

  res.redirect(`/ticket/${encodeURIComponent(codeVal)}?identifier=${encodeURIComponent(idVal)}`);
});

module.exports = router;
