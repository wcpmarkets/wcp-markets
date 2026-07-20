-- Phase 2 M6 — disputes + a DB-backed staff role for CX/support resolution.

-- Staff (CX/support) roles. The DB is the AUTHORIZATION source of truth — identity
-- comes from the Supabase JWT, but what a rep can do is decided here. Gives instant
-- revocation + per-rep attribution and grows into granular RBAC (add a permissions
-- table) without a rewrite. Service-role only (RLS on, no policies).
create table if not exists public.staff_roles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null check (role in ('admin', 'agent')),
  created_at timestamptz not null default now()
);
alter table public.staff_roles enable row level security;

-- One dispute case per deal — a denormalized support view (deal_events is the atomic
-- audit trail). status tracks the sub-flow; resolution + resolved_by record the CX
-- decision (which human, for the audit trail).
create table if not exists public.dispute_cases (
  deal_id         uuid primary key references public.deals (id) on delete restrict,
  opened_by       uuid not null references auth.users (id) on delete restrict,
  reason          text not null,
  buyer_evidence  text,
  seller_response text,
  seller_evidence text,
  status          text not null default 'open' check (status in ('open', 'responded', 'resolved')),
  resolution      text check (resolution in ('release', 'refund')),
  resolved_by     uuid references auth.users (id) on delete restrict,
  resolution_note text,
  created_at      timestamptz not null default now(),
  responded_at    timestamptz,
  resolved_at     timestamptz
);
-- The support queue: open + responded cases, oldest first.
create index if not exists dispute_cases_open_idx
  on public.dispute_cases (created_at) where status <> 'resolved';

-- Load-bearing RLS: only the two parties may read a dispute directly (defense-in-
-- depth; the API reads via the service role, admins through the API). No client writes.
alter table public.dispute_cases enable row level security;
drop policy if exists dispute_cases_select_party on public.dispute_cases;
create policy dispute_cases_select_party on public.dispute_cases
  for select using (exists (
    select 1 from public.deals d
    where d.id = dispute_cases.deal_id and auth.uid() in (d.buyer_id, d.seller_id)
  ));
