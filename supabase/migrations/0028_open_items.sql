-- Phase 3 F — the open items after shortlets (all re-runnable).
--
--   1. Guest cancellation of a paid shortlet → a new terminal state, CANCELLED (the
--      guard functions + one-active-deal index come from 0006/0009, regenerated).
--      A cancelled booking frees its dates, like a refunded one.
--   2. Photos on quote requests, deposit claims and disputes: a private
--      `attachments` bucket (uploads land under the uploader's own folder; the API
--      signs every URL) and path columns on the rows they belong to.
--
-- Apply AFTER the regenerated 0006 (deal_states() must know CANCELLED before any
-- deal can enter it) and 0009 (bookings exempt from one-active-deal).

-- ── 1. Cancelled bookings free their dates ─────────────────────────────────────
create or replace function public.bookings_release_dates() returns trigger language plpgsql as $$
begin
  if new.state in ('WITHDRAWN', 'DECLINED', 'EXPIRED', 'REFUNDED', 'CANCELLED') and new.state is distinct from old.state then
    update public.bookings set active = false where deal_id = new.id and active;
  end if;
  return new;
end $$;

-- ── 2. Attachments ─────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

alter table public.quote_requests add column if not exists photo_paths text[] not null default '{}';
alter table public.dispute_cases add column if not exists buyer_photo_paths text[] not null default '{}';
alter table public.dispute_cases add column if not exists seller_photo_paths text[] not null default '{}';

alter table public.quote_requests drop constraint if exists quote_requests_photo_paths_max;
alter table public.quote_requests add constraint quote_requests_photo_paths_max check (cardinality(photo_paths) <= 4);
alter table public.dispute_cases drop constraint if exists dispute_cases_photo_paths_max;
alter table public.dispute_cases add constraint dispute_cases_photo_paths_max
  check (cardinality(buyer_photo_paths) <= 4 and cardinality(seller_photo_paths) <= 4);
