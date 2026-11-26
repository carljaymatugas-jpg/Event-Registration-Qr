'use strict';
const router = require('express').Router();
const db = require('../db/db');
const QRCode = require('qrcode');
const { verifyTicketCode } = require('../utils/ticket');
const { nowCebu } = require('../utils/time');
const { normalizePHMobile } = require('../utils/phone');
const audit = require('../utils/audit');

const GENERIC_LOOKUP_ERROR = 'Ticket not found or contact information does not match.';

// GET /ticket/:code?email=... or ?identifier=...
router.get('/:code', async (req, res, next) => {
  try {
    const rawCode = (req.params.code || '').replace(/\s+/g, '').replace(/[\u2010-\u2015\u2212]/g, '-').toUpperCase();
    const { email, identifier, msg } = req.query;
    const rawId = (identifier || email || '').trim();

    if (!rawId) {
      return res.redirect('/lookup');
    }

    if (!verifyTicketCode(rawCode)) {
      return res.render('ticket_lookup.html', {
        error: GENERIC_LOOKUP_ERROR,
        values: { ticket_code: rawCode, identifier: rawId }
      });
    }

    const normPhone = normalizePHMobile(rawId);

    const reg = await db.prepare(`
      SELECT r.*, e.title as event_title, e.venue, e.starts_at, e.ends_at
      FROM registrations r
      JOIN events e ON e.id = r.event_id
      WHERE r.ticket_code = ? AND (
        LOWER(r.email) = LOWER(?)
        OR r.mobile = ?
        OR r.mobile = ?
      )
    `).get(rawCode, rawId, rawId, normPhone);

    if (!reg) {
      return res.render('ticket_lookup.html', {
        error: GENERIC_LOOKUP_ERROR,
        values: { ticket_code: rawCode, identifier: rawId }
      });
    }

    let qrDataUrl = null;
    if (reg.status !== 'Cancelled') {
      qrDataUrl = await QRCode.toDataURL(rawCode, { width: 300 });
    }

    res.render('ticket.html', { reg, qrDataUrl, identifier: rawId, infoMsg: msg || null });
  } catch (err) {
    next(err);
  }
});

// POST /ticket/:code/cancel — attendee self-cancel
router.post('/:code/cancel', async (req, res, next) => {
  try {
    const rawCode = (req.params.code || '').trim().toUpperCase();
    const { email, identifier } = req.body;
    const rawId = (identifier || email || '').trim();

    if (!verifyTicketCode(rawCode)) {
      return res.render('ticket_lookup.html', { error: GENERIC_LOOKUP_ERROR });
    }

    const normPhone = normalizePHMobile(rawId);

    const reg = await db.prepare(`
      SELECT r.* FROM registrations r
      WHERE r.ticket_code = ? AND (
        LOWER(r.email) = LOWER(?)
        OR r.mobile = ?
        OR r.mobile = ?
      )
    `).get(rawCode, rawId, rawId, normPhone);

    if (!reg) return res.render('ticket_lookup.html', { error: GENERIC_LOOKUP_ERROR });
    if (reg.status === 'CheckedIn') {
      return res.redirect(`/ticket/${rawCode}?identifier=${encodeURIComponent(rawId)}&msg=Cannot+cancel+a+checked-in+registration.`);
    }
    if (reg.status === 'Cancelled') {
      return res.redirect(`/ticket/${rawCode}?identifier=${encodeURIComponent(rawId)}&msg=Already+cancelled.`);
    }

    await db.prepare(`UPDATE registrations SET status='Cancelled' WHERE ticket_code=?`).run(rawCode);
    try { audit.log(0, 'attendee_cancel', reg.id, `ticket:${rawCode}`); } catch (_) {}
    res.redirect(`/ticket/${rawCode}?identifier=${encodeURIComponent(rawId)}&msg=Registration+cancelled.`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
