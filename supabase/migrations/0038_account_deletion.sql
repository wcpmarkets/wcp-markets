-- Account deletion (Play policy: in-app + web). Accounts are anonymised in place, never
-- hard-deleted: deals, payouts, reviews and disputes reference the user with ON DELETE
-- RESTRICT, which is what keeps the escrow ledger and its history intact. So the
-- profile stays as a nameless row ("Deleted user") and auth.users is soft-deleted by
-- Supabase (phone/email scrubbed, can't sign in). See services/api/src/routes/account.ts.
alter table public.profiles add column if not exists deleted_at timestamptz;
