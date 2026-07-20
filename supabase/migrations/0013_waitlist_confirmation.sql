-- Phase 1 — double opt-in for the waitlist. A new signup is PENDING until the
-- person clicks the confirm link emailed to them; only rows with confirmed_at set
-- are real, deliverable signups. Additive + nullable, so existing rows are
-- unaffected (they simply have a null confirmed_at — treat pre-existing rows as
-- grandfathered/confirmed in any launch export if desired).
alter table public.waitlist
  add column if not exists confirmed_at         timestamptz,
  add column if not exists confirm_token        text,
  add column if not exists confirmation_sent_at timestamptz;

-- A confirm token maps to exactly one row (used to look up a pending signup).
create unique index if not exists waitlist_confirm_token_key
  on public.waitlist (confirm_token) where confirm_token is not null;
