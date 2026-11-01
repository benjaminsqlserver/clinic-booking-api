import crypto from 'node:crypto';
import {
  HttpError, resetSlots, listSlots, createBooking, getBooking, cancelBooking, listBookings,
} from '../lib/bookings.js';

/**
 * Single Vercel serverless function that serves the whole API.
 * vercel.json rewrites /slots, /bookings, /bookings/:id and /reset here,
 * passing the original path in the `__path` query parameter.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
  'Access-Control-Expose-Headers': 'Retry-After, Idempotent-Replayed',
};

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries({ ...CORS, ...headers })) res.setHeader(k, v);
  res.end(body === undefined ? '' : JSON.stringify(body));
}

// Level 2: constant-time comparison of the X-API-Key header.
function authorised(req) {
  const expected = process.env.API_KEY;
  const given = req.headers['x-api-key'];
  if (!expected || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readJson(req) {
  // Vercel parses JSON bodies lazily; accessing req.body throws on malformed JSON.
  let body;
  try {
    body = req.body;
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
  if (typeof body === 'string') {
    try {
      body = body === '' ? undefined : JSON.parse(body);
    } catch {
      throw new HttpError(400, 'request body must be valid JSON');
    }
  }
  if (Buffer.isBuffer(body)) {
    try {
      body = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'request body must be valid JSON');
    }
  }
  return body;
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = (url.searchParams.get('__path') || url.pathname).replace(/\/+$/, '') || '/';
  url.searchParams.delete('__path');
  const query = Object.fromEntries(url.searchParams);
  const method = req.method;

  if (method === 'OPTIONS') return send(res, 204);

  try {
    if (!authorised(req)) throw new HttpError(401, 'missing or invalid API key');

    if (path === '/reset') {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed');
      return send(res, 200, await resetSlots(readJson(req)));
    }

    if (path === '/slots') {
      if (method !== 'GET') throw new HttpError(405, 'method not allowed');
      return send(res, 200, await listSlots(query.provider));
    }

    if (path === '/bookings') {
      if (method === 'GET') return send(res, 200, await listBookings(query));
      if (method === 'POST') {
        const key = req.headers['idempotency-key'];
        const r = await createBooking(readJson(req), typeof key === 'string' && key !== '' ? key : undefined);
        return send(res, r.status, r.body, r.headers);
      }
      throw new HttpError(405, 'method not allowed');
    }

    const m = /^\/bookings\/([^/]+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (method === 'GET') return send(res, 200, await getBooking(id));
      if (method === 'DELETE') return send(res, 200, await cancelBooking(id));
      throw new HttpError(405, 'method not allowed');
    }

    throw new HttpError(404, 'not found');
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message }, err.headers);
    console.error(err);
    return send(res, 500, { error: 'internal server error' });
  }
}
