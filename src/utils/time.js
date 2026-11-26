'use strict';
// All times stored and displayed in Asia/Manila (UTC+8)

/**
 * Normalizes a Date or DB timestamp string into a canonical ISO string
 * interpreted in Asia/Manila (+08:00) if no offset is present.
 */
function toManilaIsoString(val) {
  if (!val) return '';
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return '';
    return val.toISOString();
  }
  const s = String(val).trim();
  if (!s) return '';
  // Already has timezone suffix (Z or +HH:MM / -HH:MM)
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    return s.replace(' ', 'T');
  }
  // Naive date/datetime stored as Asia/Manila wall time
  const normalized = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    return `${normalized}T00:00:00+08:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    return `${normalized}:00+08:00`;
  }
  return `${normalized}+08:00`;
}

/**
 * Parses a Cebu timestamp string or Date to epoch milliseconds.
 */
function parseCebuMs(val) {
  const iso = toManilaIsoString(val);
  if (!iso) return NaN;
  return Date.parse(iso);
}

/**
 * Formats a date in Asia/Manila (e.g. "December 15, 2026").
 */
function formatCebu(val) {
  const ms = parseCebuMs(val);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * Formats a time in 12-hour AM/PM Asia/Manila format (e.g. "02:00 PM").
 */
function formatCebu12(val) {
  const ms = parseCebuMs(val);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString('en-PH', {
    timeZone: 'Asia/Manila',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Formats full date + 12-hour AM/PM time in Asia/Manila (e.g. "Nov 26, 2026, 01:30 PM").
 */
function formatCebuDateTime12(val) {
  const ms = parseCebuMs(val);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Current Asia/Manila wall time formatted as 'YYYY-MM-DD HH:MM:SS'.
 */
function nowCebu(nowMs = Date.now()) {
  return new Date(nowMs).toLocaleString('sv-SE', { timeZone: 'Asia/Manila' }).replace('T', ' ');
}

/**
 * Returns 'YYYY-MM-DD' calendar date key in Asia/Manila timezone.
 * Safe regardless of server OS timezone (e.g. UTC on Vercel).
 */
function getManilaDateKey(val) {
  const ms = typeof val === 'number' ? val : parseCebuMs(val);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

function isSameDay(valA, valB) {
  const keyA = getManilaDateKey(valA);
  const keyB = getManilaDateKey(valB);
  return Boolean(keyA && keyB && keyA === keyB);
}

function isEventDay(startsAt, endsAt = null, nowMs = Date.now()) {
  const todayKey = getManilaDateKey(nowMs);
  const startKey = getManilaDateKey(startsAt);
  const endKey = endsAt ? getManilaDateKey(endsAt) : startKey;
  if (!todayKey || !startKey) return false;
  return todayKey >= startKey && todayKey <= (endKey || startKey);
}

module.exports = {
  parseCebuMs,
  formatCebu,
  formatCebu12,
  formatCebuDateTime12,
  nowCebu,
  getManilaDateKey,
  isSameDay,
  isEventDay,
};
