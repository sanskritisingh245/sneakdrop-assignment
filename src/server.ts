import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { pool, init, tx } from './db.ts';
import { createPayment, verify, type PaymentEvent } from './provider.ts';

const PRODUCT_ID = 1;
const HOLD_MINUTES = 5;
const MAX_PER_USER = 2;
const PAYMENT_GRACE_SECONDS = 60;
const SWEEP_MS = 1000;
const PORT = Number(process.env.PORT) || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || `http://localhost:${PORT}/webhooks/payment`;

type Product = { total: number; available: number };
type Hold = { id: number; expires_at: Date };
type UserHolds = { active: number; paid: number };
type PayingHold = { id: number; payment_id: string };
type Status = Product & {
  hold_id: number | null;
  seconds_left: number | null;
  paid: number;
  position: number | null;
};

const app = express();
// raw body for signature
app.post('/webhooks/payment', express.raw({ type: 'application/json' }), paymentWebhook);
app.use(express.json());

function userIdOf(req: Request, res: Response): string | null {
  const userId: unknown = req.body?.userId;
  if (typeof userId === 'string' && userId) return userId;
  res.status(400).json({ error: 'userId required' });
  return null;
}

async function userError(c: PoolClient, userId: string): Promise<string | null> {
  const { rows: [mine] } = await c.query<UserHolds>(
    `SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
            count(*) FILTER (WHERE status = 'paid')::int AS paid
     FROM holds WHERE user_id = $1`,
    [userId],
  );
  if (mine.active > 0) return 'already_holding';
  if (mine.paid >= MAX_PER_USER) return 'limit_reached';
  return null;
}

app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))));

app.get('/status', async (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : '';
  const { rows: [s] } = await pool.query<Status>(
    `SELECT p.total, p.available, h.id AS hold_id,
            GREATEST(0, ceil(extract(epoch FROM h.expires_at - now())))::int AS seconds_left,
            (SELECT count(*)::int FROM holds WHERE user_id = $2 AND status = 'paid') AS paid,
            (SELECT NULLIF(count(*), 0)::int FROM waitlist
             WHERE id <= (SELECT id FROM waitlist WHERE user_id = $2)) AS position
     FROM products p
     LEFT JOIN holds h ON h.user_id = $2 AND h.status = 'active'
     WHERE p.id = $1`,
    [PRODUCT_ID, userId],
  );
  res.json({
    total: s.total,
    available: s.available,
    hold: s.hold_id ? { id: s.hold_id, secondsLeft: s.seconds_left } : null,
    position: s.position,
    paid: s.paid,
    maxPerUser: MAX_PER_USER,
  });
});

app.post('/buy', async (req, res) => {
  const userId = userIdOf(req, res);
  if (!userId) return;

  const result = await tx(async (c) => {
    await c.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [PRODUCT_ID]);
    const error = await userError(c, userId);
    if (error) return { error };

    const { rowCount } = await c.query(
      'UPDATE products SET available = available - 1 WHERE id = $1 AND available > 0',
      [PRODUCT_ID],
    );
    if (rowCount === 0) return { error: 'sold_out' };

    const { rows: [hold] } = await c.query<Hold>(
      `INSERT INTO holds (product_id, user_id, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3::int))
       RETURNING id, expires_at`,
      [PRODUCT_ID, userId, HOLD_MINUTES],
    );
    return { hold };
  });

  if (!result.hold) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.status(201).json({ holdId: result.hold.id, expiresAt: result.hold.expires_at });
});

