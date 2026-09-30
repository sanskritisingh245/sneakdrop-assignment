// Usage: npm run loadtest -- 1000
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool, init, tx } from '../src/db.ts';
import { sign, type PaymentEvent } from '../src/provider.ts';

const API = process.env.API_URL || 'http://localhost:3000';
const N = Number(process.argv[2] || 1000);
const SAME_USER_CLICKS = 50;
const SWEEP_WAIT_MS = 1500;
const PAYERS = 10;
const PROVIDER_TIMEOUT_MS = 20_000;

const reset = () =>
  tx(async (c) => {
    await c.query('SELECT 1 FROM products WHERE id = 1 FOR UPDATE');
    await c.query('TRUNCATE holds, waitlist, payment_events');
    await c.query('UPDATE products SET available = total');
  });

const post = (path: string, userId: string): Promise<Record<string, unknown>> =>
  fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
    .then((r) => r.json())
    .catch(() => ({ error: 'error' }));

const buyAll = async (userIds: string[]) =>
  (await Promise.all(userIds.map((u) => post('/buy', u)))).map((b) =>
    b.holdId ? 'held' : String(b.error),
  );

const tally = (results: string[]) =>
  results.reduce<Record<string, number>>((t, r) => ({ ...t, [r]: (t[r] ?? 0) + 1 }), {});

const state = async () =>
  (
    await pool.query<{ total: number; available: number; holds: number }>(
      'SELECT total, available, (SELECT count(*)::int FROM holds) AS holds FROM products WHERE id = 1',
    )
  ).rows[0];

const activeUsers = async () =>
  (
    await pool.query<{ user_id: string }>(`SELECT user_id FROM holds WHERE status = 'active'`)
  ).rows.map((r) => r.user_id);

const queue = async () =>
  (await pool.query<{ user_id: string }>('SELECT user_id FROM waitlist ORDER BY id')).rows.map(
    (r) => r.user_id,
  );

const expire = (where: string) =>
  pool.query(`UPDATE holds SET expires_at = now() WHERE status = 'active' AND ${where}`);

const holdOf = async (userId: string) =>
  (
    await pool.query<{ id: number; status: string }>(
      'SELECT id, status FROM holds WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
      [userId],
    )
  ).rows[0];

const event = (id: string, type: PaymentEvent['type'], holdId: number, paymentId = `pay-${holdId}`) => ({
  id,
  type,
  paymentId,
  holdId,
  createdAt: new Date().toISOString(),
});

