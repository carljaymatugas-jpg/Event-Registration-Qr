'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff } = require('../middleware/auth');
const { verifyTicketCode } = require('../utils/ticket');
const { nowCebu, formatCebuDateTime12, getCheckinWindowStatus } = require('../utils/time');
const audit = require('../utils/audit');
const { getEventAvailability } = require('../utils/availability');

router.use(requireStaff);

/**
 * Shared atomic check-in handler used by both manual form POST and camera API POST.
 * Enforces: HMAC verification, event match, ticket status, event-day window (Asia/Manila),
 * and atomic single-statement conditional update so concurrent scans cannot double check-in.
 */
async function performCheckin({ ticketCode, eventId, staffId }) {
  const selectedId = parseInt(eventId, 10);
  if (!selectedId || Number.isNaN(selectedId)) {
    return { result: { type: 'invalid', msg: 'Invalid event selected.' }, selectedEvent: null };
  }

  const selectedEvent = await getEventAvailability(selectedId);
  if (!selectedEvent) {
    return { result: { type: 'invalid', msg: 'Selected event not found.' }, selectedEvent: null };
  }

  const code = (ticketCode || '').trim().toUpperCase();
  if (!verifyTicketCode(code)) {
    return { result: { type: 'invalid', msg: 'Invalid ticket — code not recognised.' }, selectedEvent };
  }

  const reg = await db.prepare('SELECT * FROM registrations WHERE ticket_code = ?').get(code);
  if (!reg) {
    return { result: { type: 'invalid', msg: 'Invalid ticket — code not found.' }, selectedEvent };
  }
  if (Number(reg.event_id) !== selectedId) {
    return { result: { type: 'invalid', msg: 'Invalid ticket — belongs to a different event.' }, selectedEvent };
  }
  if (reg.status === 'Waitlisted') {
    return { result: { type: 'waitlisted', msg: 'On waitlist — not confirmed.', name: reg.full_name }, selectedEvent };
  }
  if (reg.status === 'Cancelled') {
    return { result: { type: 'invalid', msg: 'Cancelled — this registration was cancelled.', name: reg.full_name }, selectedEvent };
  }
  if (reg.status === 'CheckedIn') {
    return {
      result: {
        type: 'already',
        msg: 'Already checked in',
        name: reg.full_name,
        checkin_time: formatCebuDateTime12(reg.checked_in_at) || reg.checked_in_at
      },
      selectedEvent
    };
  }

  // Enforce event-day check-in window (Asia/Manila)
  const dayCheck = getCheckinWindowStatus(selectedEvent.starts_at, selectedEvent.ends_at);
  if (!dayCheck.allowed) {
    return {
      result: { type: 'invalid', msg: dayCheck.msg, name: reg.full_name },
      selectedEvent
    };
  }

  if (reg.status !== 'Confirmed') {
    return { result: { type: 'invalid', msg: `Invalid ticket status (${reg.status}).`, name: reg.full_name }, selectedEvent };
  }

  // Single atomic conditional UPDATE: prevents two simultaneous scans checking in twice.
  // Works atomically on both PostgreSQL (row lock + READ COMMITTED re-check) and SQLite.
  const now = nowCebu();
  const upd = await db.prepare(
    `UPDATE registrations SET status='CheckedIn', checked_in_at=?, checked_in_by=? WHERE id=? AND status='Confirmed'`
  ).run(now, staffId, reg.id);

  if (!upd || upd.changes === 0) {
    const fresh = await db.prepare('SELECT status, checked_in_at FROM registrations WHERE id = ?').get(reg.id);
    return {
      result: {
        type: 'already',
        msg: 'Already checked in',
        name: reg.full_name,
        checkin_time: formatCebuDateTime12(fresh && fresh.checked_in_at) || (fresh && fresh.checked_in_at) || ''
      },
      selectedEvent
    };
  }

  audit.log(staffId, 'checkin', reg.id, `ticket:${code}`);
  return {
    result: { type: 'success', msg: 'Checked in', name: reg.full_name },
    selectedEvent
  };
}

// GET check-in screen
router.get('/', async (req, res, next) => {
  try {
    const events = await db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();
    const selectedId = req.query.event_id ? parseInt(req.query.event_id, 10) : (events[0] ? events[0].id : null);
    const selectedEvent = selectedId ? await getEventAvailability(selectedId) : null;
    const dayStatus = selectedEvent ? getCheckinWindowStatus(selectedEvent.starts_at, selectedEvent.ends_at) : null;

    const checkedIn = selectedEvent ? selectedEvent.checked_in_count : 0;
    const confirmed = selectedEvent ? selectedEvent.confirmed_count : 0;

    let result = null;
    if (req.query.msg) {
      const allowedTypes = ['success', 'already', 'waitlisted', 'invalid'];
      const msgType = allowedTypes.includes(req.query.msg_type) ? req.query.msg_type : 'already';
      result = { type: msgType, msg: req.query.msg };
    }

    res.render('staff/checkin.html', { events, selectedEvent, selectedId, checkedIn, confirmed, dayStatus, result });
  } catch (err) {
    next(err);
  }
});

