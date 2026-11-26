'use strict';

// Allows Unicode letters, spaces, periods, straight/curly apostrophes, and hyphens.
// Must start with a Unicode letter (\p{L}). Rejects digits, emojis, control chars, and HTML tags.
const FULL_NAME_UNICODE_RE = /^[\p{L}][\p{L} .'\u2018\u2019-]*$/u;

// Strict email local & domain patterns:
// Local: alphanumeric segments separated by single '.', '_', or '-' (no special chars like #, $, %, +, !, etc.)
// Domain: alphanumeric/hyphen labels separated by '.', ending in >=2 letter TLD (no special chars)
const EMAIL_LOCAL_RE = /^[a-zA-Z0-9]+([._-][a-zA-Z0-9]+)*$/;
const EMAIL_DOMAIN_RE = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*(\.[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*)*\.[a-zA-Z]{2,}$/;

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

/**
 * Validates an attendee email address.
 * Allows: ASCII letters, digits, and standard separators (., _, -) in local part;
 *         ASCII letters, digits, hyphens, and dots in domain; >=2-letter TLD.
 * Rejects: special characters (#, $, %, !, +, &, *, etc.), spaces, HTML tags, emojis.
 */
function validateEmail(raw) {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, msg: 'A valid email address is required (e.g. name@example.com).' };
  }

  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return { valid: false, msg: 'A valid email address is required (e.g. name@example.com).' };
  }
  if (trimmed.length > 150) {
    return { valid: false, msg: 'Email address cannot exceed 150 characters.' };
  }
  if (/[\s\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, msg: 'A valid email address cannot contain spaces or control characters.' };
  }

  const parts = trimmed.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, msg: 'A valid email address is required (e.g. name@example.com).' };
  }

  const [local, domain] = parts;
  if (local.length > 64) {
    return { valid: false, msg: 'Email username before @ cannot exceed 64 characters.' };
  }

  if (/[^a-z0-9._@-]/.test(trimmed)) {
    return {
      valid: false,
      msg: 'A valid email address must only use letters, numbers, dots (.), underscores (_), or hyphens (-) — no special characters.'
    };
  }

  if (!EMAIL_LOCAL_RE.test(local) || !EMAIL_DOMAIN_RE.test(domain)) {
    return {
      valid: false,
      msg: 'A valid email address is required (letters, numbers, dots, underscores, or hyphens only — no special characters, e.g. name@example.com).'
    };
  }

  return { valid: true, value: trimmed };
}

module.exports = {
  FULL_NAME_UNICODE_RE,
  EMAIL_LOCAL_RE,
  EMAIL_DOMAIN_RE,
  sanitizeInput,
  validateFullName,
  validateEmail,
};
