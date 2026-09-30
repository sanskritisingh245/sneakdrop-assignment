CREATE TABLE IF NOT EXISTS products (
  id        int  PRIMARY KEY,
  name      text NOT NULL,
  total     int  NOT NULL,
  available int  NOT NULL CHECK (available >= 0)
);

CREATE TABLE IF NOT EXISTS holds (
  id         serial      PRIMARY KEY,
  product_id int         NOT NULL REFERENCES products(id),
  user_id    text        NOT NULL,
  status     text        NOT NULL DEFAULT 'active',  -- active | expired | paid
  expires_at timestamptz NOT NULL,
  payment_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_hold_per_user
  ON holds (user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS waitlist (
  id        serial      PRIMARY KEY,
  user_id   text        NOT NULL UNIQUE,
  joined_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_events (
  event_id    text        PRIMARY KEY,
  payment_id  text        NOT NULL,
  hold_id     int         NOT NULL,
  type        text        NOT NULL,
  outcome     text,
  received_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO products (id, name, total, available)
VALUES (1, 'Limited Sneaker', 20, 20)
ON CONFLICT (id) DO NOTHING;
