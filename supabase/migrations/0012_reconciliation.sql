-- Phase 2 M4 hardening — a durable home for webhook/money anomalies (Fable #5).
-- A signature-verified partner webhook that can't be applied (deal not in the
-- expected state, and not an idempotent replay) is a genuine reconciliation event —
-- it must NOT be logged-and-dropped. We ack the partner (200, stop retries) but land
-- the event here for a human/alarm to inspect.
create table if not exists public.reconciliation_exceptions (
  id          bigint      generated always as identity primary key,
  deal_id     uuid,
  kind        text        not null,          -- webhook type / anomaly kind
  detail      text,                          -- transition code, message, etc.
  payload     jsonb,                         -- the raw normalized webhook
  resolved_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists reconciliation_open_idx
  on public.reconciliation_exceptions (created_at) where resolved_at is null;

alter table public.reconciliation_exceptions enable row level security; -- internal only
