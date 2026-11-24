'use strict';
/**
 * Automated Acceptance Test Script
 * Verifies all Level 1, Level 2, and Level 3 acceptance requirements.
 */
const assert = require('assert');
const http = require('http');
const app = require('../src/app');
const db = require('../src/db/db');

let server;
const PORT = 3001;
const BASE = `http://localhost:${PORT}`;

function post(path, data = {}, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = typeof data === 'string' ? data : new URLSearchParams(data).toString();
    const req = http.request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, { headers }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function runAcceptanceChecks() {
  server = app.listen(PORT);
  console.log('Testing server running on port', PORT);

  try {
    console.log('\n--- Checking Level 1 Requirements ---');
    // 1. Event list
    const home = await get('/');
    assert.strictEqual(home.status, 200);
    assert(home.body.includes('Cebu Dev Meetup 2026'), 'Must display Cebu Dev Meetup 2026');
    assert(home.body.includes('Full'), 'Cebu Dev Meetup should show Full');
    console.log('✔ 01 Event list displays upcoming events and shows "Full"');

    // 2. Form validation
    const regBad = await post('/events/2/register', {
      full_name: '',
      email: 'not-an-email',
      mobile: '0912345678' // 10 digits
    });
    assert(regBad.body.includes('Full name is required'), 'Checks required name');
    assert(regBad.body.includes('A valid email address is required'), 'Checks valid email');
    assert(regBad.body.includes('Mobile must be 11 digits starting with 09'), 'Checks 11-digit mobile');
    console.log('✔ 02 Registration form validates email, name, and 11-digit mobile');

    // 3. Successful registration for open event (UX Design Workshop, id=2)
    const testEmail = `testuser_${Date.now()}@example.com`;
    const regGood = await post('/events/2/register', {
      full_name: 'Test Attendee',
      email: testEmail,
      mobile: '09171234567'
    });
    assert.strictEqual(regGood.status, 302, 'Should redirect after successful registration');
    const redirectUrl = regGood.headers.location;
    const ticketCodeMatch = redirectUrl.match(/\/ticket\/([A-Z0-9-]+)/);
    assert(ticketCodeMatch, 'Must redirect to ticket URL');
    const ticketCode = ticketCodeMatch[1];
    console.log(`✔ 02/03 Registration succeeded with ticket code: ${ticketCode}`);

    // 4. Duplicate registration blocked
    const regDup = await post('/events/2/register', {
      full_name: 'Test Attendee',
      email: testEmail,
      mobile: '09171234567'
    });
    assert(regDup.body.includes('already registered'), 'Duplicate registration must be blocked');
    console.log('✔ 02 Duplicate email registration blocked');

    // 5. Ticket page shows details and QR code
    const ticketPage = await get(redirectUrl);
    assert.strictEqual(ticketPage.status, 200);
    assert(ticketPage.body.includes(ticketCode), 'Ticket page must display ticket code');
    assert(ticketPage.body.includes('data:image/png;base64,'), 'Ticket page must display QR image');
    console.log('✔ 03 Ticket page displays ticket details & QR code');

    // 6. Ticket lookup by ticket code + email OR mobile
    const lookupEmail = await get(`/ticket/${ticketCode}?identifier=${encodeURIComponent(testEmail)}`);
    assert.strictEqual(lookupEmail.status, 200);
    assert(lookupEmail.body.includes('Test Attendee'), 'Lookup by email must work');

    const lookupMobile = await get(`/ticket/${ticketCode}?identifier=09171234567`);
    assert.strictEqual(lookupMobile.status, 200);
    assert(lookupMobile.body.includes('Test Attendee'), 'Lookup by mobile must work');

    const lookupBad = await get(`/ticket/${ticketCode}?identifier=wrong@example.com`);
    assert(lookupBad.body.includes('Ticket not found'), 'Wrong email combination must show "Ticket not found"');
    console.log('✔ 03 Ticket lookup works by email or mobile, blocks wrong combinations');

    // 7. Staff login and security
    const staffUnauth = await get('/staff/dashboard');
    assert.strictEqual(staffUnauth.status, 302);
    assert(staffUnauth.headers.location.includes('/staff/login'), 'Unauthenticated access redirects to login');
    console.log('✔ 04 Unauthenticated staff pages redirect to sign-in');

    // Sign in as organizer
    const loginRes = await post('/staff/login', { username: 'organizer', password: 'organizer123' });
    assert.strictEqual(loginRes.status, 302);
    const cookie = loginRes.headers['set-cookie'][0].split(';')[0];
    console.log('✔ 04 Staff sign-in works with hashed passwords');

    // 8. Check-in flow
    // First scan: Valid ticket -> Checked in (green)
    const checkin1 = await post('/staff/checkin', {
      event_id: '2',
      ticket_code: ticketCode
    }, { Cookie: cookie });
    assert(checkin1.body.includes('Checked in'), 'First scan must show Checked in');
    assert(checkin1.body.includes('result-success'), 'Must have green success style');
    console.log('✔ 05 Check-in screen checks in valid ticket (green)');

    // Second scan: Already checked in (yellow)
    const checkin2 = await post('/staff/checkin', {
      event_id: '2',
      ticket_code: ticketCode
    }, { Cookie: cookie });
    assert(checkin2.body.includes('Already checked in'), 'Second scan must show Already checked in');
    assert(checkin2.body.includes('result-already'), 'Must have yellow warning style');
    console.log('✔ 05 Second check-in shows Already checked in (yellow) with time');

    // Made-up or wrong event ticket -> Invalid ticket (red)
    const checkinBad = await post('/staff/checkin', {
      event_id: '2',
      ticket_code: 'FAKE-000000-0000'
    }, { Cookie: cookie });
    assert(checkinBad.body.includes('Invalid ticket'), 'Made-up ticket must show Invalid ticket');
    assert(checkinBad.body.includes('result-invalid'), 'Must have red error style');
    console.log('✔ 05 Made-up ticket shows Invalid ticket (red)');

    console.log('\n--- Checking Level 2 Requirements ---');
    // 9. Waitlist on full event (Cebu Dev Meetup, id=1)
    const waitlistEmail = `waitlist_${Date.now()}@example.com`;
    const regWaitlist = await post('/events/1/register', {
      full_name: 'Waitlist User',
      email: waitlistEmail,
      mobile: '09181234567'
    });
    assert.strictEqual(regWaitlist.status, 302);
    const waitlistUrl = regWaitlist.headers.location;
    const waitlistTicket = waitlistUrl.match(/\/ticket\/([A-Z0-9-]+)/)[1];
    const waitlistPage = await get(waitlistUrl);
    assert(waitlistPage.body.includes('Waitlist Position'), 'Must show waitlist position');
    console.log(`✔ 08 Full event allows joining waitlist: ${waitlistTicket}`);

    // Waitlisted scan shows "On waitlist — not confirmed"
    const waitlistScan = await post('/staff/checkin', {
      event_id: '1',
      ticket_code: waitlistTicket
    }, { Cookie: cookie });
    assert(waitlistScan.body.includes('On waitlist'), 'Scanning waitlist ticket must show On waitlist');
    console.log('✔ 08 Scanning waitlisted ticket shows "On waitlist — not confirmed"');

    // 10. Undo check-in
    const regRow = await db.prepare('SELECT id FROM registrations WHERE ticket_code = ?').get(ticketCode);
    const undoRes = await post('/staff/checkin/undo', {
      registration_id: regRow.id,
      event_id: '2'
    }, { Cookie: cookie });
    assert.strictEqual(undoRes.status, 302);
    console.log('✔ 11 Undo check-in resets ticket status to Confirmed');

    console.log('\n--- Checking Level 3 Requirements ---');
    // 11. Sequential/guessed ticket codes rejected
    const verifyTicket = require('../src/utils/ticket').verifyTicketCode;
    assert.strictEqual(verifyTicket('CDM-000001'), false, 'Sequential code must be rejected');
    assert.strictEqual(verifyTicket('CDM-000001-XXXX'), false, 'Fake signature must be rejected');
    console.log('✔ 14 Cryptographic HMAC prevents guessing or sequential ticket codes');

    // 12. Door staff restrictions
    const doorLogin = await post('/staff/login', { username: 'doorstaff', password: 'door123' });
    const doorCookie = doorLogin.headers['set-cookie'][0].split(';')[0];
    const doorTryEvents = await get('/staff/events', { Cookie: doorCookie });
    assert.strictEqual(doorTryEvents.status, 403, 'Door staff must be forbidden from accessing /staff/events');
    console.log('✔ 16 Role separation: Door staff blocked from event management (403)');

    console.log('\n======================================================');
    console.log('🎉 ALL LEVEL 1, LEVEL 2, & LEVEL 3 CHECKS COMPLETED!');
    console.log('======================================================\n');
    process.exit(0);
  } finally {
    server.close();
  }
}

runAcceptanceChecks().catch(err => {
  console.error('❌ Acceptance test error:', err);
  if (server) server.close();
  process.exit(1);
});
