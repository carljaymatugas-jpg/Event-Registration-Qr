# EventReg — 3–5 Minute Demo & QA Walkthrough (`DEMO.md`)

A step-by-step live walkthrough covering every core, intermediate, and advanced QA acceptance check.

- **Live URL**: https://event-registration-qr.vercel.app/
- **Staff Portal**: https://event-registration-qr.vercel.app/staff/login
- **Demo Staff Credentials**:
  | Role | Username | Password | Permissions |
  |---|---|---|---|
  | **Organizer** | `organizer` | `organizer123` | Full access: Events, Attendees, Waitlist Promotion, CSV Export, Check-in |
  | **Door Staff** | `doorstaff` | `door123` | Door QR Scanner & check-in only (restricted from organizer pages) |
- **Mobile Viewport Recommendation**: Chrome DevTools Device Toolbar → iPhone 14 (`390×844`) or Android (`360×800`).

---

## 1. Public Event List & Capacity Consistency (30 sec)

1. Open `/` on mobile viewport (`390×844`).
2. Confirm no demo credentials appear anywhere in public navigation or pages.
3. Observe **Cebu Dev Meetup 2026**:
   - Venue: `Ayala Center Cebu, Function Room 2`
   - Category pill: `TECH & DEVELOPER`
   - Availability badge: `FULL (30/30)` · CTA button: **Join Waitlist →**
4. Click into **Cebu Dev Meetup 2026** (`/events/1`) and click **Join Waitlist →** (`/events/1/register`). Confirm the details and register pages show the exact same `0 of 30 spots left` / `FULL` availability.
5. Note that any ended event (`ends_at <= now` in Asia/Manila) is hidden from `/` and rejects direct `/events/:id/register` submissions server-side.

---

## 2. Registration Validation & Name Rules (45 sec)

1. Open **UX Design Workshop** (`/events/2/register`) or an open upcoming event.
2. Submit an empty form with invalid email `not-email` and 10-digit mobile `0912345678`:
   - Inline errors appear for Full Name, Email, and 11-digit Philippine mobile.
3. Test rejected full names:
   - `John123` → rejected (digits)
   - `<script>` → rejected (HTML/script tag)
   - `😀` → rejected (emoji)
4. Test accepted Filipino / international names:
   - `Ma. Cristina Santos` → accepted
   - `Juan Dela Cruz Jr.` → accepted
   - `Mary-Ann O'Brien` → accepted
5. Complete one registration (`Ma. Cristina Santos`, `cristina.demo@example.com`, `09171234567`).
6. Attempt to register again with the same email OR mobile → blocked with duplicate registration error.

---

## 3. QR Ticket & Secure Lookup (30 sec)

1. After submitting, the browser redirects to `/ticket/<CODE>?email=...`.
2. Verify the displayed ticket shows `CONFIRMED TICKET`, attendee name (`Ma. Cristina Santos` with exact casing preserved), 12-hour `Asia/Manila` schedule, 8-char HMAC ticket code (`UXD-XXXXXX-XXXXXXXX`), and QR PNG.
3. Scan the QR image with any phone QR scanner app → confirms it encodes the exact `ticket_code`.
4. Navigate to **Lookup My Ticket** (`/lookup`):
   - Enter ticket code + `cristina.demo@example.com` (or `09171234567`) → ticket loads.
   - Enter wrong email or wrong code → displays generic `"Ticket not found or contact information does not match."` without leaking which field failed.

---

## 4. Full Event, Waitlist Position & Promotion (45 sec)

1. Open **Cebu Dev Meetup 2026** (seeded full 30/30 Confirmed).
2. Click **Join Waitlist →** and submit (`Waitlist Demo`, `waitlist.demo@example.com`, `09181234567`).
3. Redirects to ticket page showing `WAITLISTED TICKET` and **Waitlist Position `#1`**.
4. In Staff Portal (as `organizer`), go to **Events & Capacity → Attendees** for Cebu Dev Meetup:
   - Click **Cancel** on one existing confirmed attendee → `Confirmed / Capacity` drops to `29 / 30`.
   - Click **Promote** on `#1` Waitlist row → status changes to `Confirmed` (`30 / 30`), waitlist position clears, and promotion notification email triggers.

---

## 5. Door Check-in Outcomes & Live Counter (60 sec)

> **Event-Day Window Rule (`Asia/Manila`):** Door check-in is open only on the scheduled event calendar day(s) (`starts_at` date to `ends_at` date in UTC+8). To demonstrate live door scanning during review, use or create an event scheduled for today's date in `/staff/events/new`.

1. Go to `/staff/login` (confirm zero demo credentials are displayed on the page) and sign in as **`organizer`** (or **`doorstaff`**).
2. Open **Door QR Scanner** (`/staff/checkin`) and select today's event. Note the live **`0 / Y CHECKED IN`** badge.
3. Test all required outcomes via Camera Scan or Manual Entry:
   - **Valid `Confirmed` ticket** → **Green**: `✔ Checked in` + attendee name; counter increments (`1 / Y CHECKED IN`).
   - **Scan the same ticket a second time** → **Yellow**: `⚠ Already checked in` + original 12-hour check-in time.
   - **Invented / sequential / altered code** (`CDM-000001` or flip 1 char of a real ticket) → **Red**: `✖ Invalid ticket — code not recognised.`
   - **Real ticket belonging to another event** → **Red**: `✖ Invalid ticket — belongs to a different event.`
   - **Waitlisted ticket** → **Orange**: `⛔ On waitlist — not confirmed.`
   - **Cancelled ticket** → **Red**: `✖ Cancelled — this registration was cancelled.`
4. Click **Undo Check-in** from Attendee List (organizer) → ticket returns to `Confirmed` and action appears in the Dashboard Activity Audit Log.

---

## 6. Role Separation, Dashboard & CSV Export (30 sec)

1. While logged in as `organizer`:
   - Open **Dashboard** (`/staff/dashboard`): confirm per-event `Capacity`, `Confirmed`, `Checked In`, `Waitlisted`, `Cancelled`, and `No-Shows` (`—` before event start; numeric after start).
   - Open **Attendees** (`/staff/attendees/:id`): confirm `REGISTERED / CAPACITY` and `CHECKED IN / REGISTERED` totals, test case-insensitive search by name or ticket code, and click **⬇ Export CSV**. Open in Excel to confirm UTF-8 BOM preserves characters like `José` / `Ñ` and row counts match.
2. Sign out and sign in as **`doorstaff`**:
   - Navigate directly to `/staff/events` or `/staff/attendees/1/export.csv` → server returns **`403 Forbidden`**.
   - Click browser **Back** after signing out → server `Cache-Control: no-store` prevents cached dashboard access and redirects to `/staff/login`.
