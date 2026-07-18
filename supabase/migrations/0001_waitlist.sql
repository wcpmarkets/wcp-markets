-- Waitlist table for the Phase 1 marketing site.
-- Written to by the /app server action via the service-role key (server-side
-- only). RLS is enabled with NO public policies, so the anon/public key cannot
-- read or write this table — only the service role (which bypasses RLS) can.

create table if not exists public.waitlist (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null,
  intent     text        check (intent in ('buy', 'sell')),
  created_at timestamptz not null default now()
);

-- Case-insensitive uniqueness on email → duplicate sign-ups raise unique_violation
-- (SQLSTATE 23505), which the app treats as an idempotent success (F-2).
create unique index if not exists waitlist_email_lower_key
  on public.waitlist (lower(email));

-- Lock the table down. No policies are created, so PostgREST (anon/authenticated)
-- is denied by default; the server action's service-role key bypasses RLS.
alter table public.waitlist enable row level security;
