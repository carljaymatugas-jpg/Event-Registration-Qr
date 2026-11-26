'use strict';

// Allows Unicode letters, spaces, periods, straight/curly apostrophes, and hyphens.
// Must start with a Unicode letter (\p{L}). Rejects digits, emojis, control chars, and HTML tags.
const FULL_NAME_UNICODE_RE = /^[\p{L}][\p{L} .'\u2018\u2019-]*$/u;

function sanitizeInput(str) {
  if (!str) return '';
  return String(str)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * Validates an attendee full name.
 * Allows: Unicode letters (\p{L}), spaces, periods (.), apostrophes (', \u2018, \u2019), hyphens (-).
 * Requires: 2-100 characters, starting with a letter.
 * Rejects: digits, symbols, emoji, control characters, HTML/script tags, whitespace-only input.
 * Preserves original capitalization.
 */
function validateFullName(raw) {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, msg: 'Full name is required.' };
  }

  // Reject control characters / tabs / newlines before trimming interior spaces
  if (/[\t\n\r\x00-\x1F\x7F]/.test(raw.trim())) {
    return { valid: false, msg: 'Full name contains invalid control characters.' };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, msg: 'Full name cannot be empty or contain only spaces.' };
  }
  if (trimmed.length < 2) {
    return { valid: false, msg: 'Full name must be at least 2 characters.' };
  }
  if (trimmed.length > 100) {
    return { valid: false, msg: 'Full name cannot exceed 100 characters.' };
  }
  if (/[<>]/.test(trimmed)) {
    return { valid: false, msg: 'Full name cannot contain HTML or script tags.' };
  }
  if (!FULL_NAME_UNICODE_RE.test(trimmed)) {
    return {
      valid: false,
      msg: "Full name must start with a letter and may only contain letters, spaces, periods, apostrophes, and hyphens."
    };
  }

  return { valid: true, value: trimmed };
}

module.exports = {
  FULL_NAME_UNICODE_RE,
  sanitizeInput,
  validateFullName,
};
