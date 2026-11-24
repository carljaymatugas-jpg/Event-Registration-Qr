'use strict';
const router = require('express').Router();
const db = require('../db/db');
const { requireStaff } = require('../middleware/auth');
const { nowCebu } = require('../utils/time');
const audit = require('../utils/audit');

router.use(requireStaff);

async function getDashboardAnalytics(eventId = 'all', range = 'all') {
  let where = [];
  let params = [];

  if (eventId && eventId !== 'all') {
    where.push('event_id = ?');
    params.push(Number(eventId));
  }

  if (db.isPostgres) {
    if (range === 'today') {
      where.push("registered_at::date = (CURRENT_TIMESTAMP + INTERVAL '8 hours')::date");
    } else if (range === '7d') {
      where.push("registered_at >= (CURRENT_TIMESTAMP + INTERVAL '8 hours' - INTERVAL '7 days')");
    }
  } else {
    if (range === 'today') {
      where.push("date(registered_at) = date('now', '+8 hours')");
    } else if (range === '7d') {
      where.push("registered_at >= datetime('now', '+8 hours', '-7 days')");
    }
  }

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // Summary counts
  const summary = (await db.prepare(`
    SELECT
      COUNT(*) AS total_registered,
      SUM(CASE WHEN status = 'Confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status = 'CheckedIn' THEN 1 ELSE 0 END) AS checked_in,
      SUM(CASE WHEN status = 'Waitlisted' THEN 1 ELSE 0 END) AS waitlisted,
      SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM registrations
    ${whereClause}
  `).get(...params)) || {};

  // Capacity calculation
  let capQuery = "SELECT SUM(capacity) as total_capacity FROM events WHERE status IN ('Published', 'Closed')";
  let capParams = [];
  if (eventId && eventId !== 'all') {
    capQuery = 'SELECT capacity as total_capacity FROM events WHERE id = ?';
    capParams = [Number(eventId)];
  }
  const capRow = await db.prepare(capQuery).get(...capParams);
  const totalCapacity = (capRow && capRow.total_capacity) || 0;

  const confirmed = summary.confirmed || 0;
  const checkedIn = summary.checked_in || 0;
  const waitlisted = summary.waitlisted || 0;
  const cancelled = summary.cancelled || 0;
  const totalRegistered = summary.total_registered || 0;
  const activeConfirmed = confirmed + checkedIn;

  const checkinRate = activeConfirmed > 0 ? Math.round((checkedIn / activeConfirmed) * 100) : 0;
  const capacityRate = totalCapacity > 0 ? Math.min(100, Math.round((activeConfirmed / totalCapacity) * 100)) : 0;

  // Timeline points
  const regList = await db.prepare(`
    SELECT registered_at
    FROM registrations
    ${whereClause}
    ORDER BY registered_at ASC
  `).all(...params);

  let checkinWhere = ['checked_in_at IS NOT NULL'];
  let checkinParams = [];
  if (eventId && eventId !== 'all') {
    checkinWhere.push('event_id = ?');
    checkinParams.push(Number(eventId));
  }
  if (db.isPostgres) {
    if (range === 'today') {
      checkinWhere.push("checked_in_at::date = (CURRENT_TIMESTAMP + INTERVAL '8 hours')::date");
    } else if (range === '7d') {
      checkinWhere.push("checked_in_at >= (CURRENT_TIMESTAMP + INTERVAL '8 hours' - INTERVAL '7 days')");
    }
  } else {
    if (range === 'today') {
      checkinWhere.push("date(checked_in_at) = date('now', '+8 hours')");
    } else if (range === '7d') {
      checkinWhere.push("checked_in_at >= datetime('now', '+8 hours', '-7 days')");
    }
  }

  const checkinList = await db.prepare(`
    SELECT checked_in_at
    FROM registrations
    WHERE ${checkinWhere.join(' AND ')}
    ORDER BY checked_in_at ASC
  `).all(...checkinParams);

  // Map into time buckets
  const bucketMap = new Map();

  function formatBucketLabel(dtVal) {
    if (!dtVal) return 'Other';
    const dtStr = dtVal instanceof Date ? dtVal.toISOString().replace('T', ' ') : String(dtVal);
    return dtStr.substring(5, 13) + ':00';
  }

  regList.forEach(r => {
    const key = formatBucketLabel(r.registered_at);
    if (!bucketMap.has(key)) bucketMap.set(key, { label: key, regCount: 0, checkinCount: 0 });
    bucketMap.get(key).regCount++;
  });

  checkinList.forEach(c => {
    const key = formatBucketLabel(c.checked_in_at);
    if (!bucketMap.has(key)) bucketMap.set(key, { label: key, regCount: 0, checkinCount: 0 });
    bucketMap.get(key).checkinCount++;
  });

  const sortedKeys = Array.from(bucketMap.keys()).sort();
  let cumReg = 0;
  let cumCheckin = 0;
  const timeline = sortedKeys.map(k => {
    const b = bucketMap.get(k);
    cumReg += b.regCount;
    cumCheckin += b.checkinCount;
    return {
      label: b.label,
      regCount: b.regCount,
      checkinCount: b.checkinCount,
      cumulativeReg: cumReg,
      cumulativeCheckin: cumCheckin
    };
  });

  // Events list for comparison and filter dropdown
  const events = await db.prepare(`
    SELECT e.id, e.title, e.capacity, e.status, e.starts_at, e.venue,
      SUM(CASE WHEN r.status IN ('Confirmed', 'CheckedIn') THEN 1 ELSE 0 END) AS active_confirmed,
      SUM(CASE WHEN r.status = 'CheckedIn' THEN 1 ELSE 0 END) AS checked_in,
      SUM(CASE WHEN r.status = 'Waitlisted' THEN 1 ELSE 0 END) AS waitlisted,
      SUM(CASE WHEN r.status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM events e
    LEFT JOIN registrations r ON r.event_id = e.id
    WHERE e.status IN ('Published', 'Closed')
    GROUP BY e.id, e.title, e.capacity, e.status, e.starts_at, e.venue
    ORDER BY e.starts_at ASC
  `).all();

  return {
    summary: {
      total_registered: totalRegistered,
      confirmed,
      checked_in: checkedIn,
      active_confirmed: activeConfirmed,
      waitlisted,
      cancelled,
      capacity: totalCapacity,
      checkin_rate: checkinRate,
      capacity_rate: capacityRate
    },
    timeline,
    events
  };
}

