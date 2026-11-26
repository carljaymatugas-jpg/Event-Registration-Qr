# Event Registration with QR Check-in

A full-featured event registration and QR check-in web application built with Node.js, Express, Nunjucks SSR, PostgreSQL (Neon in production), and SQLite (local development).

- **Live Website**: [https://event-registration-qr.vercel.app/](https://event-registration-qr.vercel.app/)
- **Walkthrough Script (3–5 min)**: [`DEMO.md`](./DEMO.md) *(record an optional screencast following this walkthrough)*
- **Target Level**: **Level 3 · Advanced**
- **Canonical Seed Event**: Cebu Dev Meetup 2026 · Ayala Center Cebu, Function Room 2 (seeded full: 30/30 Confirmed)
- **Time Zone**: `Asia/Manila` (UTC+8) · 12-hour AM/PM display throughout

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v18+ / v20+ / v22+ / v24+ |
| Framework | Express.js (`trust proxy = 1` enabled for Vercel) |
| Templating | Nunjucks SSR (auto-escaping enabled) |
| Database (production) | PostgreSQL on Neon (`pg` pool via `DATABASE_URL`) |
| Database (local dev) | SQLite (`better-sqlite3` / `node:sqlite`) |
| Auth & Passwords | `bcryptjs` (cost 12) + DB-backed sessions (`connect-pg-simple` / SQLite store) |
| Security | `express-rate-limit` (Postgres shared store in prod), RBAC (`requireStaff` / `requireOrganizer`), 8-char HMAC-SHA256 QR tokens |
| QR Engine | `qrcode` (server PNG) + `html5-qrcode` (camera scanner with offline bundle + manual entry fallback) |
| Email | `nodemailer` / Resend HTTP API (`RESEND_API_KEY`, Mailtrap SMTP, or local Ethereal sandbox) |
| Hosting | Vercel serverless (`vercel.json` + `api/index.js`) |

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env: keep DATABASE_URL empty/commented out to use local SQLite,
# and replace SESSION_SECRET & TICKET_HMAC_SECRET before production deployment.
```

### 3. Seed & Start
```bash
npm run seed    # Idempotent across PostgreSQL and SQLite
npm start
```
Open **`http://localhost:3000`**.

### 4. HTTPS for Mobile Camera Testing
```bash
npm run https
# Open https://<YOUR_LOCAL_IP>:3443 and accept the self-signed dev certificate
```

### 5. Run Automated Tests
```bash
npm test                             # SQLite + Neon PostgreSQL race tests & 12 acceptance tests
node scripts/test_name_validation.js # 43 full-name validation unit & edge-case tests
```

---

## 🔑 Demo Staff Credentials

> **Security notice:** Demo passwords are for local development and QA review only.  
> The `/staff/login` web page **never prints usernames or passwords**.  
> Before deploying or seeding production, set strong passwords via `SEED_ORGANIZER_PASSWORD` and `SEED_DOOR_PASSWORD` environment variables.

| Role | Username | Demo Default Password | Permissions |
|---|---|---|---|
| **Organizer** | `organizer` | `organizer123` | Full access: create/edit/close/delete events, view attendees, promote waitlist, cancel, check in, undo check-in, export CSV, audit log |
| **Door Staff** | `doorstaff` | `door123` | Door check-in & undo check-in only (`403 Forbidden` on `/staff/events`, attendee cancellations, promotions, and CSV export) |

---

## 📁 Schema, Seed & Repo Structure

| Component | Location | Notes |
|---|---|---|
| PostgreSQL DDL & Indexes | [`src/db/schema.pg.sql`](./src/db/schema.pg.sql) | Canonical Postgres schema (`events`, `staff_users`, `registrations`, `audit_logs`, `session`, `rate_limits`, plus `uq_event_email_active`) |
| Dual-DB Adapter & SQLite DDL | [`src/db/db.js`](./src/db/db.js) | Uses Neon Postgres when `DATABASE_URL` is set; creates SQLite tables + `uq_active_reg` locally |
| Idempotent Seed & Reset | [`src/db/seed.js`](./src/db/seed.js) | Supports both PostgreSQL and SQLite; accepts `--reset` guarded by `ALLOW_RESEED=true` |
| Shared Availability Logic | [`src/utils/availability.js`](./src/utils/availability.js) | Single `getEventAvailability(eventId)` source of truth across list, details, register, check-in, and dashboard |
| Legacy Neon Migration Script | [`scripts/migrate_to_neon.js`](./scripts/migrate_to_neon.js) | Initial SQLite-to-Neon migration script |
| Neon CLI Config | [`neon.ts`](./neon.ts) | Neon CLI branch policy config (`@neon/config/v1`); **not** imported or run at runtime by Express or Vercel |

### Seeded Data Overview

| Event | Venue | Capacity | Status | Category Tag |
|---|---|---|---|---|
| **Cebu Dev Meetup 2026** | Ayala Center Cebu, Function Room 2 | 30 | Published (**30/30 Confirmed — Full**) | `TECH & DEVELOPER` |
| **UX Design Workshop** | IT Park, Cebu City – Co-Lab Space | 20 | Published | `DESIGN & CREATIVE` |
| **Draft: Future PHP Conf** | TBD | 50 | Draft (hidden from public routes) | — |

### Missing Event 3 Explanation (Live Production DB Investigation)
Audit logs in the live Neon PostgreSQL database (`audit_logs` IDs `125` and `131`) show that Event 3 (`"Draft: Future PHP Conf"`) was manually closed on `2026-11-24 12:35:43` and permanently deleted via the Staff Events dashboard on `2026-11-24 13:13:45` (`action = 'event_delete'`, `target_id = 3`). Events 4 (`Carl Concert`) and 5 (`Macky MLBB Tournament`) were subsequently created manually during live testing.

### Safe Production Re-seed Procedure (`npm run seed:prod`)
`npm run seed` is safe and idempotent (inserts missing records without overwriting existing rows).  
To reset production tables (`audit_logs`, `registrations`, `events`), remove ad-hoc test events, reset staff passwords from `SEED_ORGANIZER_PASSWORD` / `SEED_DOOR_PASSWORD`, and re-seed the canonical 3 events + full 30/30 Cebu Dev Meetup 2026:

**Bash / Linux / macOS:**
```bash
ALLOW_RESEED=true npm run seed:prod
```

**Windows PowerShell:**
```powershell
$env:ALLOW_RESEED="true"; npm run seed:prod; Remove-Item Env:ALLOW_RESEED
```

**Cross-Platform CLI Arguments (Any OS):**
```bash
node src/db/seed.js --reset --allow-reseed
```

> **Note:** The live Neon database has already been synchronized with the canonical events (Cebu Dev Meetup 2026 30/30, UX Design Workshop, Draft Future PHP Conf) and the demo staff logins. The reseed procedure above is available whenever you need a clean reset.

---

## 📋 Capacity, Waitlist & Event States

### Single Availability Source (`getEventAvailability`)
All pages and endpoints (`GET /`, `GET /events/:id`, `GET /events/:id/register`, `POST /events/:id/register`, `GET/POST /staff/checkin`, and `/staff/dashboard`) derive capacity from `src/utils/availability.js`:
- **Active seats counted**: `status IN ('Confirmed', 'CheckedIn')` only.
- **Excluded from capacity**: `Waitlisted` and `Cancelled` never reduce `spots_left`.

### Full Event vs. Waitlist Behaviour
- **Waitlist IS enabled** for **Upcoming Published** events that reach full capacity (`spots_left === 0`).
- **UI**: Full upcoming events display **"Full (30/30)"** across event cards, event details, and the registration form, and replace the normal button with **"Join Waitlist →"**.
- **Server (`POST /events/:id/register`)**: Re-checks confirmed seat count inside the DB transaction. A direct POST to a full upcoming event **never creates a `Confirmed` registration** — it places the registrant into `Waitlisted` with the next `waitlist_pos`.

### Event States (`Asia/Manila`, UTC+8)
Timestamps are parsed as `Asia/Manila` epoch milliseconds (`src/utils/time.js`) so behavior is independent of Vercel's UTC server clock:

| Event State | Condition | Public List (`/`) | Registration (`GET` & `POST`) |
|---|---|---|---|
| **Upcoming** | `status = 'Published'` and `now < starts_at` | Visible | Open (or **Waitlist** if Full) |
| **In Progress** | `status = 'Published'` and `starts_at <= now < ends_at` | Visible (`IN PROGRESS`) | **Closed** (HTTP 400; closes when event starts) |
| **Ended** | `now >= ends_at` | **Hidden** from public list | **Closed** (HTTP 410) |
| **Closed** | `status = 'Closed'` | Hidden from public list | **Closed** (HTTP 400) |
| **Draft** | `status = 'Draft'` | Hidden | **Rejected** (HTTP 404) |

---

## 🚪 Door Check-in Rules (`src/routes/checkin.js`)

1. **Selected Event Match**: Ticket must belong to the currently selected event; tickets from other events return red **"Invalid ticket — belongs to a different event."**
2. **Event-Day Window (`Asia/Manila`)**: Check-in is allowed **only on the event calendar day(s)** in `Asia/Manila` (`00:00 AM` on `starts_at` date through `11:59 PM` on `ends_at` date, via `getCheckinWindowStatus`). Early or past-day scans return red rejection without updating status.
3. **Status Outcomes (Colour + Text)**:
   - Valid `Confirmed` on event day → **Green** `"Checked in"` + attendee name; writes `checked_in_at` & `checked_in_by` once.
   - Already `CheckedIn` → **Yellow** `"Already checked in"` + original 12-hour AM/PM check-in time.
   - `Waitlisted` → **Orange** `"On waitlist — not confirmed."`
   - `Cancelled` → **Red** `"Cancelled — this registration was cancelled."`
   - Forged / sequential / altered / missing → **Red** `"Invalid ticket — code not recognised."`
4. **Live Counter**: Header displays `X / Y CHECKED IN`, refreshed from DB after manual submit and live JSON camera scans.

---

## 🔒 Concurrency, Security & Rate Limiting

### Race Condition Protection (PostgreSQL & SQLite)
- **PostgreSQL (Production / Neon)**:
  - **Last-spot registration / promotion / restore**: Transactions (`pool.connect()` -> `BEGIN`) lock the parent event row with `SELECT id FROM events WHERE id = $1 FOR UPDATE` before counting `Confirmed` + `CheckedIn` seats. Concurrent last-spot requests serialize on the row lock: the first gets `Confirmed`, subsequent ones get `Waitlisted`.
  - **Duplicate active registration**: Enforced inside the locked transaction and backed by partial unique index `uq_event_email_active ON registrations(event_id, email) WHERE status IN ('Confirmed','CheckedIn','Waitlisted')`.
  - **Simultaneous check-in**: Uses a single atomic conditional statement:  
    `UPDATE registrations SET status='CheckedIn', checked_in_at=$1, checked_in_by=$2 WHERE id=$3 AND status='Confirmed'`  
    If `rowCount === 0` (`changes === 0`), the concurrent scan immediately detects it was already updated and returns yellow `"Already checked in"` with the original `checked_in_at` timestamp.
- **SQLite (Local Development)**:
  - Uses WAL mode + `BEGIN IMMEDIATE` exclusive write transactions to serialize registrations, plus the same atomic conditional `UPDATE ... WHERE id=? AND status='Confirmed'` check-in statement and `uq_active_reg` partial index.

### Ticket Code Strength & Secret Guard (`src/utils/ticket.js`, `src/app.js`)
- Ticket codes use format `PREFIX-RANDOM6-HMAC8` (8 uppercase hex chars of HMAC-SHA256 = 32 bits, e.g. `CDM-7K3P9Q-A3F21B9C`). *(Legacy 4-char HMAC codes created before this upgrade remain verifiable for existing live DB tickets; forged/altered codes fail `crypto.timingSafeEqual` before hitting the DB.)*
- When `NODE_ENV === 'production'`, startup refuses to boot (`throw Error`) if `SESSION_SECRET` or `TICKET_HMAC_SECRET` is missing, shorter than 16 chars, or equal to placeholders (`change-me`, `fallback_secret`, etc.).

### Serverless Rate Limiting (`src/app.js`, `src/utils/rateLimitStore.js`)
- `app.set('trust proxy', 1)` uses the real client IP from Vercel proxy headers.
- In PostgreSQL deployments (`NODE_ENV !== 'test'`), all 4 limiters use **`PgRateLimitStore`** backed by the `rate_limits` table so hit counters hold across Vercel serverless instances (with an automatic in-memory fallback on transient DB errors; SQLite/test mode uses `MemoryStore`).

| Endpoint | Limiter | Limit | Window |
|---|---|---|---|
| `POST /staff/login` | `staffLoginLimiter` | 10 failed attempts / IP | 15 minutes (`skipSuccessfulRequests: true`, HTTP `401` on invalid credentials) |
| `POST /events/:id/register` | `registrationLimiter` | 20 requests / IP | 15 minutes |
| `GET /ticket`, `POST /lookup` | `lookupLimiter` | 30 requests / IP | 15 minutes |
| `/staff/checkin` & `/staff/checkin/api` | `checkinLimiter` | 60 requests / IP | 1 minute |

---

## 📧 Email Delivery (`src/utils/mailer.js`)

Email dispatch runs asynchronously without blocking registration responses:
1. **`RESEND_API_KEY` set** (not `change-me`) → Sends via Resend HTTP API (`https://api.resend.com/emails`) with PNG QR attachment and ticket link.
2. **`MAILTRAP_USER` + `MAILTRAP_PASS`** (or `MAIL_USER` + `MAIL_PASS`) set → Sends via SMTP (`nodemailer`) with CID inline QR image (`cid:ticketqr`) and ticket link.
3. **Neither configured** → Automatically creates an Ethereal sandbox account for local terminal preview URLs (or logs mock preview offline).  
The registration page adjusts its notice honestly based on `emailConfigured`, promising immediate on-screen QR pass generation rather than claiming guaranteed email delivery when no mail provider is active.

---

## ✅ Verification Results

| Check | Status | Evidence |
|---|---|---|
| Consistent capacity display across list, details, and register pages | **PASS** | `AT-1` in `test/acceptance_test.js` (`npm test`) |
| Full event rejects Confirmed creation; direct POST places on Waitlist | **PASS** | `AT-2` in `test/acceptance_test.js` (`npm test`) |
| Ended events hidden; Ended / Closed / Started / Draft rejected server-side | **PASS** | `AT-3` in `test/acceptance_test.js` (`npm test`), `verify_t2.js` |
| Cebu Dev Meetup 2026 venue, real description, Tech & Developer tag, 30/30 full seed | **PASS** | `npm run seed` / `verify_t3.js` / `AT-4` (`npm test`); live Neon database verified (30 Confirmed registrations) |
| Staff login shows no credentials; auth & Door Staff 403 RBAC enforced | **PASS** | Live `GET /staff/login` + `AT-5` (`npm test`) |
| Full name validation accepts `Ma. Cristina Santos`, `Juan Dela Cruz Jr.`, `Mary-Ann O'Brien`; rejects `John123`, `<script>`, `😀` | **PASS** | `node scripts/test_name_validation.js` (43/43) & `AT-6` (`npm test`) |
| Check-in outcomes (green Checked in, yellow Already with original time, red Invalid / different event / Cancelled, orange Waitlist, event-day rule, live counter) | **PASS** | `verify_t6.js` & `AT-7` (`npm test`) |
| Last-spot registration race (`FOR UPDATE` on Postgres + `BEGIN IMMEDIATE` on SQLite) | **PASS** | `test/race_test.js` (`npm test` against both SQLite & Neon Postgres) |
| Simultaneous check-in race (`WHERE id=$1 AND status='Confirmed'`) | **PASS** | `test/race_test.js` (`npm test` against both SQLite & Neon Postgres) |
| Ticket code strength (`CDM-000001` & altered code rejected; prod startup fails on `change-me` secrets) | **PASS** | `verify_t10.js` & `AT-10` (`npm test`) |
| Rate limiting returns 429 on login, lookup, registration, and check-in | **PASS** | `verify_t9.js` (`PgRateLimitStore` on Neon + all 4 HTTP 429 tests) & `AT-11` (`npm test`) |
| Dashboard metrics (`Cancelled`, `No-Shows`), case-insensitive search, UTF-8 BOM CSV export | **PASS** | `verify_t7.js` & `AT-12` (`npm test`) |
| Registration & promotion emails in Ethereal sandbox (Mailtrap/Resend delivery) | **PASS** (Ethereal) / **PARTIAL** (Mailtrap/Resend) | Ethereal preview URLs verified during `npm test`; `isRealEmailConfigured()` unit-tested (`RESEND_API_KEY`/`MAILTRAP_USER` require live credentials to deliver) |
| Mobile camera QR scan via physical phone on HTTPS | **UNVERIFIED** | Manual physical camera device scan (`html5-qrcode`) not executable in headless CLI test runner |

---

## 🌐 Environment Variables

| Variable | Required | Default / Placeholder | Description |
|---|---|---|---|
| `DATABASE_URL` | Prod | *(unset -> SQLite)* | Neon PostgreSQL connection string (`?sslmode=require`) |
| `DB_PATH` | Local | `./data/eventreg.db` | Local SQLite database path |
| `SESSION_SECRET` | **Yes** | `change-me` | Express session signing secret (prod refuses placeholder / `<16` chars) |
| `TICKET_HMAC_SECRET` | **Yes** | `change-me` | HMAC-SHA256 secret for QR ticket codes (prod refuses placeholder / `<16` chars) |
| `SEED_ORGANIZER_PASSWORD` | Prod seed | `organizer123` | Organizer password used by `seed.js` (must change for prod) |
| `SEED_DOOR_PASSWORD` | Prod seed | `door123` | Door staff password used by `seed.js` (must change for prod) |
| `ALLOW_RESEED` | Safety guard | *(unset)* | Must be `true` to execute `npm run seed:prod` (`--reset`) |
| `RESEND_API_KEY` | Optional | `change-me` | Resend transactional email API key |
| `MAILTRAP_HOST` / `MAILTRAP_PORT` | Optional | `sandbox.smtp.mailtrap.io` / `587` | Mailtrap SMTP server settings |
| `MAILTRAP_USER` / `MAILTRAP_PASS` | Optional | `change-me` | Mailtrap sandbox credentials |
| `MAIL_HOST` / `MAIL_PORT` / `MAIL_USER` / `MAIL_PASS` | Optional | `smtp.ethereal.email` | Generic SMTP settings |
| `MAIL_FROM` | Optional | `"EventReg <no-reply@eventreg.local>"` | Sender header for confirmation emails |
| `APP_URL` | Optional | `http://localhost:3000` | Public base URL embedded in ticket links in emails |

---

## ⚠️ Known Limitations

- **Email Delivery Without Mail Credentials**: When `RESEND_API_KEY`, `MAILTRAP_USER`, or `MAIL_USER` are not set on production host, emails fall back to Ethereal sandbox (preview URLs printed to server logs).
- **Self-Signed HTTPS in Local Camera Testing**: `npm run https` uses a self-signed certificate that mobile browsers require accepting once.
