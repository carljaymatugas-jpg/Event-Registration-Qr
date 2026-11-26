'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { nowCebu } = require('../utils/time');
const { generateTicketCode } = require('../utils/ticket');
const { sendConfirmationEmail } = require('../utils/mailer');
const { normalizePHMobile, isValidPHMobile } = require('../utils/phone');
const { getEventAvailability, getConfirmedCount, getEventsWithAvailability } = require('../utils/availability');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Unicode-aware name validation: only Unicode letters and spaces between name parts
// Rejects numbers, symbols, emojis, and punctuation
const FULL_NAME_UNICODE_RE = /^[\p{L}]+(?:\s+[\p{L}]+)*$/u;

function sanitizeInput(str) {
  if (!str) return '';
  return String(str)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // strip script tags and content
    .replace(/<[^>]+>/g, '') // strip remaining HTML tags
    .trim();
}

/**
 * Validates a full name:
 * - Only Unicode letters (\p{L}) and spaces allowed
 * - No numbers, symbols, emojis, or punctuation
 * - Rejects whitespace-only input
 * - Preserves original capitalization
 */
function validateFullName(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, msg: 'Full name is required.' };
  // Strip leading/trailing whitespace only for validation; preserve interior spaces
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, msg: 'Full name cannot be empty or contain only spaces.' };
  if (trimmed.length < 2) return { valid: false, msg: 'Full name must be at least 2 characters.' };
  if (trimmed.length > 100) return { valid: false, msg: 'Full name cannot exceed 100 characters.' };
  // Check for tab/newline/control characters
  if (/[\t\n\r\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, msg: 'Full name must contain letters and spaces only. Numbers, special characters, and emojis are not allowed.' };
  }
  // Unicode-aware: only letters and single spaces between name parts
  if (!FULL_NAME_UNICODE_RE.test(trimmed)) {
    return { valid: false, msg: 'Full name must contain letters and spaces only. Numbers, special characters, and emojis are not allowed.' };
  }
  return { valid: true, value: trimmed };
}

// Home — event list (attendee): show only Published events that have not ended
router.get('/', async (req, res, next) => {
  try {
    const now = nowCebu();
    const allPublished = await getEventsWithAvailability({ statuses: ['Published'], order: 'ASC' });
    const events = allPublished.filter(ev => !ev.has_ended);
    res.render('index.html', { events, now });
  } catch (err) {
    next(err);
  }
});

// Event detail page
router.get('/events/:id', async (req, res, next) => {
  try {
    const event = await getEventAvailability(req.params.id);
    if (!event || event.status === 'Draft') return res.status(404).render('404.html');

    const now = nowCebu();
    res.render('event_detail.html', { event, now });
  } catch (err) {
    next(err);
  }
});

function getClosedRegistrationState(event) {
  if (event.status === 'Closed') {
    return { status: 400, msg: 'Registration is closed for this event.' };
  }
  if (event.has_ended) {
    return { status: 410, msg: 'Registration is closed because this event has already ended.' };
  }
  if (event.has_started) {
    return { status: 400, msg: 'Registration is closed because this event has already started.' };
  }
  return null;
}

// GET registration form
router.get('/events/:id/register', async (req, res, next) => {
  try {
    const event = await getEventAvailability(req.params.id);
    if (!event || event.status === 'Draft') return res.status(404).render('404.html');

    const now = nowCebu();
    const closed = getClosedRegistrationState(event);
    if (closed) {
      return res.status(closed.status).render('register.html', {
        event,
        errors: { form: closed.msg },
        values: {},
        now
      });
    }

    res.render('register.html', { event, errors: {}, values: {}, now });
  } catch (err) {
    next(err);
  }
});

