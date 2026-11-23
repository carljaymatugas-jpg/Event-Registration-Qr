# Event Registration with QR Check-in

A full-featured event registration and QR check-in web application built for the **Event Registration with QR Check-in — Intern Activity**.

- **Level Reached**: **Level 3 · Advanced (All 6 of 6 items completed for score 90–100)**
- **Demo Event**: Cebu Dev Meetup 2026 · Ayala Center Cebu, Function Room 2 (Seeded Full: 30/30)
- **Time Zone**: Cebu Local Time · `Asia/Manila` (UTC+8)

---

## 🛠 Tech Stack

- **Runtime**: Node.js (v18+ / v20+ / v22+ / v24+)
- **Backend Framework**: Express.js
- **Database**: SQLite with Write-Ahead Logging (WAL mode) and immediate transactions for race safety
- **Templating Engine**: Nunjucks (server-side rendering)
- **Authentication & Security**: `bcryptjs` password hashing, cookie-based SQLite-backed sessions, signed HMAC ticket tokens, `express-rate-limit`
- **QR Code Engine**: `qrcode` (server generation) + `html5-qrcode` (camera scanner with auto-reset & offline fallback)
- **Mailing**: `nodemailer` with automatic Ethereal sandbox test mode (zero-config preview URLs in console)

---

## 🚀 Quick Start (Local Setup)

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
*(Default values in `.env` are preconfigured to work out of the box).*

### 3. Seed Database
Seeds events (including a pre-filled Cebu Dev Meetup with 30 attendees for immediate "Full" and waitlist testing) and demo staff accounts:
```bash
npm run seed
```

### 4. Run the Application
```bash
npm start
```
The app will be accessible at: **`http://localhost:3000`**

### 5. (Optional) Run with HTTPS for Mobile Camera Testing
Mobile browsers require HTTPS for camera permissions (`getUserMedia`). To test camera QR scanning from a phone on your local Wi-Fi:
```bash
npm run https
```
Access via `https://<YOUR_LOCAL_IP>:3443`.

### 6. Run Race Condition & Concurrency Tests
Verify atomic transactions and double-booking prevention:
```bash
npm test
```

---

## 🔑 Demo Staff Logins

| Role | Username | Password | Permissions |
|---|---|---|---|
| **Organizer** | `organizer` | `organizer123` | Full access: Create, edit, close events, promote waitlist, cancel, check-in, undo check-in, export CSV, audit logs |
| **Door Staff** | `doorstaff` | `door123` | Check-in & undo check-in only (blocked from event management and cancellations) |

---

## 📊 Data Model

### `events`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Auto-increment ID |
| `title` | TEXT | Event title |
| `description` | TEXT | Event details and description |
| `venue` | TEXT | Venue location |
| `starts_at` | TEXT | ISO 8601 start time (Asia/Manila) |
| `ends_at` | TEXT | ISO 8601 end time (Asia/Manila) |
| `capacity` | INTEGER | Maximum confirmed attendees (>= 1) |
| `status` | TEXT | `'Draft'`, `'Published'`, `'Closed'` |
| `created_at` | TEXT | Timestamp (Cebu time) |

### `registrations`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Auto-increment ID |
| `event_id` | INTEGER | FK to `events(id)` |
| `full_name` | TEXT | Attendee full name |
| `email` | TEXT | Attendee email |
| `mobile` | TEXT | 11-digit Philippine mobile (`09...`) |
| `ticket_code` | TEXT UNIQUE | Cryptographically signed ticket code |
| `status` | TEXT | `'Confirmed'`, `'CheckedIn'`, `'Waitlisted'`, `'Cancelled'` |
| `waitlist_pos` | INTEGER | Order position on waitlist (if waitlisted) |
| `registered_at` | TEXT | Timestamp |
| `checked_in_at` | TEXT | Timestamp when scanned |
| `checked_in_by` | INTEGER | FK to `staff_users(id)` |
| `undo_at` | TEXT | Timestamp if check-in was undone |
| `undo_by` | INTEGER | FK to `staff_users(id)` |

*Index*: `uq_active_reg` on `(event_id, email)` for active statuses (`Confirmed`, `CheckedIn`, `Waitlisted`).

### `staff_users`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Auto-increment ID |
| `name` | TEXT | Staff display name |
| `username` | TEXT UNIQUE | Login username |
| `password_hash` | TEXT | Bcrypt hash |
| `role` | TEXT | `'organizer'` or `'door'` |

### `audit_logs`
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PRIMARY KEY | Auto-increment ID |
| `staff_user_id` | INTEGER | FK to `staff_users(id)` |
| `action` | TEXT | `'checkin'`, `'undo_checkin'`, `'waitlist_promote'`, `'cancel_registration'`, `'event_create'`, `'event_edit'`, `'event_close'` |
| `target_id` | INTEGER | Entity ID affected |
| `detail` | TEXT | Context info (e.g. ticket code, event title) |
| `created_at` | TEXT | Timestamp |

---

## 🌟 Level 3 Features & Architectural Approach