app.post('/waitlist', async (req, res) => {
  const userId = userIdOf(req, res);
  if (!userId) return;

  const result = await tx(async (c) => {
    const { rows: [p] } = await c.query<Product>(
      'SELECT total, available FROM products WHERE id = $1 FOR UPDATE',
      [PRODUCT_ID],
    );
    const error = (await userError(c, userId)) ?? (p.available > 0 ? 'in_stock' : null);
    if (error) return { error };

    await c.query(
      'INSERT INTO waitlist (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [userId],
    );
    const { rows: [w] } = await c.query<{ position: number }>(
      `SELECT count(*)::int AS position FROM waitlist
       WHERE id <= (SELECT id FROM waitlist WHERE user_id = $1)`,
      [userId],
    );
    return { position: w.position };
  });

  if (result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json({ position: result.position });
});

app.post('/pay', async (req, res) => {
  const userId = userIdOf(req, res);
  if (!userId) return;

  const { rows: [started] } = await pool.query<PayingHold>(
    `UPDATE holds
     SET payment_id = gen_random_uuid()::text,
         expires_at = GREATEST(expires_at, now() + make_interval(secs => $2::int))
     WHERE user_id = $1 AND status = 'active' AND expires_at > now() AND payment_id IS NULL
     RETURNING id, payment_id`,
    [userId, PAYMENT_GRACE_SECONDS],
  );
  if (started) createPayment(started.payment_id, started.id, WEBHOOK_URL);

  const hold =
    started ??
    (
      await pool.query<PayingHold>(
        `SELECT id, payment_id FROM holds
         WHERE user_id = $1 AND status = 'active' AND expires_at > now()`,
        [userId],
      )
    ).rows[0];
  if (!hold) {
    res.status(409).json({ error: 'no_active_hold' });
    return;
  }
  res.status(202).json({ paymentId: hold.payment_id, holdId: hold.id });
});

async function paymentWebhook(req: Request, res: Response): Promise<void> {
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verify(body, req.get('x-signature'))) {
    res.status(401).json({ error: 'bad_signature' });
    return;
  }
  const event = JSON.parse(body) as PaymentEvent;

  const outcome = await tx(async (c) => {
    await c.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [PRODUCT_ID]);

    const { rowCount } = await c.query(
      `INSERT INTO payment_events (event_id, payment_id, hold_id, type)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [event.id, event.paymentId, event.holdId, event.type],
    );
    if (rowCount === 0) return 'duplicate';

    const outcome = await applyPayment(c, event);
    await c.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [event.id, outcome]);
    return outcome;
  });
  res.json({ outcome });
}

async function applyPayment(c: PoolClient, event: PaymentEvent): Promise<string> {
  if (event.type !== 'payment.succeeded') return 'ignored';

  const { rows: [hold] } = await c.query<{ user_id: string; status: string }>(
    'SELECT user_id, status FROM holds WHERE id = $1',
    [event.holdId],
  );
  if (!hold) return 'unknown_hold';

  if (hold.status === 'active') {
    await c.query(`UPDATE holds SET status = 'paid' WHERE id = $1`, [event.holdId]);
    return 'paid';
  }

  if (hold.status === 'expired' && !(await userError(c, hold.user_id))) {
    const { rowCount } = await c.query(
      'UPDATE products SET available = available - 1 WHERE id = $1 AND available > 0',
      [PRODUCT_ID],
    );
    if (rowCount) {
      await c.query(`UPDATE holds SET status = 'paid' WHERE id = $1`, [event.holdId]);
      return 'paid_late';
    }
  }
  return 'refund_due';
}

async function sweep(): Promise<void> {
  await tx(async (c) => {
    await c.query('SELECT 1 FROM products WHERE id = $1 FOR UPDATE', [PRODUCT_ID]);

    const { rowCount: expired } = await c.query(
      `UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at <= now()`,
    );
    if (!expired) return;

    const { rows: next } = await c.query<{ user_id: string }>(
      `DELETE FROM waitlist
       WHERE id IN (SELECT id FROM waitlist ORDER BY id LIMIT $1)
       RETURNING user_id`,
      [expired],
    );
    await c.query(
      `INSERT INTO holds (product_id, user_id, expires_at)
       SELECT $1::int, unnest($2::text[]), now() + make_interval(mins => $3::int)`,
      [PRODUCT_ID, next.map((w) => w.user_id), HOLD_MINUTES],
    );
    await c.query(
      'UPDATE products SET available = available + $2 WHERE id = $1',
      [PRODUCT_ID, expired - next.length],
    );
  });
}

await init();
setInterval(() => sweep().catch(console.error), SWEEP_MS);
app.listen(PORT, () => console.log(`Sneakdrop listening on http://localhost:${PORT}`));
