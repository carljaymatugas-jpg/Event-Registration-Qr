'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff } = require('../middleware/auth');
const { verifyTicketCode } = require('../utils/ticket');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');
const { getEventAvailability } = require('../utils/availability');

router.use(requireStaff);

// GET check-in screen
router.get('/', async (req, res, next) => {
  try {
    const events = await db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();
    const selectedId = req.query.event_id ? parseInt(req.query.event_id) : (events[0] ? events[0].id : null);
    const selectedEvent = selectedId ? await getEventAvailability(selectedId) : null;

    const checkedIn = selectedEvent ? selectedEvent.checked_in_count : 0;
    const confirmed = selectedEvent ? selectedEvent.confirmed_count : 0;

    res.render('staff/checkin.html', { events, selectedEvent, selectedId, checkedIn, confirmed, result: null });
  } catch (err) {
    next(err);
  }
});

// POST check-in (manual code entry)
router.post('/', async (req, res, next) => {
  try {
    const { ticket_code, event_id } = req.body;
    const events = await db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();
    const selectedId = parseInt(event_id);
    const selectedEvent = await getEventAvailability(selectedId);

    const confirmed = selectedEvent ? selectedEvent.confirmed_count : 0;

    const code = (ticket_code || '').trim().toUpperCase();
    let result;

    if (!verifyTicketCode(code)) {
      result = { type: 'invalid', msg: 'Invalid ticket — code not recognised.' };
    } else {
      const reg = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);

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
        const doCheckin = db.transaction(async () => {
          const fresh = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
          if (fresh.status === 'CheckedIn') return { race: true, checkin_time: fresh.checked_in_at };
          const now = nowCebu();
          await db.prepare(`UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE ticket_code=?`)
            .run(now, req.session.staff.id, code);
          return { race: false, now };
        });

        const r = await doCheckin();
        if (r.race) {
          result = { type: 'already', msg: 'Already checked in', name: reg.full_name, checkin_time: r.checkin_time };
        } else {
          audit.log(req.session.staff.id, 'checkin', reg.id, `ticket:${code}`);
          result = { type: 'success', msg: 'Checked in', name: reg.full_name };
        }
      }
    }

    const updatedAvail = await getEventAvailability(selectedId);
    const freshCheckedIn = updatedAvail ? updatedAvail.checked_in_count : 0;

    res.render('staff/checkin.html', { events, selectedEvent, selectedId, checkedIn: freshCheckedIn, confirmed, result });
  } catch (err) {
    next(err);
  }
});

// POST check-in via API (for camera scan — returns JSON)
router.post('/api', async (req, res, next) => {
  try {
    const { ticket_code, event_id } = req.body;
    const selectedId = parseInt(event_id);
    const code = (ticket_code || '').trim().toUpperCase();

    if (!verifyTicketCode(code)) {
      return res.json({ type: 'invalid', msg: 'Invalid ticket — code not recognised.' });
    }

    const reg = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
    if (!reg) return res.json({ type: 'invalid', msg: 'Invalid ticket — code not found.' });
    if (reg.event_id !== selectedId) return res.json({ type: 'invalid', msg: 'Invalid ticket — belongs to a different event.' });
    if (reg.status === 'CheckedIn') return res.json({ type: 'already', msg: 'Already checked in', name: reg.full_name, checkin_time: reg.checked_in_at });
    if (reg.status === 'Waitlisted') return res.json({ type: 'waitlisted', msg: 'On waitlist — not confirmed.', name: reg.full_name });
    if (reg.status === 'Cancelled') return res.json({ type: 'invalid', msg: 'Cancelled registration.', name: reg.full_name });

    const doCheckin = db.transaction(async () => {
      const fresh = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
      if (fresh.status === 'CheckedIn') return { race: true, checkin_time: fresh.checked_in_at };
      const now = nowCebu();
      await db.prepare(`UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE ticket_code=?`)
        .run(now, req.session.staff.id, code);
      return { race: false, now };
    });

    const r = await doCheckin();
    if (r.race) return res.json({ type: 'already', msg: 'Already checked in', name: reg.full_name, checkin_time: r.checkin_time });

    audit.log(req.session.staff.id, 'checkin', reg.id, `ticket:${code}`);
    return res.json({ type: 'success', msg: 'Checked in', name: reg.full_name });
  } catch (err) {
    next(err);
  }
});

// POST undo check-in
router.post('/undo', async (req, res, next) => {
  try {
    const { registration_id, event_id } = req.body;
    const reg = await db.prepare('SELECT * FROM registrations WHERE id = ?').get(registration_id);

    if (!reg || reg.status !== 'CheckedIn') {
      return res.redirect(`/staff/checkin?event_id=${event_id}&msg=Cannot undo — not checked in.`);
    }

    const doUndo = db.transaction(async () => {
      await db.prepare(`UPDATE registrations SET status='Confirmed', undo_at=?, undo_by=?, checked_in_at=NULL, checked_in_by=NULL WHERE id=?`)
        .run(nowCebu(), req.session.staff.id, reg.id);
    });
    await doUndo();

    audit.log(req.session.staff.id, 'undo_checkin', reg.id, `ticket:${reg.ticket_code}`);
    res.redirect(`/staff/attendees/${reg.event_id}?msg=Check-in undone.`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
