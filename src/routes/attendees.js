'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff, requireOrganizer } = require('../middleware/auth');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');
const { sendWaitlistPromotionEmail } = require('../utils/mailer');
const { getEventAvailability, getConfirmedCount } = require('../utils/availability');

router.use(requireStaff);

// GET attendee list for an event
router.get('/:event_id', async (req, res, next) => {
  try {
    const event = await getEventAvailability(req.params.event_id);
    if (!event) return res.status(404).render('404.html');

    const q = req.query.q ? `%${req.query.q}%` : null;
    const rows = q
      ? await db.prepare(`SELECT * FROM registrations WHERE event_id=? AND (full_name LIKE ? OR ticket_code LIKE ?) ORDER BY registered_at DESC`).all(event.id, q, q)
      : await db.prepare(`SELECT * FROM registrations WHERE event_id=? ORDER BY registered_at DESC`).all(event.id);

    const stats = {
      confirmed: event.confirmed_count,
      checked_in: event.checked_in_count,
      waitlisted: event.waitlisted_count,
      cancelled: event.cancelled_count
    };

    res.render('staff/attendees.html', { event, rows, stats, q: req.query.q || '', flash: req.query.msg || null });
  } catch (err) {
    next(err);
  }
});

// POST cancel a registration (staff)
router.post('/:event_id/cancel/:reg_id', requireOrganizer, async (req, res, next) => {
  try {
    const reg = await db.prepare('SELECT * FROM registrations WHERE id=? AND event_id=?').get(req.params.reg_id, req.params.event_id);
    if (!reg) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration not found.`);
    if (reg.status === 'CheckedIn') {
      return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Cannot cancel a checked-in registration.`);
    }

    await db.prepare(`UPDATE registrations SET status='Cancelled' WHERE id=?`).run(reg.id);
    audit.log(req.session.staff.id, 'cancel_registration', reg.id, `ticket:${reg.ticket_code}`);
    res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration cancelled.`);
  } catch (err) {
    next(err);
  }
});

// POST restore/uncancel a registration (staff)
router.post('/:event_id/uncancel/:reg_id', requireOrganizer, async (req, res, next) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
    const reg = await db.prepare(`SELECT * FROM registrations WHERE id=? AND event_id=? AND status='Cancelled'`).get(req.params.reg_id, req.params.event_id);
    if (!reg || !event) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration not found.`);

    const restore = db.transaction(async () => {
      const confirmed = await getConfirmedCount(event.id);
      if (confirmed >= event.capacity) return { error: 'Event is full — cannot restore as Confirmed.' };

      const dup = await db.prepare(`SELECT id FROM registrations WHERE event_id=? AND email=? AND status IN ('Confirmed','CheckedIn','Waitlisted')`).get(event.id, reg.email);
      if (dup) return { error: 'This attendee already has an active registration.' };

      await db.prepare(`UPDATE registrations SET status='Confirmed' WHERE id=?`).run(reg.id);
      return { success: true };
    });

    const result = await restore();
    if (result.error) {
      return res.redirect(`/staff/attendees/${req.params.event_id}?msg=${encodeURIComponent(result.error)}`);
    }

    audit.log(req.session.staff.id, 'uncancel_registration', reg.id, `ticket:${reg.ticket_code}`);
    res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration restored to Confirmed.`);
  } catch (err) {
    next(err);
  }
});

// POST permanently delete a cancelled registration (staff)
router.post('/:event_id/delete/:reg_id', requireOrganizer, async (req, res, next) => {
  try {
    const reg = await db.prepare('SELECT * FROM registrations WHERE id=? AND event_id=?').get(req.params.reg_id, req.params.event_id);
    if (!reg) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration not found.`);

    await db.prepare('DELETE FROM registrations WHERE id=?').run(reg.id);
    audit.log(req.session.staff.id, 'delete_registration', reg.id, `ticket:${reg.ticket_code} (deleted record)`);
    res.redirect(`/staff/attendees/${req.params.event_id}?msg=Attendee record permanently deleted.`);
  } catch (err) {
    next(err);
  }
});

// POST promote waitlisted person
router.post('/:event_id/promote/:reg_id', requireOrganizer, async (req, res, next) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
    const reg = await db.prepare(`SELECT * FROM registrations WHERE id=? AND event_id=? AND status='Waitlisted'`).get(req.params.reg_id, req.params.event_id);
    if (!reg || !event) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Not found.`);

    const promote = db.transaction(async () => {
      const confirmed = await getConfirmedCount(event.id);
      if (confirmed >= event.capacity) return false;
      await db.prepare(`UPDATE registrations SET status='Confirmed', waitlist_pos=NULL WHERE id=?`).run(reg.id);
      return true;
    });

    if (await promote()) {
      audit.log(req.session.staff.id, 'waitlist_promote', reg.id, `ticket:${reg.ticket_code}`);
      sendWaitlistPromotionEmail(reg, event).catch(console.error);
      res.redirect(`/staff/attendees/${req.params.event_id}?msg=Promoted from waitlist.`);
    } else {
      res.redirect(`/staff/attendees/${req.params.event_id}?msg=Event is still full — cannot promote.`);
    }
  } catch (err) {
    next(err);
  }
});

// GET CSV export (Organizer only)
router.get('/:event_id/export.csv', requireOrganizer, async (req, res, next) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
    if (!event) return res.status(404).send('Not found');
    const rows = await db.prepare('SELECT * FROM registrations WHERE event_id=? ORDER BY registered_at').all(event.id);

    const headers = ['full_name', 'email', 'mobile', 'ticket_code', 'status', 'registered_at', 'checked_in_at', 'waitlist_pos'];
    const csvLines = [
      headers.join(','),
      ...rows.map(r => headers.map(h => `"${(r[h] || '').toString().replace(/"/g, '""')}"`).join(','))
    ];

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendees-${event.id}.csv"`);
    res.send(csvLines.join('\r\n'));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
