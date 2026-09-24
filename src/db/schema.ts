export const SCHEMA_V1 = `
CREATE TABLE sessions (
  user_id BIGINT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  payload JSONB NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'reminder')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  created_at BIGINT NOT NULL,
  lease_token UUID,
  lease_until BIGINT
);

CREATE INDEX outbox_ready_idx
  ON outbox (next_attempt, created_at)
  WHERE status = 'pending';

CREATE INDEX outbox_expired_lease_idx
  ON outbox (lease_until)
  WHERE status = 'sending';

CREATE INDEX outbox_user_kind_status_idx
  ON outbox (user_id, kind, status);
`;

// Anonymous per-day totals (src/bot/funnel.ts): no user id, so /delete has nothing to remove here.
export const SCHEMA_V2 = `
CREATE TABLE funnel (
  day TEXT NOT NULL,
  university TEXT NOT NULL,
  event TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, university, event)
);
`;
