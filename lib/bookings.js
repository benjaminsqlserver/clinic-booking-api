import crypto from 'node:crypto';
import { withClient, withTransaction } from './db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RATE_LIMIT = 5;          // attempts
const RATE_WINDOW_SECONDS = 60; // per minute, per email

// Advisory-lock namespaces (first int of pg_advisory_xact_lock(int, int)).
const LOCK_IDEMPOTENCY = 1;
const LOCK_EMAIL = 2;

/** Error that maps straight onto an HTTP response: {"error": "<message>"}. */
export class HttpError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

// ---------------------------------------------------------------- formatting

const toSlot = (r) => ({
  id: r.id,
  provider: r.provider,
  start: r.start_raw,
  end: r.end_raw,
  available: !r.booked,
});

export const toBooking = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: new Date(r.created_at).toISOString(),
});

// Canonical JSON (sorted keys) so {"a":1,"b":2} and {"b":2,"a":1} hash the same.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- level 1: reset

export async function resetSlots(body) {
  if (!body || !Array.isArray(body.slots)) throw new HttpError(400, 'slots must be an array');

  const rows = body.slots.map((s, i) => {
    if (!s || typeof s !== 'object') throw new HttpError(400, `slots[${i}] must be an object`);
    for (const f of ['id', 'provider', 'start', 'end']) {
      if (typeof s[f] !== 'string' || s[f].trim() === '') {
        throw new HttpError(400, `slots[${i}].${f} is required`);
      }
    }
    if (Number.isNaN(Date.parse(s.start)) || Number.isNaN(Date.parse(s.end))) {
      throw new HttpError(400, `slots[${i}] start/end must be date-times`);
    }
    return s;
  });
  if (new Set(rows.map((s) => s.id)).size !== rows.length) {
    throw new HttpError(400, 'slot ids must be unique');
  }

  await withTransaction(async (c) => {
    // Reset clears everything: bookings, slots, idempotency records and rate-limit history.
    await c.query('TRUNCATE bookings, slots, idempotency_keys, booking_attempts RESTART IDENTITY');
    if (rows.length) {
      await c.query(
        `INSERT INTO slots (id, provider, start_raw, end_raw, start_at, end_at)
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::timestamptz[])`,
        [
          rows.map((s) => s.id),
          rows.map((s) => s.provider),
          rows.map((s) => s.start),
          rows.map((s) => s.end),
          rows.map((s) => new Date(s.start).toISOString()),
          rows.map((s) => new Date(s.end).toISOString()),
        ],
      );
    }
  });
  return { ok: true, slots: rows.length };
}

// ---------------------------------------------------------------- level 1: list slots

export async function listSlots(provider) {
  return withClient(async (c) => {
    const params = [];
    let where = '';
    if (provider !== undefined) {
      params.push(provider);
      where = 'WHERE s.provider = $1';
    }
    const { rows } = await c.query(
      `SELECT s.*, EXISTS (
         SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
       ) AS booked
       FROM slots s ${where}
       ORDER BY s.start_at ASC, s.id ASC`,
      params,
    );
    return { slots: rows.map(toSlot) };
  });
}

// ---------------------------------------------------------------- levels 1-5: create booking

/**
 * Create a booking. Returns { status, body, headers }.
 *
 * Everything runs in ONE transaction:
 *   1. Idempotency-Key (level 4): lock the key, replay a stored response, or 422 on a different body.
 *   2. Rate limit (level 5): lock the email, count attempts in the last 60 s, 429 on the 6th.
 *   3. Validation (level 2): 400 / 404 / 400-if-started.
 *   4. Insert (level 3): a partial UNIQUE index makes double-booking impossible -> 409.
 *   5. Store the response under the Idempotency-Key.
 */
export async function createBooking(body, idempotencyKey) {
  const requestHash = sha256(canonical(body));

  return withTransaction(async (c) => {
    // ---- 1. Idempotency
    if (idempotencyKey !== undefined) {
      await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_IDEMPOTENCY, idempotencyKey]);
      const { rows } = await c.query(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
        [idempotencyKey],
      );
      if (rows.length) {
        if (rows[0].request_hash !== requestHash) {
          return { status: 422, body: { error: 'Idempotency-Key was already used with a different request body' } };
        }
        return { status: rows[0].status_code, body: rows[0].response, headers: { 'Idempotent-Replayed': 'true' } };
      }
    }

    const result = await attemptBooking(c, body);

    // ---- 5. Remember the outcome (a 429 is not stored, so the client can retry later).
    if (idempotencyKey !== undefined && result.status !== 429) {
      await c.query(
        `INSERT INTO idempotency_keys (key, request_hash, status_code, response) VALUES ($1, $2, $3, $4)`,
        [idempotencyKey, requestHash, result.status, JSON.stringify(result.body)],
      );
    }
    return result;
  });
}

