'use strict';
const db = require('../db/db');
const { nowCebu, parseCebuMs } = require('./time');
const { getEventCategory } = require('./category');

const ACTIVE_CAPACITY_STATUSES = ['Confirmed', 'CheckedIn'];

/**
 * Decorates a raw event row (with counts) with derived capacity and state fields.
 * Counts only 'Confirmed' and 'CheckedIn' registrations toward capacity.
 * 'Waitlisted' and 'Cancelled' never reduce remaining spots.
 */
function decorateEventAvailability(ev, nowMs = Date.now()) {
  if (!ev) return null;
  const capacity = Number(ev.capacity || 0);
  const confirmed = Number(ev.confirmed_count || 0);
  const checkedIn = Number(ev.checked_in_count || 0);
  const waitlisted = Number(ev.waitlisted_count || 0);
  const cancelled = Number(ev.cancelled_count || 0);

  const startsMs = parseCebuMs(ev.starts_at);
  const endsMs = parseCebuMs(ev.ends_at);

  ev.capacity = capacity;
  ev.confirmed_count = confirmed;
  ev.checked_in_count = checkedIn;
  ev.waitlisted_count = waitlisted;
  ev.cancelled_count = cancelled;
  ev.spots_left = Math.max(0, capacity - confirmed);
  ev.is_full = ev.spots_left <= 0;

  ev.has_started = !Number.isNaN(startsMs) && startsMs <= nowMs;
  ev.has_ended = !Number.isNaN(endsMs) && endsMs <= nowMs;
  ev.is_past = ev.has_ended;
  ev.is_closed = ev.has_started || ev.has_ended || ev.status !== 'Published';
  ev.event_state = ev.status === 'Draft'
    ? 'Draft'
    : ev.status === 'Closed'
      ? 'Closed'
      : ev.has_ended
        ? 'Ended'
        : ev.has_started
          ? 'In Progress'
          : 'Upcoming';
  ev.category = getEventCategory(ev.title, ev.description);
  ev.is_free = true;
  return ev;
}

/**
 * Shared single source of truth for an event's capacity & registration availability.
 * Used by event list, details, register GET/POST, dashboard, and check-in counters.
 */
async function getEventAvailability(eventId) {
  const ev = await db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'CheckedIn') AS checked_in_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'Waitlisted') AS waitlisted_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'Cancelled') AS cancelled_count
    FROM events e
    WHERE e.id = ?
  `).get(eventId);
  return decorateEventAvailability(ev);
}

/**
 * Shared confirmed seat counter for use inside DB transactions.
 * Counts ONLY 'Confirmed' and 'CheckedIn'.
 */
async function getConfirmedCount(eventId) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS c FROM registrations WHERE event_id = ? AND status IN ('Confirmed','CheckedIn')
  `).get(eventId);
  return Number((row && row.c) || 0);
}

/**
 * Fetch multiple events with consistent availability metrics.
 */
async function getEventsWithAvailability({ statuses = ['Published'], order = 'ASC' } = {}) {
  const safeOrder = order === 'DESC' ? 'DESC' : 'ASC';
  const placeholders = statuses.map(() => '?').join(',');
  const nowMs = Date.now();
  const events = await db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status IN ('Confirmed','CheckedIn')) AS confirmed_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'CheckedIn') AS checked_in_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'Waitlisted') AS waitlisted_count,
      (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'Cancelled') AS cancelled_count
    FROM events e
    WHERE e.status IN (${placeholders})
    ORDER BY e.starts_at ${safeOrder}
  `).all(...statuses);

  return events.map(ev => decorateEventAvailability(ev, nowMs));
}

module.exports = {
  ACTIVE_CAPACITY_STATUSES,
  decorateEventAvailability,
  getEventAvailability,
  getConfirmedCount,
  getEventsWithAvailability,
};
