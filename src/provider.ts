import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'dev-secret';

const MAX_DELAY_MS = 2000;
const LATE_RATE = 0.2;
const LATE_MS = 10_000;
const DUPLICATE_RATE = 0.3;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 1000;

export type PaymentEvent = {
  id: string;
  type: 'payment.processing' | 'payment.succeeded';
  paymentId: string;
  holdId: number;
  createdAt: string;
};

export const sign = (body: string) =>
  createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

export function verify(body: string, signature: unknown): boolean {
  if (typeof signature !== 'string') return false;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(body));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const randomDelay = () => (Math.random() < LATE_RATE ? LATE_MS : Math.random() * MAX_DELAY_MS);

async function deliver(event: PaymentEvent, url: string): Promise<void> {
  await sleep(randomDelay());
  const body = JSON.stringify(event);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ok = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sign(body) },
      body,
    }).then((r) => r.ok, () => false);
    if (ok) return;
    await sleep(RETRY_MS * attempt);
  }
}

export function createPayment(paymentId: string, holdId: number, webhookUrl: string): void {
  for (const type of ['payment.processing', 'payment.succeeded'] as const) {
    const event = { id: randomUUID(), type, paymentId, holdId, createdAt: new Date().toISOString() };
    const copies = Math.random() < DUPLICATE_RATE ? 2 : 1;
    for (let i = 0; i < copies; i++) void deliver(event, webhookUrl);
  }
}
