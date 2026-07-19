-- Phase 2 M3 — deals (the offer/deal state machine), event log, deadlines, chat.
-- The machine lives in TS (services/api/src/deals/machine.ts) and GENERATES
-- 0006_deal_guard.generated.sql (deal_next_state / deal_states / deal_terminal_states),
-- applied just before this. Here: the tables + a trigger enforcing the guard at the
-- DB layer, so even a buggy app can't write an illegal transition. M3 = negotiation
-- + chat only; money/ledger arrive in M4.

-- ── deals ────────────────────────────────────────────────────────────────────
-- One row per negotiation. `state` is the fold of deal_events (written in the SAME
-- tx as the event). `state_token` is rotated on every transition for optimistic
-- concurrency: UPDATE ... WHERE state_token = ? → 0 rows means another actor won →
-- the command returns a clean 409.
create table if not exists public.deals (
  id           uuid        primary key default gen_random_uuid(),
  listing_id   uuid        not null references public.listings (id) on delete restrict,
  buyer_id     uuid        not null references auth.users (id) on delete cascade,
  seller_id    uuid        not null references auth.users (id) on delete cascade,
  state        text        not null default 'OFFERED',
  state_token  uuid        not null default gen_random_uuid(),
  price_kobo   bigint      not null check (price_kobo >= 0), -- current agreed/proposed terms
  qty          integer     not null default 1 check (qty >= 1),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (buyer_id <> seller_id),
  constraint deals_state_valid check (state = any (public.deal_states()))
);
create index if not exists deals_buyer_idx on public.deals (buyer_id, updated_at desc);
create index if not exists deals_seller_idx on public.deals (seller_id, updated_at desc);
create index if not exists deals_listing_idx on public.deals (listing_id);

drop trigger if exists deals_touch_updated_at on public.deals;
create trigger deals_touch_updated_at
  before update on public.deals
  for each row execute function public.touch_updated_at();

-- ── deal_events (append-only audit log; the source of truth) ──────────────────
create table if not exists public.deal_events (
  id              bigint      generated always as identity primary key,
  deal_id         uuid        not null references public.deals (id) on delete cascade,
  seq             integer     not null,                 -- 1-based per deal
  actor           text        not null check (actor in ('BUYER', 'SELLER', 'ADMIN', 'SYSTEM')),
  actor_id        uuid,                                 -- acting user; null for SYSTEM
  action          text        not null,
  from_state      text,                                 -- null only for genesis
  to_state        text        not null,
  price_kobo      bigint,                               -- terms snapshot (offer/counter)
  qty             integer,
  reason          text,                                 -- expiry cause / refund reason
  idempotency_key text,                                 -- per-command dedupe (null for SYSTEM)
  created_at      timestamptz not null default now(),
  unique (deal_id, seq),
  unique (deal_id, idempotency_key)                     -- NULLs are distinct → SYSTEM events ok
);
create index if not exists deal_events_deal_idx on public.deal_events (deal_id, seq);

-- DB-layer transition guard: every event must be a legal transition per the
-- generated deal_next_state (genesis excepted). This is the backstop under the app.
create or replace function public.deal_events_guard() returns trigger language plpgsql as $$
begin
  if new.from_state is null then
    if new.action <> 'offer' or new.to_state <> 'OFFERED' then
      raise exception 'illegal genesis event: action=% to=%', new.action, new.to_state;
    end if;
  elsif public.deal_next_state(new.from_state, new.actor, new.action) is distinct from new.to_state then
    raise exception 'illegal transition: % [%/%] -> % (guard allows %)',
      new.from_state, new.actor, new.action, new.to_state,
      coalesce(public.deal_next_state(new.from_state, new.actor, new.action), 'NONE');
  end if;
  return new;
end;
$$;

drop trigger if exists deal_events_guard_trg on public.deal_events;
create trigger deal_events_guard_trg
  before insert on public.deal_events
  for each row execute function public.deal_events_guard();

-- ── deal_deadlines (one active timer per deal; fired by the SYSTEM sweeper) ────
create table if not exists public.deal_deadlines (
  deal_id     uuid        primary key references public.deals (id) on delete cascade,
  due_at      timestamptz not null,
  action      text        not null,          -- the SYSTEM action to fire on lapse
  state_token uuid        not null,          -- must still match deals.state_token when firing
  created_at  timestamptz not null default now()
);
create index if not exists deal_deadlines_due_idx on public.deal_deadlines (due_at);

-- ── messages (chat; the offer card is a deal, chat is separate) ───────────────
create table if not exists public.messages (
  id         bigint      generated always as identity primary key,
  deal_id    uuid        not null references public.deals (id) on delete cascade,
  sender_id  uuid        not null references auth.users (id) on delete cascade,
  body       text        not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_deal_idx on public.messages (deal_id, created_at);

-- ── outbox (transactional outbox: side effects written in the command tx) ─────
-- The 60s sweeper relays unrelayed rows to SQS. NEVER enqueue-after-commit.
create table if not exists public.outbox (
  id         bigint      generated always as identity primary key,
  topic      text        not null,
  payload    jsonb       not null,
  created_at timestamptz not null default now(),
  relayed_at timestamptz
);
create index if not exists outbox_unrelayed_idx on public.outbox (created_at) where relayed_at is null;

-- ── RLS — LOAD-BEARING on the read path ──────────────────────────────────────
-- Clients subscribe to deals/deal_events/messages via Realtime, so RLS is the ONLY
-- thing between buyer A and a stranger's private negotiation. Only the two parties
-- may read a deal and its events/messages. All WRITES go through the service-role
-- API (bypasses RLS), so no client insert/update policies exist.
alter table public.deals        enable row level security;
alter table public.deal_events  enable row level security;
alter table public.messages     enable row level security;
alter table public.deal_deadlines enable row level security; -- internal; no policies
alter table public.outbox         enable row level security; -- internal; no policies

drop policy if exists deals_select_party on public.deals;
create policy deals_select_party on public.deals
  for select using (auth.uid() in (buyer_id, seller_id));

drop policy if exists deal_events_select_party on public.deal_events;
create policy deal_events_select_party on public.deal_events
  for select using (exists (
    select 1 from public.deals d
    where d.id = deal_events.deal_id and auth.uid() in (d.buyer_id, d.seller_id)
  ));

drop policy if exists messages_select_party on public.messages;
create policy messages_select_party on public.messages
  for select using (exists (
    select 1 from public.deals d
    where d.id = messages.deal_id and auth.uid() in (d.buyer_id, d.seller_id)
  ));

-- ── Realtime — clients subscribe to their deals/messages (RLS-gated) ──────────
-- Add the tables to Supabase's realtime publication (idempotent per table).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.deals; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.deal_events; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.messages; exception when duplicate_object then null; end;
  end if;
end $$;
