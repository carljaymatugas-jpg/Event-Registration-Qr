'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff, requireOrganizer } = require('../middleware/auth');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');

router.use(requireStaff);

// List all events
router.get('/', requireOrganizer, async (req, res, next) => {
  try {
    const events = await db.prepare('SELECT * FROM events ORDER BY starts_at DESC').all();
    res.render('staff/events.html', { events, flash: req.query.msg || null });
  } catch (err) {
    next(err);
  }
});

// New event form
router.get('/new', requireOrganizer, (req, res) => {
  res.render('staff/event_form.html', { event: null, errors: {} });
});

// Create event
router.post('/new', requireOrganizer, async (req, res, next) => {
  try {
    await validateAndSave(req, res, null);
  } catch (err) {
    next(err);
  }
});

// Edit event form
router.get('/:id/edit', requireOrganizer, async (req, res, next) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).render('404.html');
    res.render('staff/event_form.html', { event, errors: {} });
  } catch (err) {
    next(err);
  }
});

// Update event
router.post('/:id/edit', requireOrganizer, async (req, res, next) => {
  try {
    const event = await db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
    if (!event) return res.status(404).render('404.html');
    await validateAndSave(req, res, event);
  } catch (err) {
    next(err);
  }
});

// Close event
router.post('/:id/close', requireOrganizer, async (req, res, next) => {
  try {
    await db.prepare(`UPDATE events SET status='Closed' WHERE id=?`).run(req.params.id);
    audit.log(req.session.staff.id, 'event_close', req.params.id);
    res.redirect('/staff/events?msg=Event closed.');
  } catch (err) {
    next(err);
  }
});

async function validateAndSave(req, res, existingEvent) {
  const { title, description, venue, starts_at, ends_at, capacity, status } = req.body;
  const errors = {};

  if (!title || title.trim().length < 2) errors.title = 'Title is required.';
  if (!venue || venue.trim().length < 2) errors.venue = 'Venue is required.';
  if (!starts_at) errors.starts_at = 'Start time is required.';
  if (!ends_at) errors.ends_at = 'End time is required.';
  if (starts_at && ends_at && ends_at <= starts_at) errors.ends_at = 'End time must be after start time.';

  const cap = parseInt(capacity);
  if (!cap || cap < 1) errors.capacity = 'Capacity must be at least 1.';

  if (existingEvent && cap) {
    const confirmedRow = await db.prepare(`SELECT COUNT(*) AS c FROM registrations WHERE event_id=? AND status IN ('Confirmed','CheckedIn')`).get(existingEvent.id);
    const confirmed = (confirmedRow && confirmedRow.c) || 0;
    if (cap < confirmed) errors.capacity = `Cannot lower capacity below current confirmed registrations (${confirmed}).`;
  }

  const validStatus = ['Draft', 'Published', 'Closed'];
  if (!validStatus.includes(status)) errors.status = 'Invalid status.';

  if (Object.keys(errors).length) {
    return res.render('staff/event_form.html', { event: existingEvent, errors, values: req.body });
  }

  // Format datetimes as 'YYYY-MM-DD HH:MM:SS'
  const fmtDt = (s) => s.replace('T', ' ') + ':00';

  if (existingEvent) {
    await db.prepare(`UPDATE events SET title=?,description=?,venue=?,starts_at=?,ends_at=?,capacity=?,status=? WHERE id=?`)
      .run(title.trim(), (description || '').trim(), venue.trim(), fmtDt(starts_at), fmtDt(ends_at), cap, status, existingEvent.id);
    audit.log(req.session.staff.id, 'event_edit', existingEvent.id, title.trim());
    return res.redirect(`/staff/events?msg=Event updated.`);
  } else {
    const info = await db.prepare(`INSERT INTO events (title,description,venue,starts_at,ends_at,capacity,status) VALUES (?,?,?,?,?,?,?)`)
      .run(title.trim(), (description || '').trim(), venue.trim(), fmtDt(starts_at), fmtDt(ends_at), cap, status);
    audit.log(req.session.staff.id, 'event_create', info.lastInsertRowid, title.trim());
    return res.redirect(`/staff/events?msg=Event created.`);
  }
}

module.exports = router;