async function attemptBooking(c, body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const slotId = typeof b.slot_id === 'string' ? b.slot_id.trim() : b.slot_id;
  const name = typeof b.name === 'string' ? b.name.trim() : b.name;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : b.email;

  // ---- 2. Rate limit: every attempt with an email counts, failed ones included.
  if (typeof email === 'string' && email !== '') {
    await c.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_EMAIL, email]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n,
              EXTRACT(EPOCH FROM (min(attempted_at) + make_interval(secs => $2::float8) - clock_timestamp())) AS wait
       FROM booking_attempts
       WHERE email = $1 AND attempted_at > clock_timestamp() - make_interval(secs => $2::float8)`,
      [email, RATE_WINDOW_SECONDS],
    );
    if (rows[0].n >= RATE_LIMIT) {
      const retryAfter = Math.max(1, Math.ceil(Number(rows[0].wait)));
      return {
        status: 429,
        body: { error: 'too many booking attempts for this email, try again later' },
        headers: { 'Retry-After': String(retryAfter) },
      };
    }
    await c.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
  }

  // ---- 3. Validation
  if (typeof slotId !== 'string' || slotId === '') return bad('slot_id is required');
  if (typeof name !== 'string' || name === '') return bad('name is required');
  if (typeof email !== 'string' || email === '') return bad('email is required');
  if (!EMAIL_RE.test(email)) return bad('email is not valid');

  const slot = await c.query('SELECT id, start_at <= now() AS started FROM slots WHERE id = $1', [slotId]);
  if (!slot.rows.length) return { status: 404, body: { error: 'slot not found' } };
  if (slot.rows[0].started) return bad('slot has already started');

  // ---- 4. Insert. ON CONFLICT targets the partial unique index, so two concurrent
  // requests for the same slot can never both succeed: the loser gets no row back.
  const id = `bk_${crypto.randomUUID().replace(/-/g, '')}`;
  const ins = await c.query(
    `INSERT INTO bookings (id, slot_id, name, email, status)
     VALUES ($1, $2, $3, $4, 'confirmed')
     ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
     RETURNING *`,
    [id, slotId, name, email],
  );
  if (!ins.rows.length) return { status: 409, body: { error: 'slot already booked' } };
  return { status: 201, body: toBooking(ins.rows[0]) };
}

const bad = (message) => ({ status: 400, body: { error: message } });

// ---------------------------------------------------------------- level 1: get booking

export async function getBooking(id) {
  return withClient(async (c) => {
    const { rows } = await c.query('SELECT * FROM bookings WHERE id = $1', [id]);
    if (!rows.length) throw new HttpError(404, 'booking not found');
    return toBooking(rows[0]);
  });
}

// ---------------------------------------------------------------- level 3: cancel

export async function cancelBooking(id) {
  return withClient(async (c) => {
    // Single atomic UPDATE: only a confirmed booking can flip to cancelled.
    const upd = await c.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [id],
    );
    if (upd.rows.length) return toBooking(upd.rows[0]);
    const { rows } = await c.query('SELECT 1 FROM bookings WHERE id = $1', [id]);
    if (!rows.length) throw new HttpError(404, 'booking not found');
    throw new HttpError(409, 'booking already cancelled');
  });
}

// ---------------------------------------------------------------- level 4: list a person's bookings

const encodeCursor = (seq) => Buffer.from(`seq:${seq}`).toString('base64url');
function decodeCursor(cursor) {
  const m = /^seq:(\d+)$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!m) throw new HttpError(400, 'cursor is not valid');
  return m[1];
}

export async function listBookings(query) {
  const email = typeof query.email === 'string' ? query.email.trim().toLowerCase() : '';
  if (!email) throw new HttpError(400, 'email is required');

  let limit = 10;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit.trim())) {
      throw new HttpError(400, 'limit must be an integer from 1 to 50');
    }
    limit = Number(query.limit.trim());
    if (limit < 1 || limit > 50) throw new HttpError(400, 'limit must be an integer from 1 to 50');
  }

  let afterSeq = '0';
  if (query.cursor !== undefined && query.cursor !== '') {
    if (typeof query.cursor !== 'string') throw new HttpError(400, 'cursor is not valid');
    afterSeq = decodeCursor(query.cursor);
  }

  return withClient(async (c) => {
    // Keyset pagination: fetch one extra row to know whether another page exists.
    const { rows } = await c.query(
      `SELECT * FROM bookings WHERE email = $1 AND seq > $2::bigint ORDER BY seq ASC LIMIT $3`,
      [email, afterSeq, limit + 1],
    );
    const page = rows.slice(0, limit);
    const next = rows.length > limit ? encodeCursor(page[page.length - 1].seq) : null;
    return { bookings: page.map(toBooking), next_cursor: next };
  });
}
