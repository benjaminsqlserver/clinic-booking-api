-- Clinic booking API schema (PostgreSQL / Neon)

CREATE TABLE IF NOT EXISTS slots (
  id        TEXT PRIMARY KEY,
  provider  TEXT NOT NULL,
  start_raw TEXT NOT NULL,          -- exactly as sent to /reset, echoed back unchanged
  end_raw   TEXT NOT NULL,
  start_at  TIMESTAMPTZ NOT NULL,   -- parsed, used for ordering and "already started" checks
  end_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS slots_start_idx ON slots (start_at, id);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL PRIMARY KEY,  -- insertion order, used as the pagination cursor
  id         TEXT NOT NULL UNIQUE,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,          -- stored trimmed + lower case
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bookings_email_idx ON bookings (email, seq);

-- Level 3: the database itself guarantees at most ONE confirmed booking per slot,
-- even when many requests arrive at exactly the same moment.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

-- Level 4: stored responses for Idempotency-Key replays.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code  INT  NOT NULL,
  response     JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: one row per booking attempt, for a sliding 60-second window per email.
CREATE TABLE IF NOT EXISTS booking_attempts (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_idx ON booking_attempts (email, attempted_at);
