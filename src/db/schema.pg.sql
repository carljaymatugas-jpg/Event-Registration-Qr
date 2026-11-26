-- Canonical PostgreSQL (Neon) Schema for EventReg
-- Mirrors the SQLite schema in src/db/db.js for production deployment.

CREATE TABLE IF NOT EXISTS events (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  venue       TEXT NOT NULL,
  starts_at   TIMESTAMP NOT NULL,
  ends_at     TIMESTAMP NOT NULL,
  capacity    INTEGER NOT NULL CHECK (capacity >= 1),
  status      TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Published', 'Closed')),
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS staff_users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'door' CHECK (role IN ('organizer', 'door')),
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registrations (
  id            SERIAL PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  full_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  mobile        TEXT NOT NULL,
  ticket_code   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'Confirmed' CHECK (status IN ('Confirmed', 'CheckedIn', 'Waitlisted', 'Cancelled')),
  waitlist_pos  INTEGER,
  registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_in_at TIMESTAMP,
  checked_in_by INTEGER REFERENCES staff_users(id),
  undo_at       TIMESTAMP,
  undo_by       INTEGER REFERENCES staff_users(id)
);

-- Enforce single active registration per email per event (allows re-registering if Cancelled)
CREATE UNIQUE INDEX IF NOT EXISTS uq_event_email_active
  ON registrations(event_id, email)
  WHERE status IN ('Confirmed', 'CheckedIn', 'Waitlisted');

CREATE TABLE IF NOT EXISTS audit_logs (
  id            SERIAL PRIMARY KEY,
  staff_user_id INTEGER REFERENCES staff_users(id),
  action        TEXT NOT NULL,
  target_id     INTEGER,
  detail        TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid"    varchar NOT NULL COLLATE "default",
  "sess"   json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- Shared serverless rate-limit store (used on Vercel / Postgres)
CREATE TABLE IF NOT EXISTS rate_limits (
  key      TEXT PRIMARY KEY,
  hits     INTEGER NOT NULL,
  reset_at TIMESTAMPTZ NOT NULL
);
