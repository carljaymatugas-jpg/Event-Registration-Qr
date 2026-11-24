'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff, requireOrganizer } = require('../middleware/auth');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');
const { sendWaitlistPromotionEmail } = require('../utils/mailer');

router.use(requireStaff);

// GET attendee list for an event
router.get('/:event_id', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
  if (!event) return res.status(404).render('404.html');

  const q = req.query.q ? `%${req.query.q}%` : null;
  const rows = q
    ? db.prepare(`SELECT * FROM registrations WHERE event_id=? AND (full_name LIKE ? OR ticket_code LIKE ?) ORDER BY registered_at DESC`).all(event.id, q, q)
    : db.prepare(`SELECT * FROM registrations WHERE event_id=? ORDER BY registered_at DESC`).all(event.id);

  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('Confirmed','CheckedIn') THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status = 'CheckedIn' THEN 1 ELSE 0 END) AS checked_in,
      SUM(CASE WHEN status = 'Waitlisted' THEN 1 ELSE 0 END) AS waitlisted,
      SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM registrations WHERE event_id=?
  `).get(event.id);

  res.render('staff/attendees.html', { event, rows, stats, q: req.query.q || '', flash: req.query.msg || null });
});

// POST cancel a registration (staff)
router.post('/:event_id/cancel/:reg_id', requireOrganizer, (req, res) => {
  const reg = db.prepare('SELECT * FROM registrations WHERE id=? AND event_id=?').get(req.params.reg_id, req.params.event_id);
  if (!reg) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration not found.`);
  if (reg.status === 'CheckedIn') {
    return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Cannot cancel a checked-in registration.`);
  }

  db.prepare(`UPDATE registrations SET status='Cancelled' WHERE id=?`).run(reg.id);
  audit.log(req.session.staff.id, 'cancel_registration', reg.id, `ticket:${reg.ticket_code}`);
  res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration cancelled.`);
});

// POST restore/uncancel a registration (staff)
router.post('/:event_id/uncancel/:reg_id', requireOrganizer, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
  const reg = db.prepare(`SELECT * FROM registrations WHERE id=? AND event_id=? AND status='Cancelled'`).get(req.params.reg_id, req.params.event_id);
  if (!reg || !event) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration not found.`);

  const restore = db.transaction(() => {
    const confirmed = db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`).get(event.id).c;
    if (confirmed >= event.capacity) return { error: 'Event is full — cannot restore as Confirmed.' };

    const dup = db.prepare(`SELECT id FROM registrations WHERE event_id=? AND email=? AND status IN ('Confirmed','CheckedIn','Waitlisted')`).get(event.id, reg.email);
    if (dup) return { error: 'This attendee already has an active registration.' };

    db.prepare(`UPDATE registrations SET status='Confirmed' WHERE id=?`).run(reg.id);
    return { success: true };
  });

  const result = restore();
  if (result.error) {
    return res.redirect(`/staff/attendees/${req.params.event_id}?msg=${encodeURIComponent(result.error)}`);
  }

  audit.log(req.session.staff.id, 'uncancel_registration', reg.id, `ticket:${reg.ticket_code}`);
  res.redirect(`/staff/attendees/${req.params.event_id}?msg=Registration restored to Confirmed.`);
});

// POST promote waitlisted person
router.post('/:event_id/promote/:reg_id', requireOrganizer, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
  const reg = db.prepare(`SELECT * FROM registrations WHERE id=? AND event_id=? AND status='Waitlisted'`).get(req.params.reg_id, req.params.event_id);
  if (!reg || !event) return res.redirect(`/staff/attendees/${req.params.event_id}?msg=Not found.`);

  const promote = db.transaction(() => {
    const confirmed = db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`).get(event.id).c;
    if (confirmed >= event.capacity) return false;
    db.prepare(`UPDATE registrations SET status='Confirmed', waitlist_pos=NULL WHERE id=?`).run(reg.id);
    return true;
  });

  if (promote()) {
    audit.log(req.session.staff.id, 'waitlist_promote', reg.id, `ticket:${reg.ticket_code}`);
    sendWaitlistPromotionEmail(reg, event).catch(console.error);
    res.redirect(`/staff/attendees/${req.params.event_id}?msg=Promoted from waitlist.`);
  } else {
    res.redirect(`/staff/attendees/${req.params.event_id}?msg=Event is still full — cannot promote.`);
  }
});

// GET CSV export
router.get('/:event_id/export.csv', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.event_id);
  if (!event) return res.status(404).send('Not found');
  const rows = db.prepare('SELECT * FROM registrations WHERE event_id=? ORDER BY registered_at').all(event.id);

  const headers = ['full_name', 'email', 'mobile', 'ticket_code', 'status', 'registered_at', 'checked_in_at', 'waitlist_pos'];
  const csvLines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => `"${(r[h] || '').toString().replace(/"/g, '""')}"`).join(','))
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="attendees-${event.id}.csv"`);
  res.send(csvLines.join('\r\n'));
});

module.exports = router;