// POST registration form
router.post('/events/:id/register', async (req, res, next) => {
  try {
    const now = nowCebu();
    const event = await getEventAvailability(req.params.id);
    const isJson = req.xhr || req.headers.accept?.includes('json');

    if (!event || event.status === 'Draft') {
      if (isJson) {
        return res.status(404).json({ error: 'Event not found or not published.' });
      }
      return res.status(404).render('404.html');
    }

    // Server-side enforcement: reject Closed, Ended, and Started events
    const closed = getClosedRegistrationState(event);
    if (closed) {
      if (isJson) return res.status(closed.status).json({ error: closed.msg });
      return res.status(closed.status).render('register.html', {
        event,
        errors: { form: closed.msg },
        values: req.body,
        now
      });
    }

    // Note: Waitlist is open for full upcoming Published events;
    // capacity is checked atomically inside the transaction below.

    const { full_name, email, mobile } = req.body;
    const errors = {};

    // TC-01 & TC-05: Required fields, input sanitization, XSS prevention & full name validation
    const rawNameInput = sanitizeInput(full_name || '');
    const nameValidation = validateFullName(rawNameInput);
    const rawName = nameValidation.valid ? nameValidation.value : rawNameInput;
    if (!nameValidation.valid) {
      errors.full_name = nameValidation.msg;
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

    // Atomic transaction for capacity check, waitlist placement, and duplicate check
    const registerTx = db.transaction(async () => {
      // Check duplicate across Confirmed, CheckedIn, and Waitlisted
      const dup = await db.prepare(`
        SELECT id, email, mobile, ticket_code, status FROM registrations
        WHERE event_id = ? AND (LOWER(email) = ? OR mobile = ?) AND status IN ('Confirmed','CheckedIn','Waitlisted')
      `).get(event.id, rawEmail, cleanMobile);

      if (dup) {
        const field = dup.email.toLowerCase() === rawEmail ? 'email' : 'mobile';
        const msg = dup.status === 'Waitlisted'
          ? (field === 'email' ? 'This email address is already on the waitlist for this event.' : 'This mobile number is already on the waitlist for this event.')
          : (field === 'email' ? 'This email address is already registered for this event.' : 'This mobile number is already registered for this event.');
        return { error: 'duplicate', field, message: msg };
      }

      // Re-read confirmed count atomically inside transaction using shared helper
      const currentConfirmed = await getConfirmedCount(event.id);

      const prefix = event.title.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'EVT';
      const ticketCode = generateTicketCode(prefix);

      // Final safety check: re-validate name inside transaction before saving
      const finalNameCheck = validateFullName(rawName);
      if (!finalNameCheck.valid) {
        return { error: 'invalid_name', message: finalNameCheck.msg };
      }

      if (currentConfirmed >= event.capacity) {
        const posRow = await db.prepare(`
          SELECT COUNT(*) + 1 AS pos FROM registrations WHERE event_id = ? AND status = 'Waitlisted'
        `).get(event.id);
        const pos = Number((posRow && posRow.pos) || 1);
        await db.prepare(`
          INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos, registered_at)
          VALUES (?, ?, ?, ?, ?, 'Waitlisted', ?, ?)
        `).run(event.id, finalNameCheck.value, rawEmail, cleanMobile, ticketCode, pos, now);
        return { ticketCode, status: 'Waitlisted', waitlistPos: pos };
      }

      await db.prepare(`
        INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at)
        VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)
      `).run(event.id, finalNameCheck.value, rawEmail, cleanMobile, ticketCode, now);

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

    if (result && result.error === 'invalid_name') {
      if (isJson) return res.status(400).json({ error: result.message, field: 'full_name' });
      return res.status(400).render('register.html', {
        event,
        errors: { full_name: result.message },
        values: req.body,
        now
      });
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

    // Send confirmation email asynchronously when Confirmed
    if (result.status === 'Confirmed') {
      const reg = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(result.ticketCode);
      if (reg) {
        sendConfirmationEmail(reg, event).catch(err => {
          console.error('Email dispatch notice (non-fatal):', err && err.message);
        });
      }
    }

    if (isJson) {
      return res.status(201).json({
        success: true,
        status: result.status,
        waitlistPos: result.waitlistPos || null,
        ticketCode: result.ticketCode,
        redirectUrl: `/ticket/${result.ticketCode}?email=${encodeURIComponent(rawEmail)}`
      });
    }

    // Redirect to ticket page (works for Confirmed and Waitlisted)
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
