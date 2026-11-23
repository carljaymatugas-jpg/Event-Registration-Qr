'use strict';
const router = require('express').Router();
const db = require('../db/db');
const QRCode = require('qrcode');
const { verifyTicketCode } = require('../utils/ticket');
const { nowCebu } = require('../utils/time');

// GET /ticket/:code?email=... or ?identifier=...
router.get('/:code', async (req, res) => {
  const { code } = req.params;
  const { email, identifier, msg } = req.query;
  const idVal = (identifier || email || '').trim();

  if (!idVal) {
    // No email/identifier — send to lookup
    return res.redirect(`/lookup`);
  }

  if (!verifyTicketCode(code)) {
    return res.render('ticket_lookup.html', { error: 'Ticket not found.' });
  }

  const reg = db.prepare(`
    SELECT r.*, e.title as event_title, e.venue, e.starts_at, e.ends_at
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    WHERE r.ticket_code = ? AND (LOWER(r.email) = LOWER(?) OR r.mobile = ?)
  `).get(code, idVal, idVal);

  if (!reg) {
    return res.render('ticket_lookup.html', { error: 'Ticket not found.' });
  }

  let qrDataUrl = null;
  if (reg.status !== 'Cancelled') {
    qrDataUrl = await QRCode.toDataURL(code, { width: 300 });
  }

  res.render('ticket.html', { reg, qrDataUrl, identifier: idVal, infoMsg: msg || null });
});

// POST /ticket/:code/cancel  — attendee self-cancel
router.post('/:code/cancel', (req, res) => {
  const { code } = req.params;
  const { email, identifier } = req.body;
  const idVal = (identifier || email || '').trim();

  if (!verifyTicketCode(code)) {
    return res.render('ticket_lookup.html', { error: 'Ticket not found.' });
  }

  const reg = db.prepare(`
    SELECT r.* FROM registrations r
    WHERE r.ticket_code = ? AND (LOWER(r.email) = LOWER(?) OR r.mobile = ?)
  `).get(code, idVal, idVal);

  if (!reg) return res.render('ticket_lookup.html', { error: 'Ticket not found.' });
  if (reg.status === 'CheckedIn') {
    return res.redirect(`/ticket/${code}?identifier=${encodeURIComponent(idVal)}&msg=Cannot+cancel+a+checked-in+registration.`);
  }
  if (reg.status === 'Cancelled') {
    return res.redirect(`/ticket/${code}?identifier=${encodeURIComponent(idVal)}&msg=Already+cancelled.`);
  }

  db.prepare(`UPDATE registrations SET status='Cancelled' WHERE ticket_code=?`).run(code);
  res.redirect(`/ticket/${code}?identifier=${encodeURIComponent(idVal)}&msg=Registration+cancelled.`);
});

module.exports = router;
