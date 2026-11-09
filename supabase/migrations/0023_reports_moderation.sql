-- Phase 3 B — reporting and moderation.
--
-- Re-runnable: every statement is guarded (if not exists / drop-if-exists /
-- duplicate_object), because migrations are applied ad hoc with no state table.
--
-- Two new listing statuses take a listing out of circulation without touching any
-- read path: every public read (browse, search, facets, detail, RLS, offers, chat)
-- already requires status = 'active', so they simply stop matching.
--   under_review — paused by reports, pending a human decision (reversible)
--   removed      — taken down by staff
-- Only the moderation code path may move a listing into or out of these states;
-- it does so inside a transaction with `set local wcp.moderating = 'on'`.

-- ── Listing statuses ─────────────────────────────────────────────────────────
alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check
  check (status in ('draft', 'active', 'sold', 'archived', 'under_review', 'removed'));

create or replace function public.listings_moderation_guard()
returns trigger language plpgsql as $$
declare
  moderated constant text[] := array['under_review', 'removed'];
begin
  if new.status is distinct from old.status
     and (old.status = any (moderated) or new.status = any (moderated))
     and coalesce(current_setting('wcp.moderating', true), '') <> 'on' then
    raise exception 'listing % is under moderation; status changes go through review', old.id
      using errcode = 'P0001', hint = 'listing_under_moderation';
  end if;
  return new;
end $$;

drop trigger if exists listings_moderation_guard on public.listings;
create trigger listings_moderation_guard
  before update of status on public.listings
  for each row execute function public.listings_moderation_guard();

-- ── Reports ──────────────────────────────────────────────────────────────────
-- One row per (reporter, target). The reported user is always resolved server-side
-- (a listing's seller, a message's sender, or the user themselves) so the queue can
-- group by person. Anonymous to the reported party: nothing here is client-readable.
create table if not exists public.reports (
  id               uuid        primary key default gen_random_uuid(),
  reporter_id      uuid        not null references auth.users (id) on delete cascade,
  target_type      text        not null check (target_type in ('listing', 'user', 'message')),
  listing_id       uuid        references public.listings (id) on delete cascade,
  message_id       bigint      references public.messages (id) on delete cascade,
  reported_user_id uuid        not null references auth.users (id) on delete cascade,
  reason           text        not null check (reason in
                     ('scam', 'counterfeit', 'prohibited', 'misleading', 'offensive', 'harassment', 'other')),
  details          text        check (details is null or char_length(details) <= 1000),
  -- True when this report is what paused the listing (for the reviewer's context).
  paused_listing   boolean     not null default false,
  status           text        not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  resolved_by      uuid        references auth.users (id) on delete set null,
  resolution_note  text        check (resolution_note is null or char_length(resolution_note) <= 500),
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  constraint reports_listing_target check ((target_type = 'listing') = (listing_id is not null)),
  constraint reports_message_target check ((target_type = 'message') = (message_id is not null)),
  constraint reports_not_self check (reporter_id <> reported_user_id),
  constraint reports_resolution check ((status = 'open') = (resolved_at is null))
);

-- One OPEN report per reporter per target (re-reporting after a decision is allowed).
create unique index if not exists reports_one_open_per_target
  on public.reports (reporter_id, target_type,
                     coalesce(listing_id::text, message_id::text, reported_user_id::text))
  where status = 'open';
-- The staff queue: open reports, oldest first.
create index if not exists reports_open_queue_idx
  on public.reports (created_at) where status = 'open';
-- Distinct-reporter counts per listing (the auto-pause threshold).
create index if not exists reports_open_listing_idx
  on public.reports (listing_id) where status = 'open' and listing_id is not null;
create index if not exists reports_reported_user_idx
  on public.reports (reported_user_id, created_at desc);

-- Service-role only: RLS on with no policies, and no client writes (as in 0019).
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
