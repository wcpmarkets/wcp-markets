-- Phase 3 C — the Vehicles lane, and logged viewings.
--
-- Re-runnable: every statement is guarded (if not exists / drop-if-exists /
-- duplicate_object), because migrations are applied ad hoc with no state table.
--
-- Vehicles are LEAD-GEN (design 22b): buyers enquire in chat, inspect in person
-- with their own mechanic, and pay the dealer offline — no offer card, no escrow.
-- The API refuses offers on the lane; the listing's facets (make, model, year,
-- mileage, …) live in `attributes`, as Property's do (0021).
--
-- Viewings (22b-enquiry "Viewing logged", and later 22a-viewing for Property): a
-- time and place agreed in a conversation, recorded so WCP Markets has it on file
-- for safety. Either party proposes; the OTHER confirms; either cancels. A new
-- proposal supersedes the open one, so a thread has at most one live viewing.

-- ── Lane ─────────────────────────────────────────────────────────────────────
alter table public.listings drop constraint if exists listings_lane_check;
alter table public.listings
  add constraint listings_lane_check check (lane in ('goods', 'property', 'vehicles'));

-- Vehicle filters (13e-filters-vehicles) read these facets.
create index if not exists listings_vehicle_make_idx
  on public.listings ((attributes->>'make'), (attributes->>'model'), created_at desc)
  where status = 'active' and lane = 'vehicles';

-- ── Viewings ─────────────────────────────────────────────────────────────────
create table if not exists public.viewings (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations (id) on delete cascade,
  proposed_by     uuid        not null references auth.users (id) on delete cascade,
  starts_at       timestamptz not null,
  -- Optional window end ("Sat 10–4"); a single slot leaves it null.
  ends_at         timestamptz,
  place           text        not null check (char_length(place) between 1 and 200),
  note            text        check (note is null or char_length(note) <= 500),
  status          text        not null default 'proposed'
                    check (status in ('proposed', 'confirmed', 'cancelled', 'superseded')),
  confirmed_at    timestamptz,
  cancelled_by    uuid        references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint viewings_window check (ends_at is null or (ends_at > starts_at and ends_at <= starts_at + interval '12 hours')),
  -- A confirmed viewing records when; one that was never confirmed has no stamp.
  constraint viewings_confirmed check (status <> 'confirmed' or confirmed_at is not null)
);

-- At most one live (proposed or confirmed) viewing per conversation.
create unique index if not exists viewings_one_live_per_conversation
  on public.viewings (conversation_id) where status in ('proposed', 'confirmed');
create index if not exists viewings_conversation_idx
  on public.viewings (conversation_id, created_at desc);

-- RLS — the read path: the two parties to the conversation (Realtime).
alter table public.viewings enable row level security;
drop policy if exists viewings_select_party on public.viewings;
create policy viewings_select_party on public.viewings
  for select using (exists (
    select 1 from public.conversations c
    where c.id = viewings.conversation_id and auth.uid() in (c.buyer_id, c.seller_id)
  ));
-- Clients never write app tables directly (0019).
revoke insert, update, delete on public.viewings from authenticated, anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.viewings; exception when duplicate_object then null; end;
  end if;
end $$;
