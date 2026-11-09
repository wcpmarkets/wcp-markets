-- Phase 3 A — profiles, addresses, blocking, and a conversation-based inbox.
--
-- Re-runnable: every statement is guarded (if not exists / drop-if-exists / on
-- conflict), because migrations are applied ad hoc with no state table.
--
-- Chat moves from "per deal" to "per conversation": one conversation per
-- (listing, buyer), opened before any offer (the listing's Chat button) and
-- carrying every deal that buyer later opens on that listing. `messages.deal_id`
-- stays, stamped with the conversation's open deal at send time, so existing
-- clients that subscribe to `messages` filtered by deal_id keep receiving them.

-- ── Profiles: public identity + preferences ──────────────────────────────────
alter table public.profiles
  add column if not exists store_name         text,
  add column if not exists bio                text,
  add column if not exists avatar_path        text,     -- key in the private `avatars` bucket
  add column if not exists state              text,     -- canonical ng-regions pair, API-validated
  add column if not exists city               text,
  add column if not exists notification_prefs jsonb    not null default
    '{"channels":{"push":true,"whatsapp":false,"email":false,"sms":true},"topics":{"watch":true,"orders":true,"messages":true,"promotions":false}}'::jsonb,
  add column if not exists show_last_seen     boolean  not null default true,
  add column if not exists personalise_search boolean  not null default true,
  add column if not exists last_seen_at       timestamptz;

do $$
begin
  alter table public.profiles add constraint profiles_display_name_len
    check (display_name is null or char_length(display_name) between 1 and 60);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table public.profiles add constraint profiles_store_name_len
    check (store_name is null or char_length(store_name) between 1 and 60);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table public.profiles add constraint profiles_bio_len
    check (bio is null or char_length(bio) <= 160);
exception when duplicate_object then null; end $$;
do $$
begin
  alter table public.profiles add constraint profiles_area_pair
    check ((state is null and city is null) or state is not null);
exception when duplicate_object then null; end $$;

-- Private avatar bucket; the API signs short-lived download URLs, like listing images.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- ── Addresses (delivery + meet-up suggestions) ───────────────────────────────
create table if not exists public.addresses (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  label      text        not null check (char_length(label) between 1 and 30),
  line       text        not null check (char_length(line) between 1 and 200),
  state      text,
  city       text,
  is_default boolean     not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists addresses_user_idx on public.addresses (user_id, created_at);
-- At most one default per user, enforced by the database, not the app.
create unique index if not exists addresses_one_default on public.addresses (user_id) where is_default;

drop trigger if exists addresses_touch_updated_at on public.addresses;
create trigger addresses_touch_updated_at
  before update on public.addresses
  for each row execute function public.touch_updated_at();

alter table public.addresses enable row level security;
drop policy if exists addresses_select_own on public.addresses;
create policy addresses_select_own on public.addresses for select using (auth.uid() = user_id);

-- ── Blocks ───────────────────────────────────────────────────────────────────
create table if not exists public.blocks (
  blocker_id uuid        not null references auth.users (id) on delete cascade,
  blocked_id uuid        not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);
alter table public.blocks enable row level security;
drop policy if exists blocks_select_own on public.blocks;
create policy blocks_select_own on public.blocks for select using (auth.uid() = blocker_id);

-- ── Conversations ────────────────────────────────────────────────────────────
create table if not exists public.conversations (
  id                  uuid        primary key default gen_random_uuid(),
  -- CASCADE, not RESTRICT: the audit record is the deal (whose FKs already RESTRICT
  -- deleting a listing or user with deal history); a chat-only thread goes with them.
  listing_id          uuid        not null references public.listings (id) on delete cascade,
  buyer_id            uuid        not null references auth.users (id) on delete cascade,
  seller_id           uuid        not null references auth.users (id) on delete cascade,
  last_message_at     timestamptz,
  buyer_last_read_at  timestamptz,
  seller_last_read_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (listing_id, buyer_id),
  check (buyer_id <> seller_id)
);
create index if not exists conversations_buyer_idx  on public.conversations (buyer_id, last_message_at desc);
create index if not exists conversations_seller_idx on public.conversations (seller_id, last_message_at desc);

drop trigger if exists conversations_touch_updated_at on public.conversations;
create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function public.touch_updated_at();

-- seller_id is DERIVED from the listing, never trusted from the caller.
create or replace function public.conversations_derive_seller() returns trigger language plpgsql as $$
declare s uuid;
begin
  select seller_id into s from public.listings where id = new.listing_id;
  if s is null then
    raise exception 'conversation: listing % not found', new.listing_id;
  end if;
  new.seller_id := s;
  return new;
end;
$$;
drop trigger if exists conversations_derive_seller_trg on public.conversations;
create trigger conversations_derive_seller_trg
  before insert on public.conversations
  for each row execute function public.conversations_derive_seller();

-- Every deal belongs to a conversation: opening an offer opens (or reuses) one.
create or replace function public.deals_ensure_conversation() returns trigger language plpgsql as $$
begin
  insert into public.conversations (listing_id, buyer_id, seller_id)
  values (new.listing_id, new.buyer_id, new.seller_id)
  on conflict (listing_id, buyer_id) do nothing;
  return new;
end;
$$;
drop trigger if exists deals_ensure_conversation_trg on public.deals;
create trigger deals_ensure_conversation_trg
  after insert on public.deals
  for each row execute function public.deals_ensure_conversation();

-- Backfill: a conversation for every existing (listing, buyer) deal pair.
insert into public.conversations (listing_id, buyer_id, seller_id, created_at)
select listing_id, buyer_id, (array_agg(seller_id))[1], min(created_at)
from public.deals
group by listing_id, buyer_id
on conflict (listing_id, buyer_id) do nothing;

-- ── Messages: hang off the conversation ──────────────────────────────────────
alter table public.messages add column if not exists conversation_id uuid
  references public.conversations (id) on delete cascade;
alter table public.messages alter column deal_id drop not null;

update public.messages m
set conversation_id = c.id
from public.deals d
join public.conversations c on c.listing_id = d.listing_id and c.buyer_id = d.buyer_id
where m.deal_id = d.id and m.conversation_id is null;

alter table public.messages alter column conversation_id set not null;
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

update public.conversations c
set last_message_at = x.last_at
from (select conversation_id, max(created_at) as last_at from public.messages group by conversation_id) x
where x.conversation_id = c.id and c.last_message_at is null;

-- On insert: resolve conversation <-> deal both ways, require the sender to be a
-- party, and bump the conversation's last_message_at.
create or replace function public.messages_link() returns trigger language plpgsql as $$
declare conv record; d record;
begin
  if new.conversation_id is null then
    if new.deal_id is null then
      raise exception 'message: needs a conversation or a deal';
    end if;
    select listing_id, buyer_id into d from public.deals where id = new.deal_id;
    select id into new.conversation_id from public.conversations
      where listing_id = d.listing_id and buyer_id = d.buyer_id;
  end if;

  select * into conv from public.conversations where id = new.conversation_id;
  if conv is null then
    raise exception 'message: conversation % not found', new.conversation_id;
  end if;
  if new.sender_id not in (conv.buyer_id, conv.seller_id) then
    raise exception 'message: sender is not a party to the conversation';
  end if;

  -- Stamp the open deal so per-deal subscribers still see the message.
  if new.deal_id is null then
    select id into new.deal_id from public.deals
      where listing_id = conv.listing_id and buyer_id = conv.buyer_id
        and state <> all (public.deal_terminal_states())
      order by created_at desc limit 1;
  end if;

  update public.conversations set last_message_at = new.created_at where id = conv.id;
  return new;
end;
$$;
drop trigger if exists messages_link_trg on public.messages;
create trigger messages_link_trg
  before insert on public.messages
  for each row execute function public.messages_link();

-- ── RLS — the read path (Realtime) ───────────────────────────────────────────
alter table public.conversations enable row level security;
drop policy if exists conversations_select_party on public.conversations;
create policy conversations_select_party on public.conversations
  for select using (auth.uid() in (buyer_id, seller_id));

drop policy if exists messages_select_party on public.messages;
create policy messages_select_party on public.messages
  for select using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and auth.uid() in (c.buyer_id, c.seller_id)
  ));

-- New tables re-assert 0019's lockdown: clients never write app tables directly.
revoke insert, update, delete on public.addresses, public.blocks, public.conversations
  from authenticated, anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.conversations; exception when duplicate_object then null; end;
  end if;
end $$;