// POST check-in (manual code entry)
router.post('/', async (req, res, next) => {
  try {
    const { ticket_code, event_id } = req.body;
    const events = await db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();
    const selectedId = parseInt(event_id, 10);

    const { result } = await performCheckin({
      ticketCode: ticket_code,
      eventId: selectedId,
      staffId: req.session.staff.id
    });

    const updatedAvail = selectedId ? await getEventAvailability(selectedId) : null;
    const dayStatus = updatedAvail ? getCheckinWindowStatus(updatedAvail.starts_at, updatedAvail.ends_at) : null;
    const freshCheckedIn = updatedAvail ? updatedAvail.checked_in_count : 0;
    const confirmed = updatedAvail ? updatedAvail.confirmed_count : 0;

    res.render('staff/checkin.html', {
      events,
      selectedEvent: updatedAvail,
      selectedId,
      checkedIn: freshCheckedIn,
      confirmed,
      dayStatus,
      result
    });
  } catch (err) {
    next(err);
  }
});

// POST check-in via API (for camera scan — returns JSON with fresh counters)
router.post('/api', async (req, res, next) => {
  try {
    const { ticket_code, event_id } = req.body;
    const selectedId = parseInt(event_id, 10);

    const { result } = await performCheckin({
      ticketCode: ticket_code,
      eventId: selectedId,
      staffId: req.session.staff.id
    });

    const updatedAvail = selectedId ? await getEventAvailability(selectedId) : null;
    return res.json({
      ...result,
      checkedIn: updatedAvail ? updatedAvail.checked_in_count : 0,
      confirmed: updatedAvail ? updatedAvail.confirmed_count : 0
    });
  } catch (err) {
    next(err);
  }
});

// POST undo check-in (supports ticket_code from Door Scanner AND numeric registration_id from Attendee List)
router.post('/undo', async (req, res, next) => {
  try {
    const { ticket_code, registration_id, event_id, return_to } = req.body;
    const rawCodeInput = (ticket_code || (registration_id && !/^\d+$/.test(String(registration_id).trim()) ? registration_id : '') || '')
      .replace(/\s+/g, '')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .toUpperCase();
    const numericId = !rawCodeInput && /^\d+$/.test(String(registration_id || '').trim())
      ? parseInt(String(registration_id).trim(), 10)
      : null;

    let reg = null;
    if (rawCodeInput) {
      reg = await db.prepare('SELECT * FROM registrations WHERE UPPER(ticket_code) = ?').get(rawCodeInput);
    } else if (numericId !== null && !Number.isNaN(numericId)) {
      reg = await db.prepare('SELECT * FROM registrations WHERE id = ?').get(numericId);
    }

    const fallbackEventId = encodeURIComponent(event_id || (reg && reg.event_id) || '');

    if (!reg) {
      return res.redirect(`/staff/checkin?event_id=${fallbackEventId}&msg=${encodeURIComponent('Cannot undo — ticket code not found.')}&msg_type=invalid`);
    }

    if (reg.status !== 'CheckedIn') {
      return res.redirect(`/staff/checkin?event_id=${fallbackEventId}&msg=${encodeURIComponent(`Cannot undo — ${reg.full_name} is not checked in (status: ${reg.status}).`)}&msg_type=already`);
    }

    const upd = await db.prepare(
      `UPDATE registrations SET status='Confirmed', undo_at=?, undo_by=?, checked_in_at=NULL, checked_in_by=NULL WHERE id=? AND status='CheckedIn'`
    ).run(nowCebu(), req.session.staff.id, reg.id);

    if (upd && upd.changes > 0) {
      audit.log(req.session.staff.id, 'undo_checkin', reg.id, `ticket:${reg.ticket_code}`);
    }

    if (return_to === 'checkin' || rawCodeInput) {
      return res.redirect(
        `/staff/checkin?event_id=${encodeURIComponent(event_id || reg.event_id)}&msg=${encodeURIComponent(`Check-in undone for ${reg.full_name} (${reg.ticket_code}).`)}&msg_type=success`
      );
    }
    res.redirect(`/staff/attendees/${reg.event_id}?msg=Check-in+undone.`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
