export type Status = {
  total: number;
  available: number;
  hold: { id: number; secondsLeft: number } | null;
  position: number | null;
  paid: number;
  maxPerUser: number;
};

export type Action = 'buy' | 'pay' | 'waitlist';

export async function getStatus(userId: string): Promise<Status> {
  const r = await fetch(`/status?userId=${encodeURIComponent(userId)}`);
  return r.json();
}

export async function send(action: Action, userId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId }),
  });
  const body = await r.json();
  return { ok: r.ok, error: body.error };
}
