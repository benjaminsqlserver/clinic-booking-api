# Clinic Booking API

An API for booking clinic appointment slots, plus a simple web page that uses it. Built to the spec at
[koyaacademy.com/assessment-api](https://koyaacademy.com/assessment-api) (Koya Cohort 4, Task 1). A copy of the spec is in `scripts/spec-openapi.json`.

- **Base URL:** https://clinic-booking-api-khaki.vercel.app
- **Web page:** https://clinic-booking-api-khaki.vercel.app/
- **Auth:** every request needs the `X-API-Key` header.

## Stack

| Piece | Choice |
|---|---|
| Runtime | Node.js serverless function on Vercel (`api/index.js`) |
| Database | Neon Postgres (Vercel Marketplace), via `@neondatabase/serverless` over WebSockets so it can run real transactions |
| Web page | Plain HTML + JavaScript (`public/index.html`), served by Vercel |

## Endpoints

| Method | Path | Level |
|---|---|---|
| POST | `/reset` | 1: replace all slots, delete all bookings |
| GET | `/slots?provider=` | 1: every slot, earliest first, with `available` |
| POST | `/bookings` | 1 to 5: book a slot |
| GET | `/bookings/{id}` | 1: look up a booking |
| DELETE | `/bookings/{id}` | 3: cancel a booking and free the slot |
| GET | `/bookings?email=&limit=&cursor=` | 4: a person's bookings, cursor-paginated |

Errors are always `{"error": "<message>"}`.

## How each level is met

1. **Basics.** `vercel.json` rewrites the public paths to the one function, which routes on the path.
2. **Auth and validation.** `X-API-Key` is checked in constant time, giving 401 when it is missing or wrong. Fields are trimmed, email is lower-cased, and requests get 400, 404, or 400 when the slot has already started.
3. **No double booking.** A partial unique index, `UNIQUE (slot_id) WHERE status = 'confirmed'`, means Postgres itself rejects a second confirmed booking, even for requests at the same instant. `INSERT ... ON CONFLICT DO NOTHING` turns that into a 409. Cancelling is a single atomic `UPDATE`.
4. **Idempotency and paging.** An `Idempotency-Key` takes a transaction-scoped advisory lock, so concurrent retries queue up. The first stores its status code and response, and later ones replay it. A different body for the same key gets 422. Paging is keyset-based on an insert sequence and returns an opaque `next_cursor`.
5. **Rate limiting.** Each attempt for an email is recorded in `booking_attempts` under a per-email advisory lock. The 6th attempt within a sliding 60 seconds gets 429 with `Retry-After`, in whole seconds, until the oldest attempt expires.

## Run / deploy

```bash
npm install
vercel env pull .env.local            # DATABASE_URL + API_KEY
node --env-file=.env.local scripts/migrate.js
vercel deploy --prod
BASE_URL=https://clinic-booking-api-khaki.vercel.app API_KEY=... node scripts/smoke-test.js
```

`scripts/smoke-test.js` runs 38 live checks across all five levels, including 20 simultaneous bookings of one slot.
