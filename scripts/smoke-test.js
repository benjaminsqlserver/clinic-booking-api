// End-to-end checks for all five levels against a running deployment.
// Usage: BASE_URL=https://... API_KEY=... node scripts/smoke-test.js
const BASE = (process.env.BASE_URL || '').replace(/\/$/, '');
const KEY = process.env.API_KEY;
if (!BASE || !KEY) throw new Error('Set BASE_URL and API_KEY');

let failures = 0;
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && extra ? `  -> ${extra}` : ''}`);
  if (!cond) failures++;
};

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

const future = (h) => new Date(Date.now() + h * 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const slots = [
  { id: 's3', provider: 'Dr Bello', start: future(50), end: future(50.5) },
  { id: 's1', provider: 'Dr Ade', start: future(48), end: future(48.5) },
  { id: 's2', provider: 'Dr Ade', start: future(49), end: future(49.5) },
  { id: 'past', provider: 'Dr Ade', start: future(-2), end: future(-1.5) },
  ...Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, provider: 'Dr Race', start: future(60 + i), end: future(60.5 + i) })),
];

// ---- Level 1
let r = await call('POST', '/reset', { slots });
check('L1 reset 200', r.status === 200, JSON.stringify(r.body));
r = await call('GET', '/slots');
check('L1 slots sorted by start', r.body.slots?.[0]?.id === 'past' && r.body.slots[1].id === 's1', JSON.stringify(r.body).slice(0, 200));
check('L1 slot start echoed exactly', r.body.slots?.find((s) => s.id === 's1')?.start === slots[1].start);
check('L1 available flag', r.body.slots?.every((s) => s.available === true));
r = await call('GET', '/slots?provider=Dr%20Ade');
check('L1 provider filter', r.body.slots?.length === 3 && r.body.slots.every((s) => s.provider === 'Dr Ade'));
r = await call('POST', '/bookings', { slot_id: 's1', name: '  Ada Obi ', email: ' ADA@Example.com ' });
check('L1 book 201', r.status === 201 && r.body.status === 'confirmed', JSON.stringify(r.body));
check('L2 trims + lowercases', r.body.name === 'Ada Obi' && r.body.email === 'ada@example.com');
const b1 = r.body;
r = await call('GET', `/bookings/${b1.id}`);
check('L1 get booking', r.status === 200 && r.body.id === b1.id);
r = await call('GET', '/bookings/nope');
check('L1 unknown booking 404', r.status === 404 && typeof r.body.error === 'string');
r = await call('GET', '/slots');
check('L1 booked slot unavailable', r.body.slots.find((s) => s.id === 's1').available === false);

// ---- Level 2
r = await call('GET', '/slots', undefined, { 'X-API-Key': 'wrong' });
check('L2 wrong key 401', r.status === 401);
r = await fetch(BASE + '/slots');
check('L2 missing key 401', r.status === 401);
for (const [label, body] of [
  ['missing slot_id', { name: 'A', email: 'b@c.de' }],
  ['empty name', { slot_id: 's2', name: '  ', email: 'bb@c.de' }],
  ['bad email', { slot_id: 's2', name: 'A', email: 'not-an-email' }],
  ['missing email', { slot_id: 's2', name: 'A' }],
]) {
  r = await call('POST', '/bookings', body);
  check(`L2 400 ${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
}
r = await call('POST', '/bookings', { slot_id: 'zzz', name: 'A', email: 'z1@x.io' });
check('L2 unknown slot 404', r.status === 404);
r = await call('POST', '/bookings', { slot_id: 'past', name: 'A', email: 'z2@x.io' });
check('L2 started slot 400', r.status === 400);

// ---- Level 3
r = await call('POST', '/bookings', { slot_id: 's1', name: 'B', email: 'other@x.io' });
check('L3 double booking 409', r.status === 409);
const race = await Promise.all(Array.from({ length: 20 }, (_, i) =>
  call('POST', '/bookings', { slot_id: 'c0', name: 'Racer', email: `racer${i}@x.io` })));
const wins = race.filter((x) => x.status === 201).length;
check('L3 20 concurrent requests -> exactly one 201', wins === 1 && race.filter((x) => x.status === 409).length === 19,
  race.map((x) => x.status).join(','));
r = await call('DELETE', `/bookings/${b1.id}`);
check('L3 cancel 200', r.status === 200 && r.body.status === 'cancelled');
r = await call('DELETE', `/bookings/${b1.id}`);
check('L3 cancel twice 409', r.status === 409);
r = await call('DELETE', '/bookings/nope');
check('L3 cancel unknown 404', r.status === 404);
r = await call('POST', '/bookings', { slot_id: 's1', name: 'C', email: 'rebook@x.io' });
check('L3 slot freed after cancel', r.status === 201);

// ---- Level 4
const idem = { slot_id: 's2', name: 'Idem', email: 'idem@x.io' };
const [i1, i2] = await Promise.all([
  call('POST', '/bookings', idem, { 'Idempotency-Key': 'key-1' }),
  call('POST', '/bookings', idem, { 'Idempotency-Key': 'key-1' }),
]);
check('L4 concurrent same key -> same booking', i1.status === 201 && i2.status === 201 && i1.body.id === i2.body.id,
  `${i1.status} ${i2.status}`);
r = await call('POST', '/bookings', idem, { 'Idempotency-Key': 'key-1' });
check('L4 replay same response', r.status === 201 && r.body.id === i1.body.id);
r = await call('POST', '/bookings', { ...idem, name: 'Different' }, { 'Idempotency-Key': 'key-1' });
check('L4 same key different body 422', r.status === 422);
r = await call('GET', '/bookings?email=IDEM@x.io');
check('L4 only one booking created', r.body.bookings?.length === 1, JSON.stringify(r.body));

for (let i = 1; i <= 4; i++) await call('POST', '/bookings', { slot_id: `c${i}`, name: 'Pager', email: 'pager@x.io' });
let all = []; let cursor; let pages = 0;
do {
  r = await call('GET', `/bookings?email=PAGER@x.io&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  all = all.concat(r.body.bookings); cursor = r.body.next_cursor; pages++;
} while (cursor && pages < 10);
check('L4 pagination: 4 bookings over 2 pages, oldest first', all.length === 4 && pages === 2 && all[0].slot_id === 'c1' && all[3].slot_id === 'c4',
  JSON.stringify(all.map((b) => b.slot_id)));
check('L4 last page next_cursor null', r.body.next_cursor === null);
for (const bad of ['0', '51', 'abc', '2.5']) {
  r = await call('GET', `/bookings?email=pager@x.io&limit=${bad}`);
  check(`L4 limit=${bad} -> 400`, r.status === 400);
}

// ---- Level 5
const spam = [];
for (let i = 0; i < 6; i++) spam.push(await call('POST', '/bookings', { slot_id: 'c10', name: 'Spam', email: 'spam@x.io' }));
check('L5 first 5 not rate-limited', spam.slice(0, 5).every((x) => x.status !== 429), spam.map((x) => x.status).join(','));
check('L5 6th attempt 429', spam[5].status === 429);
const ra = spam[5].headers.get('retry-after');
check('L5 Retry-After whole seconds', /^\d+$/.test(ra || '') && Number(ra) >= 1 && Number(ra) <= 60, ra);
r = await call('POST', '/bookings', { slot_id: 'c11', name: 'Other', email: 'not-spam@x.io' });
check('L5 other emails unaffected', r.status === 201);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
