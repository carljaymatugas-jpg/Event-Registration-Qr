'use strict';
const router = require('express').Router();
const db = require('../db/db');
const QRCode = require('qrcode');
const { generateTicketCode } = require('../utils/ticket');
const { nowCebu } = require('../utils/time');
const { sendConfirmationEmail } = require('../utils/mailer');

// Validate Philippine mobile: 11 digits starting with 09
const PH_MOBILE_RE = /^09\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET registration form
router.get('/events/:id/register', async (req, res, next) => {
  try {
    const event = await db.prepare(`SELECT * FROM events WHERE id = ? AND status = 'Published'`).get(req.params.id);
    if (!event) return res.status(404).render('404.html');
    res.render('register.html', { event, errors: {}, values: {} });
  } catch (err) {
    next(err);
  }
});

// POST registration form
router.post('/events/:id/register', async (req, res, next) => {
  try {
    const event = await db.prepare(`SELECT * FROM events WHERE id = ? AND status = 'Published'`).get(req.params.id);
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

    // Server-side: check capacity + duplicate (inside a transaction)
    const register = db.transaction(async () => {
      const dup = await db.prepare(`
        SELECT id, status FROM registrations
        WHERE event_id = ? AND email = ? AND status IN ('Confirmed','CheckedIn','Waitlisted')
      `).get(event.id, cleanEmail);
      if (dup) return { error: 'duplicate', status: dup.status };

      const confirmedRow = await db.prepare(`
        SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status IN ('Confirmed','CheckedIn')
      `).get(event.id);
      const confirmed = (confirmedRow && confirmedRow.c) || 0;

      const prefix = event.title.replace(/[^A-Z0-9]/gi, '').slice(0, 3).toUpperCase() || 'EVT';
      const ticketCode = generateTicketCode(prefix);
      const now = nowCebu();

      if (confirmed < event.capacity) {
        await db.prepare(`
          INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at)
          VALUES (?,?,?,?,?,'Confirmed',?)
        `).run(event.id, cleanName, cleanEmail, cleanMobile, ticketCode, now);
        return { ticketCode, status: 'Confirmed' };
      } else {
        const posRow = await db.prepare(`
          SELECT COUNT(*) + 1 AS pos FROM registrations WHERE event_id = ? AND status = 'Waitlisted'
        `).get(event.id);
        const pos = (posRow && posRow.pos) || 1;
        await db.prepare(`
          INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos, registered_at)
          VALUES (?,?,?,?,?,'Waitlisted',?,?)
        `).run(event.id, cleanName, cleanEmail, cleanMobile, ticketCode, pos, now);
        return { ticketCode, status: 'Waitlisted', waitlistPos: pos };
      }
    });

    let result;
    try {
      result = await register();
    } catch (err) {
      if (err.code === '23505' || err.message.includes('UNIQUE constraint') || err.message.includes('duplicate key')) {
        return res.render('register.html', { event, errors: { email: 'This email is already registered for this event.' }, values: req.body });
      }
      throw err;
    }

    if (result.error === 'duplicate') {
      const msg = result.status === 'Waitlisted'
        ? 'You are already on the waitlist for this event.'
        : 'This email is already registered for this event.';
      return res.render('register.html', { event, errors: { email: msg }, values: req.body });
    }

    if (result.status === 'Confirmed') {
      const reg = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(result.ticketCode);
      if (reg) sendConfirmationEmail(reg, event).catch(console.error);
    }

    res.redirect(`/ticket/${result.ticketCode}?email=${encodeURIComponent(cleanEmail)}`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