router.get('/api/stats', async (req, res, next) => {
  try {
    const eventId = req.query.event_id || 'all';
    const range = req.query.range || 'all';
    const analytics = await getDashboardAnalytics(eventId, range);
    res.json({
      success: true,
      serverTime: nowCebu(),
      ...analytics
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const now = nowCebu();
    const events = await db.prepare(`SELECT * FROM events WHERE status IN ('Published','Closed') ORDER BY starts_at DESC`).all();

    const stats = await Promise.all(events.map(async ev => {
      const s = await db.prepare(`
        SELECT
          SUM(CASE WHEN status IN ('Confirmed','CheckedIn') THEN 1 ELSE 0 END) AS confirmed,
          SUM(CASE WHEN status = 'CheckedIn' THEN 1 ELSE 0 END) AS checked_in,
          SUM(CASE WHEN status = 'Waitlisted' THEN 1 ELSE 0 END) AS waitlisted,
          SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM registrations WHERE event_id = ?
      `).get(ev.id);

      const hasStarted = now >= ev.starts_at;
      const confirmedCount = (s && s.confirmed) || 0;
      const checkedInCount = (s && s.checked_in) || 0;
      const noShows = hasStarted ? Math.max(0, confirmedCount - checkedInCount) : '—';

      return {
        ...ev,
        confirmed: confirmedCount,
        checked_in: checkedInCount,
        waitlisted: (s && s.waitlisted) || 0,
        cancelled: (s && s.cancelled) || 0,
        no_shows: noShows
      };
    }));

    // Audit log (last 50 entries)
    const logs = await db.prepare(`
      SELECT a.*, s.name as staff_name, s.username FROM audit_logs a
      LEFT JOIN staff_users s ON s.id = a.staff_user_id
      ORDER BY a.created_at DESC LIMIT 50
    `).all();

    const analytics = await getDashboardAnalytics('all', 'all');

    res.render('staff/dashboard.html', { stats, logs, analytics });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
