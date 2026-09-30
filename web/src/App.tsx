import { useEffect, useRef, useState } from 'react';
import { getStatus, send, type Action, type Status } from './api.ts';
import { view } from './view.ts';

const HOLD_SECONDS = 300;
const POLL_MS = 1000;
const CONNECTION_LOST = 'Connection lost. Retrying...';

const errors: Record<string, string> = {
  sold_out: 'Just sold out. Join the waiting line instead.',
  already_holding: 'You already have a pair reserved.',
  limit_reached: "You've already bought the maximum number of pairs.",
  in_stock: 'A pair just became available. Buy it now.',
  no_active_hold: 'Your reservation has ended, so there is nothing to pay for.',
  'userId required': 'Enter your name at the top first.',
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const percent = (part: number, whole: number) => `${Math.min(1, part / whole) * 100}%`;

type Seen = { paid: number; hold: boolean; position: number | null };

export function App() {
  const [user, setUser] = useState(() => new URLSearchParams(location.search).get('user') ?? 'alice');
  const [status, setStatus] = useState<Status | null>(null);
  const [paying, setPaying] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const paidDialog = useRef<HTMLDialogElement>(null);
  const seen = useRef<Seen | null>(null);
  const name = user.trim();

  useEffect(() => {
    seen.current = null;
    setPaying(false);
    setNotice('');
  }, [name]);

  useEffect(() => {
    let cancelled = false;
    let latest = 0;

    async function refresh() {
      const id = ++latest;
      try {
        const s = await getStatus(name);
        if (cancelled || id !== latest) return;

        const prev = seen.current;
        if (prev && s.paid > prev.paid) {
          setNotice('');
          if (!paidDialog.current?.open) paidDialog.current?.showModal();
        } else if (prev?.hold && !s.hold) {
          setNotice('Your reservation expired and the pair was released.');
        } else if (prev?.position && s.hold) {
          setNotice('Good news: a pair freed up and is now reserved for you.');
        } else {
          setNotice((n) => (n === CONNECTION_LOST ? '' : n));
        }

        if (!s.hold) setPaying(false);
        seen.current = { paid: s.paid, hold: !!s.hold, position: s.position };
        setStatus(s);
      } catch {
        if (!cancelled) setNotice(CONNECTION_LOST);
      }
    }

    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [name, refreshKey]);

  async function act(action: Action) {
    setBusy(true);
    try {
      const r = await send(action, name);
      setNotice(r.ok ? '' : (errors[r.error ?? ''] ?? 'Something went wrong. Try again.'));
      if (r.ok && action === 'pay') setPaying(true);
    } catch {
      setNotice('Connection lost. Try again.');
    }
    setBusy(false);
    setRefreshKey((k) => k + 1);
  }

  const v = status && view(status, paying);
  const hold = status?.hold;
  const button = v?.button;

  return (
    <div className="page">
      <header className="topbar">
        <p className={`live${status && !status.available ? ' off' : ''}`}>
          {status && !status.available ? 'Sold out' : 'Live drop'}
        </p>
        <label className="switcher">
          <span>Shopping as</span>
          <input id="user" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
      </header>

      <main className={`product${hold && hold.secondsLeft < 60 ? ' urgent' : ''}`}>
        <div className="media">
          <img src="/sneaker.jpg" alt="A pair of colourful low-top sneakers" />
          <span className="badge">Limited release</span>
        </div>

        <section className="details">
          <div className="body">
            <div className="heading">
              <h1>Sneaker Drop</h1>
              <p id="title" className="subtitle">{v?.title ?? 'Loading...'}</p>
            </div>

            {v?.text && <p id="text" className="desc">{v.text}</p>}

            {hold && (
              <div id="timer" className="timer">
                <p>
                  <span className="clock">{clock(hold.secondsLeft)}</span> left to pay
                </p>
                <div className="bar">
                  <div style={{ width: percent(hold.secondsLeft, HOLD_SECONDS) }} />
                </div>
              </div>
            )}

            <p id="notice" className="notice" role="status">{notice}</p>
          </div>

          <div className="footer">
            <p className="stock">
              <strong>{status?.available ?? '–'}</strong> of {status?.total ?? '–'} left
            </p>
            {button && (
              <button
                id="action"
                className="cta"
                disabled={busy || !button.action}
                onClick={() => button.action && act(button.action)}
              >
                {button.label}
                {button.action && (
                  <span className="arrow" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 17 17 7M8 7h9v9" />
                    </svg>
                  </span>
                )}
              </button>
            )}
          </div>
        </section>
      </main>

      <dialog ref={paidDialog} id="paid">
        <form method="dialog">
          <div className="check" aria-hidden="true">✓</div>
          <strong>Payment successful</strong>
          <p className="muted">Your pair is confirmed.</p>
          <button className="cta">Done</button>
        </form>
      </dialog>
    </div>
  );
}