const hook = (e: PaymentEvent, signature?: string): Promise<string> => {
  const body = JSON.stringify(e);
  return fetch(`${API}/webhooks/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': signature ?? sign(body) },
    body,
  })
    .then((r) => r.json())
    .then((b) => String(b.outcome ?? b.error))
    .catch(() => 'error');
};

const outcomes = async () =>
  tally(
    (
      await pool.query<{ outcome: string }>(
        'SELECT outcome FROM payment_events WHERE hold_id IN (SELECT id FROM holds)',
      )
    ).rows.map((r) => r.outcome),
  );

const waitFor = async (done: () => Promise<boolean>) => {
  const deadline = Date.now() + PROVIDER_TIMEOUT_MS;
  while (!(await done()) && Date.now() < deadline) await sleep(500);
};

type Status = {
  available: number;
  hold: { secondsLeft: number } | null;
  position: number | null;
  paid: number;
};

const status = async (userId: string): Promise<Status> =>
  (await fetch(`${API}/status?userId=${encodeURIComponent(userId)}`)).json();

await init();

console.log(`\n${N} different users click Buy at once`);
await reset();
const t1 = tally(await buyAll(Array.from({ length: N }, (_, i) => `user-${i}`)));
const s1 = await state();
console.log(t1, s1);
assert.deepEqual(t1, { held: s1.total, sold_out: N - s1.total });
assert.equal(s1.available, 0);
assert.equal(s1.holds, s1.total);
console.log('PASS: no oversell');

console.log(`\nOne user clicks Buy ${SAME_USER_CLICKS} times at once`);
await reset();
const t2 = tally(await buyAll(Array(SAME_USER_CLICKS).fill('same-user')));
const s2 = await state();
console.log(t2, s2);
assert.deepEqual(t2, { held: 1, already_holding: SAME_USER_CLICKS - 1 });
assert.equal(s2.available, s2.total - 1);
assert.equal(s2.holds, 1);
console.log('PASS: one hold per user');

console.log('\nExpired holds go to the waiting line first');
await reset();
assert.deepEqual(await post('/waitlist', 'early'), { error: 'in_stock' });
const { total } = await state();
await buyAll(Array.from({ length: total }, (_, i) => `user-${i}`));
const positions = [];
for (const u of ['wait-0', 'wait-1', 'wait-2', 'wait-0']) {
  positions.push((await post('/waitlist', u)).position);
}
assert.deepEqual(positions, [1, 2, 3, 1]);

await expire(`user_id IN ('user-0', 'user-1')`);
await sleep(SWEEP_WAIT_MS);
const active = await activeUsers();
console.log({ active: active.length, queue: await queue(), available: (await state()).available });
assert.ok(active.includes('wait-0') && active.includes('wait-1'));
assert.ok(!active.includes('user-0') && !active.includes('user-1'));
assert.equal(active.length, total);
assert.deepEqual(await queue(), ['wait-2']);
assert.equal((await state()).available, 0);

await expire('true');
await sleep(SWEEP_WAIT_MS);
console.log({ active: await activeUsers(), queue: await queue(), available: (await state()).available });
assert.deepEqual(await activeUsers(), ['wait-2']);
assert.deepEqual(await queue(), []);
assert.equal((await state()).available, total - 1);
console.log('PASS: waitlist handoff');

console.log('\nPayment webhooks: signed, deduplicated, forward-only');
await reset();
await post('/buy', 'alice');
const alice = (await holdOf('alice')).id;
assert.equal(await hook(event('e1', 'payment.succeeded', alice), 'x'.repeat(64)), 'bad_signature');
assert.equal(await hook(event('e1', 'payment.succeeded', alice)), 'paid');
assert.equal(await hook(event('e1', 'payment.succeeded', alice)), 'duplicate');
assert.equal(await hook(event('e0', 'payment.processing', alice)), 'ignored');
assert.equal((await holdOf('alice')).status, 'paid');
assert.equal(await hook(event('e2', 'payment.succeeded', alice, 'second-payment')), 'refund_due');
assert.equal(await hook(event('e3', 'payment.succeeded', 999_999)), 'unknown_hold');

await post('/buy', 'carol');
const carol = (await holdOf('carol')).id;
const t4 = tally(await Promise.all(Array(10).fill(0).map(() => hook(event('e4', 'payment.succeeded', carol)))));
console.log({ sameEventTenTimes: t4 });
assert.deepEqual(t4, { paid: 1, duplicate: 9 });
console.log('PASS: payment webhooks');

console.log('\nLate payments');
await reset();
await post('/buy', 'bob');
await expire(`user_id = 'bob'`);
await sleep(SWEEP_WAIT_MS);
assert.equal(await hook(event('late-1', 'payment.succeeded', (await holdOf('bob')).id)), 'paid_late');
assert.equal((await holdOf('bob')).status, 'paid');
assert.equal((await state()).available, total - 1);

await reset();
await buyAll(Array.from({ length: total }, (_, i) => `user-${i}`));
await post('/waitlist', 'dave');
await expire(`user_id = 'user-0'`);
await sleep(SWEEP_WAIT_MS);
assert.equal(await hook(event('late-2', 'payment.succeeded', (await holdOf('user-0')).id)), 'refund_due');
assert.equal((await holdOf('user-0')).status, 'expired');
assert.equal((await holdOf('dave')).status, 'active');
assert.equal((await state()).available, 0);
console.log('PASS: late payments');

console.log('\nMax 2 pairs: Buy racing a late payment');
await reset();
await post('/buy', 'gina');
assert.equal(await hook(event('g1', 'payment.succeeded', (await holdOf('gina')).id)), 'paid');
await post('/buy', 'gina');
const lateHold = (await holdOf('gina')).id;
await expire(`user_id = 'gina'`);
await sleep(SWEEP_WAIT_MS);

const blocker = await pool.connect();
await blocker.query('BEGIN');
await blocker.query('SELECT 1 FROM products WHERE id = 1 FOR UPDATE');
const late = hook(event('g2', 'payment.succeeded', lateHold));
await sleep(200);
const raceBuy = post('/buy', 'gina');
await sleep(200);
await blocker.query('COMMIT');
blocker.release();
const [lateOutcome, raceBuyResult] = await Promise.all([late, raceBuy]);
const gina = await status('gina');
console.log({ lateOutcome, raceBuyResult, paid: gina.paid, hold: gina.hold });
assert.equal(lateOutcome, 'paid_late');
assert.deepEqual(raceBuyResult, { error: 'limit_reached' });
assert.deepEqual([gina.paid, gina.hold], [2, null]);
console.log('PASS: max 2 pairs');

console.log('\nStatus shows stock, countdown and place in line');
await reset();
await buyAll(Array.from({ length: total }, (_, i) => `user-${i}`));
await post('/waitlist', 'erin');
await post('/waitlist', 'frank');
await pool.query(`UPDATE holds SET expires_at = now() + interval '90 seconds' WHERE user_id = 'user-0'`);
await pool.query(`UPDATE holds SET status = 'paid' WHERE user_id = 'user-1'`);
const holder = await status('user-0');
const buyer = await status('user-1');
const waiter = await status('frank');
console.log({ holder, buyer, waiter });
assert.equal(holder.available, 0);
assert.ok(holder.hold && holder.hold.secondsLeft >= 89 && holder.hold.secondsLeft <= 90);
assert.equal(holder.position, null);
assert.deepEqual([buyer.hold, buyer.paid], [null, 1]);
assert.deepEqual([waiter.hold, waiter.position], [null, 2]);
console.log('PASS: status');

console.log('\nPay: double click and a slow message near expiry');
await reset();
await buyAll(Array.from({ length: total }, (_, i) => `user-${i}`));
await post('/waitlist', 'hank');
await pool.query(`UPDATE holds SET expires_at = now() + interval '1 second' WHERE user_id = 'user-0'`);
const clicks = await Promise.all([post('/pay', 'user-0'), post('/pay', 'user-0')]);
const { rows: [grace] } = await pool.query<{ secs: number }>(
  `SELECT extract(epoch FROM expires_at - now())::int AS secs FROM holds WHERE user_id = 'user-0'`,
);
await sleep(SWEEP_WAIT_MS + 1000);
const afterExpiry = {
  paymentIds: clicks.map((c) => c.paymentId),
  graceSeconds: grace.secs,
  hold: (await holdOf('user-0')).status,
  queue: await queue(),
};
console.log(afterExpiry);
assert.equal(clicks[0].paymentId, clicks[1].paymentId);
assert.ok(afterExpiry.graceSeconds >= 59);
assert.notEqual(afterExpiry.hold, 'expired');
assert.deepEqual(afterExpiry.queue, ['hank']);
await waitFor(async () => (await holdOf('user-0')).status === 'paid');
assert.equal((await holdOf('user-0')).status, 'paid');
assert.equal((await outcomes()).refund_due, undefined);
console.log('PASS: one payment per hold, slow message still pays');

console.log(`\n${PAYERS} users pay (double-clicking) through the messy fake provider`);
await reset();
const payers = Array.from({ length: PAYERS }, (_, i) => `payer-${i}`);
assert.deepEqual(tally(await buyAll(payers)), { held: PAYERS });
const payClicks = await Promise.all(payers.flatMap((u) => [post('/pay', u), post('/pay', u)]));
assert.ok(payClicks.every((p) => typeof p.paymentId === 'string'), JSON.stringify(payClicks));
assert.equal(new Set(payClicks.map((p) => p.paymentId)).size, PAYERS);
await waitFor(async () => Object.values(await outcomes()).reduce((a, b) => a + b, 0) >= PAYERS * 2);
const paidHolds = (await pool.query(`SELECT 1 FROM holds WHERE status = 'paid'`)).rowCount;
console.log({ outcomes: await outcomes(), paidHolds });
assert.deepEqual(await outcomes(), { paid: PAYERS, ignored: PAYERS });
assert.equal(paidHolds, PAYERS);
console.log('PASS: every payer paid exactly once');

await pool.end();
