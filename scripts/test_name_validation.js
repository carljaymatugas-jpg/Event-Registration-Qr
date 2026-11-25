'use strict';
// Test the full name validation regex used in attendee.js
const FULL_NAME_UNICODE_RE = /^[\p{L}]+(?: +[\p{L}]+)*$/u;

function validateFullName(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, msg: 'Full name is required.' };
  const trimmed = raw.trim();
  if (!trimmed) return { valid: false, msg: 'Full name cannot be empty or contain only spaces.' };
  if (trimmed.length < 2) return { valid: false, msg: 'Full name must be at least 2 characters.' };
  if (trimmed.length > 100) return { valid: false, msg: 'Full name cannot exceed 100 characters.' };
  if (/[\t\n\r\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, msg: 'Full name must contain letters and spaces only. Numbers, special characters, and emojis are not allowed.' };
  }
  if (!FULL_NAME_UNICODE_RE.test(trimmed)) {
    return { valid: false, msg: 'Full name must contain letters and spaces only. Numbers, special characters, and emojis are not allowed.' };
  }
  return { valid: true, value: trimmed };
}

const tests = [
  // [input, expectedValid, description]
  ['Carl Jay Matugas', true, 'Normal first+middle+last'],
  ['CARL JAY MATUGAS', true, 'All uppercase'],
  ['carl jay matugas', true, 'All lowercase'],
  ['Carl', true, 'Single name'],
  ['José Matugas', true, 'Name with accent é'],
  ['André Matugas', true, 'Name with accent é'],
  ['Ñora Matugas', true, 'Name with Ñ'],
  ['Ü müller', true, 'Name with Ü'],
  ['Carl123', false, 'Name with numbers'],
  ['Carl@Jay', false, 'Name with @'],
  ['Carl! Jay', false, 'Name with !'],
  ['Carl_ Jay', false, 'Name with _'],
  ['Carl 😊', false, 'Name with emoji'],
  ['123456', false, 'All numbers'],
  ['@#$%', false, 'All symbols'],
  ['   ', false, 'Whitespace only'],
  ['', false, 'Empty string'],
  ['A', false, 'Too short (1 char)'],
  ['  Carl Jay  ', true, 'Leading/trailing spaces (trimmed)'],
  ['<script>alert(1)</script>', false, 'XSS injection'],
  ['Carl\tJay', false, 'Tab character'],
];

let passed = 0;
let failed = 0;

tests.forEach(([input, expectedValid, desc]) => {
  const result = validateFullName(input);
  const ok = result.valid === expectedValid;
  if (ok) {
    passed++;
    console.log(`  ✓ PASS: ${desc} [input: ${JSON.stringify(input)}]`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${desc} [input: ${JSON.stringify(input)}] expected valid=${expectedValid}, got valid=${result.valid}, msg="${result.msg}"`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);

// Also verify capitalization preservation
const preservationTests = [
  ['carl jay matugas', 'carl jay matugas'],
  ['Carl Jay Matugas', 'Carl Jay Matugas'],
  ['CARL JAY MATUGAS', 'CARL JAY MATUGAS'],
  ['  José Matugas  ', 'José Matugas'],  // trimmed but capitalization preserved
];

console.log('\nCapitalization preservation tests:');
preservationTests.forEach(([input, expected]) => {
  const result = validateFullName(input);
  if (!result.valid) {
    console.error(`  ✗ FAIL: "${input}" - should be valid`);
    failed++;
  } else if (result.value !== expected) {
    console.error(`  ✗ FAIL: "${input}" → expected "${expected}", got "${result.value}"`);
    failed++;
  } else {
    console.log(`  ✓ PASS: "${input}" → "${result.value}"`);
    passed++;
  }
});

console.log(`\nTotal: ${passed + failed} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
