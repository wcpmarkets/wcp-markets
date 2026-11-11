-- 0032 — receipt / contact email for phone-first accounts.
--
-- A buyer can give an email at checkout without it blocking payment. It's held here,
-- unconfirmed, and used for Paystack receipts at once; a link emailed to it confirms
-- it, and only then does it become the account's email (auth.users, via the Auth
-- admin API) — which is what sign-in and account recovery trust.
--
-- API-only (service role): RLS on with no policies, so clients can't read anyone's
-- address. The token is stored hashed; the link carries the only plaintext copy.
create table if not exists public.contact_emails (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  email             text not null check (length(email) between 3 and 254 and position('@' in email) > 1),
  token_hash        text check (token_hash is null or length(token_hash) = 64),
  token_expires_at  timestamptz,
  verified_at       timestamptz,
  updated_at        timestamptz not null default now()
);
create unique index if not exists contact_emails_token_hash_idx on public.contact_emails (token_hash) where token_hash is not null;
alter table public.contact_emails enable row level security;
