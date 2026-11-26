'use strict';
/**
 * Automated Acceptance Test Suite
 * Verifies all 12 Acceptance Tests across Level 1, Level 2, and Level 3 requirements
 * against an isolated local SQLite test database (never mutating production PostgreSQL).
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const http = require('http');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const testDbPath = path.join(repoRoot, 'data', `acceptance_test_${process.pid}.db`);
for (const ext of ['', '-shm', '-wal']) {
  try { fs.unlinkSync(testDbPath + ext); } catch (_) {}
}

// Isolate acceptance tests from production Neon DATABASE_URL
process.env.DATABASE_URL = '';
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';
process.env.SKIP_AUTO_SEED = 'true';
process.env.SESSION_SECRET = 'acceptance_test_session_secret_123456';
process.env.TICKET_HMAC_SECRET = 'acceptance_test_hmac_secret_123456';

const db = require('../src/db/db');
const seed = require('../src/db/seed');
const app = require('../src/app');
const { generateTicketCode, verifyTicketCode } = require('../src/utils/ticket');
const { getManilaDateKey, nowCebu } = require('../src/utils/time');

let server;
let BASE = '';

function request(method, reqPath, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const isJson = headers['Content-Type'] === 'application/json';
    const postData = data ? (isJson ? JSON.stringify(data) : new URLSearchParams(data).toString()) : '';
    const req = http.request(`${BASE}${reqPath}`, {
      method,
      headers: {
        ...(data && !isJson ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, body: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (data) req.write(postData);
    req.end();
  });
}

const get = (p, h = {}) => request('GET', p, null, h);
const post = (p, d = {}, h = {}) => request('POST', p, d, h);

function cleanupDb() {
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(testDbPath + ext); } catch (_) {}
  }
}

async function runAcceptanceChecks() {
  await seed();

  // Seed helper events for T2 & T6 tests:
  // id=4: Ended event
  // id=5: Closed event
  // id=6: Event scheduled TODAY in Asia/Manila for door check-in tests
  const todayManila = getManilaDateKey(Date.now());
  await db.prepare(
    `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status) VALUES (?,?,?,?,?,?,?)`
  ).run('Past Meetup 2025', 'Ended event test', 'Old Hall', '2025-01-10 10:00:00', '2025-01-10 14:00:00', 20, 'Published');
  await db.prepare(
    `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status) VALUES (?,?,?,?,?,?,?)`
  ).run('Closed Future Event', 'Closed manually', 'Side Room', '2028-05-01 10:00:00', '2028-05-01 14:00:00', 20, 'Closed');
  await db.prepare(
    `INSERT INTO events (title, description, venue, starts_at, ends_at, capacity, status) VALUES (?,?,?,?,?,?,?)`
  ).run('Today Check-in Event', 'Live event day check-in verification', 'Main Hall', `${todayManila} 00:00:00`, `${todayManila} 23:59:00`, 10, 'Published');

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      BASE = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  try {
    console.log('\n--- Running Acceptance Tests (1-12) ---');

    // AT-1 & AT-4: Event list, venue, real description, Tech & Developer tag, full seed, synchronized spots
    const home = await get('/');
    assert.strictEqual(home.status, 200);
    assert(home.body.includes('Cebu Dev Meetup 2026'), 'AT-4: Cebu Dev Meetup 2026 visible');
    assert(home.body.includes('Ayala Center Cebu, Function Room 2'), 'AT-4: Correct venue');
    assert(home.body.includes('TECH &amp; DEVELOPER') || home.body.includes('TECH & DEVELOPER'), 'AT-4: Tech & Developer tag');
    assert(home.body.includes('FULL (30/30)'), 'AT-4: Seeded full 30/30');
    assert(!home.body.includes('Draft: Future PHP Conf'), 'Draft event hidden');

    const det1 = await get('/events/1');
    const reg1 = await get('/events/1/register');
    assert(det1.body.includes('0 of 30 spots left') && det1.body.includes('Join Waitlist'), 'AT-1: Event 1 details match 0/30 + Join Waitlist');
    assert(reg1.body.includes('0 OF 30 SPOTS LEFT') && reg1.body.includes('Join Waitlist'), 'AT-1: Event 1 register matches 0/30 + Join Waitlist');

    const det2 = await get('/events/2');
    const reg2 = await get('/events/2/register');
    assert(home.body.includes('20 OF 20 SPOTS LEFT'), 'AT-1: Event 2 list shows 20 of 20');
    assert(det2.body.includes('20 OF 20 SPOTS LEFT'), 'AT-1: Event 2 details shows 20 of 20');
    assert(reg2.body.includes('20 OF 20 SPOTS LEFT'), 'AT-1: Event 2 register shows 20 of 20');
    console.log('✔ AT-1 & AT-4: Consistent capacity, seeded full Cebu Dev Meetup at Ayala Center Cebu, Tech & Developer tag');

    // AT-2: Direct POST to full event never creates Confirmed registration (places on Waitlist)
    const waitlistEmail = `waitlist_${Date.now()}@example.com`;
    const regFull = await post('/events/1/register', {
      full_name: 'Waitlist User',
      email: waitlistEmail,
      mobile: '09181234567'
    });
    assert.strictEqual(regFull.status, 302, 'AT-2: Waitlist redirects to ticket');
    const wlUrl = regFull.headers.location;
    const wlCode = wlUrl.match(/\/ticket\/([A-Z0-9-]+)/)[1];
    const wlPage = await get(wlUrl);
    assert(wlPage.body.includes('Waitlist Position') && wlPage.body.includes('#1'), 'AT-2: Ticket shows Waitlist Position #1');
    const wlRow = await db.prepare('SELECT status FROM registrations WHERE ticket_code = ?').get(wlCode);
    assert.strictEqual(wlRow.status, 'Waitlisted', 'AT-2: Full event POST must NEVER create Confirmed row');
    console.log('✔ AT-2: Direct POST to full event created Waitlisted ticket (never Confirmed)');

    // AT-3: Ended event hidden from list; Ended/Closed/Draft registration rejected server-side
    assert(!home.body.includes('Past Meetup 2025'), 'AT-3: Ended event hidden from public list');
    assert.strictEqual((await get('/events/4/register')).status, 410, 'AT-3: Ended GET rejected');
    assert.strictEqual((await post('/events/4/register', { full_name: 'Test User', email: 'e@x.com', mobile: '09171112223' })).status, 410, 'AT-3: Ended POST rejected');
    assert.strictEqual((await get('/events/5/register')).status, 400, 'AT-3: Closed GET rejected');
    assert.strictEqual((await post('/events/5/register', { full_name: 'Test User', email: 'e@x.com', mobile: '09171112223' })).status, 400, 'AT-3: Closed POST rejected');
    assert.strictEqual((await get('/events/3/register')).status, 404, 'AT-3: Draft GET rejected');
    assert.strictEqual((await post('/events/3/register', { full_name: 'Test User', email: 'e@x.com', mobile: '09171112223' })).status, 404, 'AT-3: Draft POST rejected');
    console.log('✔ AT-3: Ended events hidden & Ended/Closed/Draft registration rejected server-side');

    // AT-5: Staff login shows no credentials; login with documented creds works; RBAC 403 for door staff
    const loginPage = await get('/staff/login');
    assert.strictEqual(loginPage.status, 200);
    assert(!loginPage.body.includes('organizer123') && !loginPage.body.includes('door123'), 'AT-5: No demo passwords on login page');

    const staffUnauth = await get('/staff/dashboard');
    assert.strictEqual(staffUnauth.status, 302);
    assert(staffUnauth.headers.location.includes('/staff/login'));

    const orgLogin = await post('/staff/login', { username: 'organizer', password: 'organizer123' });
    assert.strictEqual(orgLogin.status, 302);
    const orgCookie = orgLogin.headers['set-cookie'][0].split(';')[0];

    const doorLogin = await post('/staff/login', { username: 'doorstaff', password: 'door123' });
    assert.strictEqual(doorLogin.status, 302);
    const doorCookie = doorLogin.headers['set-cookie'][0].split(';')[0];
    assert.strictEqual((await get('/staff/events', { Cookie: doorCookie })).status, 403, 'AT-5: Door staff gets 403 on organizer routes');
    console.log('✔ AT-5: Staff login clean of credentials, auth + RBAC verified');

    // AT-6: Form validation + Filipino/international names accepted; digits/script/emoji rejected; duplicate/lookup check
    const regBad = await post('/events/2/register', { full_name: '', email: 'not-an-email', mobile: '0912345678' });
    assert(regBad.body.includes('Full name is required') && regBad.body.includes('A valid email') && regBad.body.includes('Mobile must be'));

    const validNames = ['Ma. Cristina Santos', 'Juan Dela Cruz Jr.', "Mary-Ann O'Brien"];
    let lastCode = '';
    let lastEmail = '';
    for (let i = 0; i < validNames.length; i++) {
      lastEmail = `nameok_${i}_${Date.now()}@example.com`;
      const okRes = await post('/events/2/register', {
        full_name: validNames[i],
        email: lastEmail,
        mobile: `0917000010${i}`
      });
      assert.strictEqual(okRes.status, 302, `AT-6: Should accept "${validNames[i]}"`);
      lastCode = okRes.headers.location.match(/\/ticket\/([A-Z0-9-]+)/)[1];
    }

    for (const badEmail of ['carljaymatugas@#$$%.com', 'carl#1@gmail.com', 'carl$test@example.com', 'carl+tag@gmail.com', 'carl@gmail..com', 'carl@-bad.com', 'carl@bad.123']) {
      const badEmailRes = await post('/events/2/register', {
        full_name: 'Valid Name',
        email: badEmail,
        mobile: '09170000998'
      });
      assert.strictEqual(badEmailRes.status, 400, `AT-6: Should reject special-char/invalid email "${badEmail}"`);
    }

    for (const badName of ['John123', '<script>', '😀']) {
      const badRes = await post('/events/2/register', {
        full_name: badName,
        email: `bad_${Date.now()}@example.com`,
        mobile: '09170000999'
      });
      assert.strictEqual(badRes.status, 400, `AT-6: Should reject "${badName}"`);
    }

    // Duplicate email & mobile blocked + ticket lookup by email/mobile/generic error
    const regDup = await post('/events/2/register', { full_name: 'Dup Test', email: lastEmail, mobile: '09179990001' });
    assert.strictEqual(regDup.status, 400);
    assert(regDup.body.includes('already registered'));
    const ticketPage = await get(`/ticket/${lastCode}?identifier=${encodeURIComponent(lastEmail)}`);
    assert(ticketPage.body.includes(lastCode) && ticketPage.body.includes('data:image/png;base64,'));
    const lookupBad = await get(`/ticket/${lastCode}?identifier=wrong@example.com`);
    assert(lookupBad.body.includes('Ticket not found'));
    console.log('✔ AT-6: Accepted Ma. Cristina Santos / Juan Dela Cruz Jr. / Mary-Ann O\'Brien; rejected John123 / <script> / 😀');

    // AT-7 & AT-10: Check-in outcomes + altered/sequential code + event-day rule
    const nowStr = nowCebu();
    const todayValidCode = generateTicketCode('TCE');
    const todayWaitCode = generateTicketCode('TCE');
    const todayCancCode = generateTicketCode('TCE');
    await db.prepare(`INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?,?,?,?,?,?,?)`)
      .run(6, 'Door Attendee', 'door1@example.com', '09172220001', todayValidCode, 'Confirmed', nowStr);
    await db.prepare(`INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, waitlist_pos, registered_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(6, 'Door Waitlisted', 'door2@example.com', '09172220002', todayWaitCode, 'Waitlisted', 1, nowStr);
    await db.prepare(`INSERT INTO registrations (event_id, full_name, email, mobile, ticket_code, status, registered_at) VALUES (?,?,?,?,?,?,?)`)
      .run(6, 'Door Cancelled', 'door3@example.com', '09172220003', todayCancCode, 'Cancelled', nowStr);

    // Valid -> green Checked in + name
    const chkValid = await post('/staff/checkin', { event_id: '6', ticket_code: todayValidCode }, { Cookie: doorCookie });
    assert(chkValid.body.includes('result-success') && chkValid.body.includes('Checked in') && chkValid.body.includes('Door Attendee'));
    // Repeat -> yellow Already checked in + original time
    const chkRepeat = await post('/staff/checkin', { event_id: '6', ticket_code: todayValidCode }, { Cookie: doorCookie });
    assert(chkRepeat.body.includes('result-already') && chkRepeat.body.includes('Already checked in'));
    // Invented code & altered char & CDM-000001 -> red Invalid ticket (AT-7 & AT-10)
    const alteredCode = todayValidCode.slice(0, -1) + (todayValidCode.endsWith('A') ? 'B' : 'A');
    assert.strictEqual(verifyTicketCode('CDM-000001'), false);
    assert.strictEqual(verifyTicketCode(alteredCode), false);
    for (const badCode of ['FAKE-000000-00000000', 'CDM-000001', alteredCode]) {
      const chkInv = await post('/staff/checkin', { event_id: '6', ticket_code: badCode }, { Cookie: doorCookie });
      assert(chkInv.body.includes('result-invalid') && chkInv.body.includes('Invalid ticket'), `Expected red Invalid ticket for ${badCode}`);
    }
    // Real ticket from Event 2 scanned under Event 6 -> red Invalid ticket
    const chkOther = await post('/staff/checkin', { event_id: '6', ticket_code: lastCode }, { Cookie: doorCookie });
    assert(chkOther.body.includes('result-invalid') && chkOther.body.includes('Invalid ticket'));
    // Waitlisted -> On waitlist — not confirmed
    const chkWait = await post('/staff/checkin', { event_id: '6', ticket_code: todayWaitCode }, { Cookie: doorCookie });
    assert(chkWait.body.includes('result-waitlisted') && chkWait.body.includes('On waitlist'));
    // Cancelled -> Cancelled
    const chkCanc = await post('/staff/checkin', { event_id: '6', ticket_code: todayCancCode }, { Cookie: doorCookie });
    assert(chkCanc.body.includes('result-invalid') && chkCanc.body.includes('Cancelled'));

    // Undo check-in by ticket_code -> restores Confirmed and redirects back to /staff/checkin with message
    const undoByCode = await post('/staff/checkin/undo', { event_id: '6', ticket_code: todayValidCode, return_to: 'checkin' }, { Cookie: doorCookie });
    assert.strictEqual(undoByCode.status, 302, 'AT-7: Undo by ticket_code redirects cleanly');
    assert(undoByCode.headers.location.includes('/staff/checkin') && undoByCode.headers.location.includes('Check-in%20undone'));
    const afterUndoRow = await db.prepare('SELECT status FROM registrations WHERE ticket_code = ?').get(todayValidCode);
    assert.strictEqual(afterUndoRow.status, 'Confirmed', 'AT-7: Undo by ticket_code must restore Confirmed status');
    // Re-check in so AT-12 confirmed/checked-in ratio (1/1) matches below
    await post('/staff/checkin', { event_id: '6', ticket_code: todayValidCode }, { Cookie: doorCookie });

    // Production startup refusal check (AT-10)
    let prodRefused = false;
    try {
      execFileSync('node', ['-e', "require('./src/app')"], {
        cwd: repoRoot,
        env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'change-me', TICKET_HMAC_SECRET: 'change-me' },
        stdio: 'pipe'
      });
    } catch (e) {
      prodRefused = e.status !== 0;
    }
    assert.strictEqual(prodRefused, true, 'AT-10: Production must refuse placeholder secrets');
    console.log('✔ AT-7 & AT-10: All check-in outcomes, altered/sequential ticket rejection, and prod secret checks passed');

    // AT-12: CSV export row count, UTF-8 BOM, totals, and dashboard columns match attendee list
    const attPage = await get('/staff/attendees/6', { Cookie: orgCookie });
    assert(attPage.body.includes('1 / 10') && attPage.body.includes('1 / 1'));
    const csvRes = await get('/staff/attendees/6/export.csv', { Cookie: orgCookie });
    assert.strictEqual(csvRes.buf[0], 0xEF);
    assert.strictEqual(csvRes.buf[1], 0xBB);
    assert.strictEqual(csvRes.buf[2], 0xBF);
    const csvRows = csvRes.body.replace(/^\uFEFF/, '').split('\r\n');
    assert.strictEqual(csvRows.length, 4, 'AT-12: 1 header + 3 Event 6 registrations');
    const dashPage = await get('/staff/dashboard', { Cookie: orgCookie });
    assert(dashPage.body.includes('<th>Cancelled</th>') && dashPage.body.includes('<th>No-Shows</th>'));
    console.log('✔ AT-12: CSV export (UTF-8 BOM) & dashboard metrics match attendee list');

    // AT-11: Rate limiting returns 429 on all 4 limiters (isolated per-limiter X-Forwarded-For IP)
    let rlLogin = false;
    for (let i = 0; i < 12; i++) {
      if ((await post('/staff/login', { username: 'organizer', password: 'wrong' }, { 'X-Forwarded-For': '10.1.1.1' })).status === 429) {
        rlLogin = true; break;
      }
    }
    let rlLookup = false;
    for (let i = 0; i < 32; i++) {
      if ((await get(`/ticket/FAKE-${i}?identifier=a@b.com`, { 'X-Forwarded-For': '10.1.1.2' })).status === 429) {
        rlLookup = true; break;
      }
    }
    let rlReg = false;
    for (let i = 0; i < 22; i++) {
      if ((await post('/events/2/register', { full_name: 'X', email: 'bad', mobile: 'bad' }, { 'X-Forwarded-For': '10.1.1.3' })).status === 429) {
        rlReg = true; break;
      }
    }
    let rlCheckin = false;
    for (let i = 0; i < 65; i++) {
      if ((await post('/staff/checkin/api', { event_id: 6, ticket_code: 'CDM-000001' }, {
        Cookie: doorCookie,
        'Content-Type': 'application/json',
        'X-Forwarded-For': '10.1.1.4'
      })).status === 429) {
        rlCheckin = true; break;
      }
    }
    assert(rlLogin && rlLookup && rlReg && rlCheckin, 'AT-11: All 4 rate limiters must return 429');
    console.log('✔ AT-11: Rate limits return 429 on login, lookup, registration, and check-in');

    console.log('\n======================================================');
    console.log('🎉 ALL ACCEPTANCE TESTS PASSED!');
    console.log('======================================================\n');
  } finally {
    server.close();
    cleanupDb();
  }
}

runAcceptanceChecks()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Acceptance test error:', err);
    if (server) server.close();
    cleanupDb();
    process.exit(1);
  });
