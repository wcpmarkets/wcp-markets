-- Push notifications (FCM).
--
--   push_devices   one row per app install's FCM token. A token belongs to one user at a
--                  time: signing in as someone else on the same phone moves it. Tied to
--                  the auth session that registered it (see session_id).
--   notifications  one row per notification decided for a user — the delivery log (like
--                  sms_log) and the dedupe guard: the outbox is at-least-once, so the
--                  consumer inserts by dedupe_key first and skips a key it has seen.
--   messages → outbox  a new chat message pokes the consumer (deal events already do,
--                  via deal.created / deal.transition written by the deal commands).
--
-- Internal tables: RLS on, no policies (the API uses the service role).

create table if not exists public.push_devices (
  token        text        primary key check (char_length(token) between 20 and 4096),
  user_id      uuid        not null references auth.users (id) on delete cascade,
  -- The sign-in that registered it: revoking that session (sign out, "sign out other
  -- devices", recovery) removes the device, so a signed-out phone stops getting pushes.
  session_id   uuid        references auth.sessions (id) on delete cascade,
  platform     text        not null check (platform in ('android', 'ios')),
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists push_devices_user_idx on public.push_devices (user_id);
alter table public.push_devices enable row level security;

create table if not exists public.notifications (
  id          bigint      generated always as identity primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  dedupe_key  text        not null unique,
  topic       text        not null check (topic in ('orders', 'messages', 'watch', 'promotions')),
  title       text        not null,
  body        text        not null,
  data        jsonb       not null default '{}'::jsonb,
  -- pending → sent | mocked (no FCM credentials yet) | skipped (user's prefs) |
  --           no_device | failed
  status      text        not null default 'pending'
              check (status in ('pending', 'sent', 'mocked', 'skipped', 'no_device', 'failed')),
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;

create or replace function public.messages_outbox() returns trigger
language plpgsql set search_path = public as $$
begin
  insert into public.outbox (topic, payload, deal_id)
  values ('message.created', jsonb_build_object('messageId', new.id), new.deal_id);
  return new;
end $$;

drop trigger if exists messages_outbox_trg on public.messages;
create trigger messages_outbox_trg
  after insert on public.messages
  for each row execute function public.messages_outbox();