### 12. Camera QR Scanning
- Integrated `html5-qrcode` directly on the staff check-in screen with front/back camera detection.
- Displays scan result for 2.5 seconds, updates live counters asynchronously via JSON API, and automatically resumes scanning for crowd pacing.
- Full manual keyboard/barcode-gun entry retained as fallback. Includes local bundle fallback when offline.

### 13. Last-Spot Race Condition Handling
- Handled at the database level using SQLite WAL mode with `BEGIN IMMEDIATE` atomic transactions:
  - **Registration race**: Inside the transaction, capacity is re-read; if remaining spots is 0, the registrant is safely moved to the waitlist. Unique partial index prevents duplicate email entries.
  - **Check-in race**: Check-in update verifies `WHERE ticket_code = ? AND status = 'Confirmed'`. If two devices scan simultaneously, exactly one acquires the lock, executes the update, and returns `Checked in`; the other detects the status change and returns `Already checked in`.
  - Verified by automated concurrency test suite (`npm test`).

### 14. Secure QR Content & Anti-Tampering
- Ticket codes format: `<PREFIX>-<RANDOM6>-<HMAC4>` (e.g. `CDM-7K3P9Q-A3F2`).
- The 4-character suffix is an HMAC-SHA256 signature generated with `TICKET_HMAC_SECRET`.
- Sequentially generated codes (e.g. `CDM-000001`) fail cryptographic signature verification before hitting database queries.
- Rate limiting applied on lookup (`/ticket`, `/lookup`) and check-in endpoints.

### 15. Email Confirmation (Sandbox Mode)
- Sends automated confirmation emails with event details and embedded QR codes upon registration.
- Sends instant alert emails when an attendee is promoted from the waitlist.
- Supports Ethereal test sandbox automatically (zero-config, logs click-to-view preview URLs in terminal) or Mailtrap/Resend via `.env`.

### 16. Roles & Audit Log
- **Organizer**: Full event management, promotions, staff actions.
- **Door staff**: Restricted strictly to check-in/undo check-in; server middleware enforces 403 Forbidden on event editing.
- Comprehensive audit trail recording who, what, when, visible on staff dashboard.

### 17. Deployment & HTTPS
- Includes `render.yaml` for 1-click cloud deployment with persistent storage.
- Includes `Dockerfile` for Docker/VPS containerization.
- Includes `scripts/https_server.js` for self-signed HTTPS mobile camera testing on local networks.

---

## ✅ Acceptance Checklist

### Level 1 · Core
- [x] Register for Cebu Dev Meetup 2026 on a phone-sized screen and see a ticket with a QR code.
- [x] Scan the QR with any phone QR app: it shows the same ticket code.
- [x] Refresh the browser, then find the ticket again with ticket code + email (or mobile number).
- [x] A wrong ticket code or wrong email shows "Ticket not found" and no details.
- [x] Register the same email twice for one event: the second attempt is blocked.
- [x] Submit the form with a bad email and a 10-digit mobile number: both show errors.
- [x] Open the seeded full event: it shows "Full" and the Register button is disabled.
- [x] Open a staff page while signed out: you are sent to the sign-in page.
- [x] Check in a valid ticket: green "Checked in" with the name.
- [x] Check in the same ticket again: yellow "Already checked in" with the first time.
- [x] Enter a made-up code, and a real code from a different event: both show "Invalid ticket".
- [x] The attendee list shows correct registered and checked-in totals.

### Level 2 · Intermediate
- [x] Create a Draft event: attendees cannot see it. Publish it: it appears.
- [x] Try to save an event whose end time is before its start time: blocked.
- [x] Try to lower capacity below the number registered: blocked with a message.
- [x] Fill an event, then join the waitlist and see your position.
- [x] Scan a waitlisted ticket: "On waitlist — not confirmed".
- [x] Cancel one confirmed registration: spots left goes up by 1; scanning it shows "Cancelled".
- [x] Promote the first waitlisted person: they now check in successfully.
- [x] Try to cancel a checked-in registration: blocked.
- [x] Undo a check-in: the ticket can be checked in again, and the undo is recorded.
- [x] Dashboard counts match the attendee list. CSV export opens correctly in Excel.

### Level 3 · Advanced (All 6 Completed)
- [x] Scan a ticket from another phone's screen with the camera: correct result, then ready for the next scan.
- [x] Two browsers register for the last spot at the same moment: only one gets it (verified by `npm test`).
- [x] Two devices check in the same ticket at the same moment: only one says "Checked in" (verified by `npm test`).
- [x] Guess a sequential or edited ticket code: never valid (HMAC verification).
- [x] Registration and waitlist-promotion emails arrive in the sandbox inbox with the QR or ticket link.
- [x] Door staff cannot create or edit events; Organizer can.
- [x] Deployment ready with HTTPS instructions for mobile camera scanning.

---

## ⚠️ Known Limitations
- The built-in email preview uses Ethereal Sandbox by default; for real inbox delivery in production, set standard SMTP credentials (e.g. SendGrid, Mailgun, Resend) in `.env`.
- In local development without a public SSL certificate, self-signed HTTPS (`npm run https`) may require accepting browser certificate warnings on mobile devices.
