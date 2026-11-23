'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff } = require('../middleware/auth');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');

router.use(requireStaff);

router.get('/', (req, res) => {
  const now = nowCebu();
  const events = db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();

  const stats = events.map(ev => {
    const s = db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('Confirmed','CheckedIn') THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN status = 'CheckedIn' THEN 1 ELSE 0 END) AS checked_in,
        SUM(CASE WHEN status = 'Waitlisted' THEN 1 ELSE 0 END) AS waitlisted,
        SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status = 'Confirmed' AND ? > ends_at THEN 1 ELSE 0 END) AS no_shows
      FROM registrations WHERE event_id=?
    `).get(now, ev.id);
    return { ...ev, ...s };
  });

  // Audit log (last 50 entries)
  const logs = db.prepare(`
    SELECT a.*, s.name as staff_name, s.username FROM audit_logs a
    LEFT JOIN staff_users s ON s.id = a.staff_user_id
    ORDER BY a.created_at DESC LIMIT 50
  `).all();

  res.render('staff/dashboard.html', { stats, logs });
});

module.exports = router;
