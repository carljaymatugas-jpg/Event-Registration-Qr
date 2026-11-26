'use strict';
// Tests the production validateFullName() implementation in src/utils/validation.js
const { validateFullName } = require('../src/utils/validation');

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
  // T5: Filipino & international names with period, apostrophe, hyphen
  ['Ma. Cristina', true, 'Filipino name with period (Ma. Cristina)'],
  ['Ma. Cristina Santos', true, 'Filipino full name with period'],
  ['Juan Dela Cruz Jr.', true, 'Name with suffix period (Jr.)'],
  ["O'Brien", true, "Straight apostrophe (O'Brien)"],
  ['O\u2019Brien', true, 'Curly right apostrophe (O’Brien)'],
  ['Mary-Ann', true, 'Hyphenated name (Mary-Ann)'],
  ["Mary-Ann O'Brien", true, "Hyphenated + apostrophe (Mary-Ann O'Brien)"],
  ['Jean-François', true, 'Accented hyphenated name'],
  // Invalid cases
  ['John123', false, 'Name with numbers (John123)'],
  ['Carl@Jay', false, 'Name with @'],
  ['Carl! Jay', false, 'Name with !'],
  ['Carl_ Jay', false, 'Name with _'],
  ['😀', false, 'Emoji only'],
  ['Carl 😊', false, 'Name with emoji'],
  ['123456', false, 'All numbers'],
  ['@#$%', false, 'All symbols'],
  ['   ', false, 'Whitespace only'],
  ['', false, 'Empty string'],
  ['A', false, 'Too short (1 char)'],
  ['.Cristina', false, 'Starts with period (must start with letter)'],
  ['-Cristina', false, 'Starts with hyphen'],
  ["'Brien", false, 'Starts with apostrophe'],
  ['  Carl Jay  ', true, 'Leading/trailing spaces (trimmed)'],
  ['<script>', false, 'Script tag only'],
  ['<script>alert(1)</script>', false, 'XSS script tag'],
  ['<script>alert(1)</script>John', false, 'HTML tag prefixed to valid name'],
  ['Carl\tJay', false, 'Tab character'],
  ['Carl\nJay', false, 'Newline character'],
  ['A'.repeat(101), false, 'Exceeds 100 chars'],
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

// Capitalization preservation checks
const preservationTests = [
  ['carl jay matugas', 'carl jay matugas'],
  ['Carl Jay Matugas', 'Carl Jay Matugas'],
  ['CARL JAY MATUGAS', 'CARL JAY MATUGAS'],
  ['  José Matugas  ', 'José Matugas'],
  ['Ma. Cristina Santos', 'Ma. Cristina Santos'],
  ["Mary-Ann O'Brien", "Mary-Ann O'Brien"],
];

console.log('\nCapitalization preservation tests:');
preservationTests.forEach(([input, expected]) => {
  const result = validateFullName(input);
  if (!result.valid || result.value !== expected) {
    console.error(`  ✗ FAIL: "${input}" → expected "${expected}", got "${result.value}" (valid=${result.valid})`);
    failed++;
  } else {
    console.log(`  ✓ PASS: "${input}" → "${result.value}"`);
    passed++;
  }
});

console.log(`\nTotal: ${passed + failed} tests, ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
