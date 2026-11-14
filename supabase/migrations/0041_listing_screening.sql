-- 0041 — Publish-time screening (design 13d-flagged).
--
-- A new or edited listing is checked by deterministic rules (contact details in the
-- text, pay-outside-escrow wording, a price far below comparable listings). A listing
-- that trips one is 'held': saved, owner-visible, never publicly readable, until staff
-- approve it (→ active) or reject it (→ removed). A seller's own edit re-runs the
-- checks and can clear the hold. 'held' joins the moderated statuses, so only
-- moderation code (wcp.moderating = on) moves a listing into or out of it.

alter table public.listings drop constraint if exists listings_status_check;
alter table public.listings add constraint listings_status_check
  check (status in ('draft', 'active', 'sold', 'archived', 'under_review', 'removed', 'held'));

-- What the checks found: [{ "code": "contact_details", "detail": "…" }, …]. Null when
-- clean. Kept after approval as a record of what staff overrode.
alter table public.listings add column if not exists screening jsonb;
alter table public.listings add column if not exists screened_at timestamptz;
-- The staff decision on a hold.
alter table public.listings add column if not exists review_decision text
  check (review_decision is null or review_decision in ('approved', 'rejected'));
alter table public.listings add column if not exists review_note text;
alter table public.listings add column if not exists reviewed_by uuid references auth.users (id) on delete set null;
alter table public.listings add column if not exists reviewed_at timestamptz;

comment on column public.listings.screening is
  'Publish-time screening flags (0041): [{code, detail}] or null when clean.';

create or replace function public.listings_moderation_guard()
returns trigger language plpgsql as $$
declare
  moderated constant text[] := array['under_review', 'removed', 'held'];
begin
  if new.status is distinct from old.status
     and (old.status = any (moderated) or new.status = any (moderated))
     and coalesce(current_setting('wcp.moderating', true), '') <> 'on' then
    raise exception 'listing % is under moderation; status changes go through review', old.id
      using errcode = 'P0001', hint = 'listing_under_moderation';
  end if;
  return new;
end $$;

-- The staff queue reads held listings oldest first.
create index if not exists listings_held_idx
  on public.listings (created_at) where status = 'held';
