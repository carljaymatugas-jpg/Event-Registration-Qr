'use strict';

/**
 * Normalizes Philippine mobile numbers to standard 11-digit format (09XXXXXXXXX)
 * Supports formats:
 *  - 09171234567
 *  - +639171234567
 *  - 639171234567
 *  - 0917-123-4567
 *  - +63 917 123 4567
 */
function normalizePHMobile(input) {
  if (!input) return '';
  let str = String(input).trim().replace(/[\s\-()]/g, '');
  if (str.startsWith('+63')) {
    str = '0' + str.slice(3);
  } else if (str.startsWith('63') && str.length === 12) {
    str = '0' + str.slice(2);
  }
  return str;
}

/**
 * Validates whether the input is a valid 11-digit Philippine mobile starting with 09
 */
function isValidPHMobile(input) {
  const normalized = normalizePHMobile(input);
  return /^09\d{9}$/.test(normalized);
}

module.exports = { normalizePHMobile, isValidPHMobile };
