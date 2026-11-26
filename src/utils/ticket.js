'use strict';
const crypto = require('crypto');
const { nanoid } = require('nanoid');

const PLACEHOLDER_SECRETS = new Set([
  'change-me',
  'change-me-in-production',
  'change_this_to_a_long_random_string',
  'change_this_to_another_long_random_string',
  'fallback_secret',
  'dev_hmac_secret',
  'dev',
  'secret',
  'your_secret_here',
]);

function isPlaceholderOrWeakSecret(val) {
  const s = (val || '').trim();
  return !s || PLACEHOLDER_SECRETS.has(s) || s.length < 16;
}

function getHmacSecret() {
  const val = (process.env.TICKET_HMAC_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production' && isPlaceholderOrWeakSecret(val)) {
    throw new Error('FATAL: TICKET_HMAC_SECRET is missing, weak, or set to a placeholder in production.');
  }
  return val || 'dev_hmac_secret';
}

function assertProductionSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  if (isPlaceholderOrWeakSecret(process.env.SESSION_SECRET)) {
    throw new Error('FATAL: SESSION_SECRET is missing, weak (<16 chars), or set to a placeholder in production.');
  }
  if (isPlaceholderOrWeakSecret(process.env.TICKET_HMAC_SECRET)) {
    throw new Error('FATAL: TICKET_HMAC_SECRET is missing, weak (<16 chars), or set to a placeholder in production.');
  }
}

/**
 * Generate a ticket code: PREFIX-RANDOM6-HMAC8
 * e.g. CDM-7K3P9Q-A3F21B9C
 * The 8-char uppercase hex HMAC-SHA256 suffix makes sequential guessing infeasible.
 */
function generateTicketCode(prefix = 'EVT') {
  const secret = getHmacSecret();
  const rand = nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
  const base = `${prefix}-${rand}`;
  const sig = crypto.createHmac('sha256', secret)
    .update(base).digest('hex').slice(0, 8).toUpperCase();
  return `${base}-${sig}`;
}

/**
 * Constant-time HMAC verification before any DB lookup.
 * Validates current 8-char HMAC codes (and legacy 4-char codes from pre-upgrade tickets).
 */
function verifyTicketCode(code) {
  if (!code || typeof code !== 'string') return false;
  const parts = code.trim().toUpperCase().split('-');
  if (parts.length !== 3) return false;
  const [prefix, rand, sig] = parts;
  if (!/^[A-Z0-9]{1,8}$/.test(prefix) || !/^[A-Z0-9]{6}$/.test(rand)) return false;
  if (!/^[A-F0-9]+$/.test(sig) || (sig.length !== 8 && sig.length !== 4)) return false;

  const base = `${prefix}-${rand}`;
  const full = crypto.createHmac('sha256', getHmacSecret())
    .update(base).digest('hex').toUpperCase();
  const expected = full.slice(0, sig.length);

  const bufSig = Buffer.from(sig, 'utf8');
  const bufExp = Buffer.from(expected, 'utf8');
  if (bufSig.length !== bufExp.length) return false;
  return crypto.timingSafeEqual(bufSig, bufExp);
}

module.exports = {
  PLACEHOLDER_SECRETS,
  isPlaceholderOrWeakSecret,
  assertProductionSecrets,
  generateTicketCode,
  verifyTicketCode,
};
