'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff } = require('../middleware/auth');
const { verifyTicketCode } = require('../utils/ticket');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');

router.use(requireStaff);

// GET check-in screen
router.get('/', (req, res) => {
  const events = db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();
  const selectedId = req.query.event_id ? parseInt(req.query.event_id) : (events[0] ? events[0].id : null);
  const selectedEvent = selectedId ? db.prepare('SELECT * FROM events WHERE id = ?').get(selectedId) : null;

  const checkedIn = selectedId
    ? db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status='CheckedIn'`).get(selectedId).c
    : 0;
  const confirmed = selectedId
    ? db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`).get(selectedId).c
    : 0;

  res.render('staff/checkin.html', { events, selectedEvent, selectedId, checkedIn, confirmed, result: null });
});

// POST check-in (manual code entry)
router.post('/', (req, res) => {
  const { ticket_code, event_id } = req.body;
  const events = db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();
  const selectedId = parseInt(event_id);
  const selectedEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(selectedId);

  const checkedIn = db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status='CheckedIn'`).get(selectedId).c;
  const confirmed = db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`).get(selectedId).c;

  const code = (ticket_code || '').trim().toUpperCase();
  let result;

  // 1. HMAC validity
  if (!verifyTicketCode(code)) {
    result = { type: 'invalid', msg: 'Invalid ticket — code not recognised.' };
  } else {
    // 2. Does code belong to ANY registration?
    const reg = db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);

    if (!reg) {
      result = { type: 'invalid', msg: 'Invalid ticket — code not found.' };
    } else if (reg.event_id !== selectedId) {
      result = { type: 'invalid', msg: 'Invalid ticket — belongs to a different event.' };
    } else if (reg.status === 'CheckedIn') {
      result = { type: 'already', msg: `Already checked in`, name: reg.full_name, checkin_time: reg.checked_in_at };
    } else if (reg.status === 'Waitlisted') {
      result = { type: 'waitlisted', msg: 'On waitlist — not confirmed.', name: reg.full_name };
    } else if (reg.status === 'Cancelled') {
      result = { type: 'invalid', msg: 'Cancelled — this registration was cancelled.', name: reg.full_name };
    } else if (reg.status === 'Confirmed') {
      // Atomic check-in with row locking via transaction
      const doCheckin = db.transaction(() => {
        // Re-read inside transaction to prevent race
        const fresh = db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
        if (fresh.status === 'CheckedIn') return { race: true, checkin_time: fresh.checked_in_at };
        const now = nowCebu();
        db.prepare(`UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE ticket_code=?`)
          .run(now, req.session.staff.id, code);
        return { race: false, now };
      });

      const r = doCheckin();
      if (r.race) {
        result = { type: 'already', msg: 'Already checked in', name: reg.full_name, checkin_time: r.checkin_time };
      } else {
        audit.log(req.session.staff.id, 'checkin', reg.id, `ticket:${code}`);
        result = { type: 'success', msg: 'Checked in', name: reg.full_name };
      }
    }
  }

  // Recalculate after potential update
  const freshCheckedIn = db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status='CheckedIn'`).get(selectedId).c;

  res.render('staff/checkin.html', { events, selectedEvent, selectedId, checkedIn: freshCheckedIn, confirmed, result });
});

// POST check-in via API (for camera scan — returns JSON)
router.post('/api', (req, res) => {
  const { ticket_code, event_id } = req.body;
  const selectedId = parseInt(event_id);
  const code = (ticket_code || '').trim().toUpperCase();

  if (!verifyTicketCode(code)) {
    return res.json({ type: 'invalid', msg: 'Invalid ticket — code not recognised.' });
  }

  const reg = db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
  if (!reg) return res.json({ type: 'invalid', msg: 'Invalid ticket — code not found.' });
  if (reg.event_id !== selectedId) return res.json({ type: 'invalid', msg: 'Invalid ticket — belongs to a different event.' });
  if (reg.status === 'CheckedIn') return res.json({ type: 'already', msg: 'Already checked in', name: reg.full_name, checkin_time: reg.checked_in_at });
  if (reg.status === 'Waitlisted') return res.json({ type: 'waitlisted', msg: 'On waitlist — not confirmed.', name: reg.full_name });
  if (reg.status === 'Cancelled') return res.json({ type: 'invalid', msg: 'Cancelled registration.', name: reg.full_name });

  const doCheckin = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
    if (fresh.status === 'CheckedIn') return { race: true, checkin_time: fresh.checked_in_at };
    const now = nowCebu();
    db.prepare(`UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE ticket_code=?`)
      .run(now, req.session.staff.id, code);
    return { race: false, now };
  });

  const r = doCheckin();
  if (r.race) return res.json({ type: 'already', msg: 'Already checked in', name: reg.full_name, checkin_time: r.checkin_time });

  audit.log(req.session.staff.id, 'checkin', reg.id, `ticket:${code}`);
  return res.json({ type: 'success', msg: 'Checked in', name: reg.full_name });
});

// POST undo check-in
router.post('/undo', (req, res) => {
  const { registration_id, event_id } = req.body;
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(registration_id);

  if (!reg || reg.status !== 'CheckedIn') {
    return res.redirect(`/staff/checkin?event_id=${event_id}&msg=Cannot undo — not checked in.`);
  }

  db.transaction(() => {
    db.prepare(`UPDATE registrations SET status='Confirmed', undo_at=?, undo_by=?, checked_in_at=NULL, checked_in_by=NULL WHERE id=?`)
      .run(nowCebu(), req.session.staff.id, reg.id);
  })();

  audit.log(req.session.staff.id, 'undo_checkin', reg.id, `ticket:${reg.ticket_code}`);
  res.redirect(`/staff/attendees/${reg.event_id}?msg=Check-in undone.`);
});

module.exports = router;
