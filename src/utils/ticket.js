'use strict';
const crypto = require('crypto');
const { nanoid } = require('nanoid');

const HMAC_SECRET = process.env.TICKET_HMAC_SECRET || 'dev_hmac_secret';

/**
 * Generate a ticket code: PREFIX-RANDOM-HMAC4
 * e.g. CDM-7K3P9Q-A3F2
 * The 4-char HMAC suffix makes sequential guessing infeasible.
 */
function generateTicketCode(prefix = 'EVT') {
  // 6 uppercase alphanumeric chars
  const rand = nanoid(10).toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
  const base = `${prefix}-${rand}`;
  const sig = crypto.createHmac('sha256', HMAC_SECRET)
    .update(base).digest('hex').slice(0, 4).toUpperCase();
  return `${base}-${sig}`;
}

/**
 * Verify a ticket code has a valid signature.
 * Returns true only if the last 4 chars match the HMAC of the prefix.
 */
function verifyTicketCode(code) {
  if (!code || typeof code !== 'string') return false;
  const parts = code.split('-');
  if (parts.length !== 3) return false;
  const sig = parts[2];
  const base = `${parts[0]}-${parts[1]}`;
  const expected = crypto.createHmac('sha256', HMAC_SECRET)
    .update(base).digest('hex').slice(0, 4).toUpperCase();
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { generateTicketCode, verifyTicketCode };
