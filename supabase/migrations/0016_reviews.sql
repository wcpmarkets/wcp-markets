-- Phase 2 M7 — escrow-gated reviews. The product promise is "only buyers who actually
-- paid through escrow can review", so the guard is ENFORCED IN THE DB (a trigger), not
-- just the app: a review can exist only for a COMPLETED deal, authored by that deal's
-- buyer. One review per deal. Sellers may reply once; nobody edits a rating.

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null unique references public.deals (id) on delete restrict,
  reviewer_id  uuid not null references auth.users (id) on delete restrict, -- the buyer
  seller_id    uuid not null references auth.users (id) on delete restrict, -- derived by the trigger
  rating       smallint not null check (rating between 1 and 5),
  body         text check (body is null or char_length(body) <= 2000),
  seller_reply text check (seller_reply is null or char_length(seller_reply) <= 2000),
  created_at   timestamptz not null default now(),
  replied_at   timestamptz
);
create index if not exists reviews_seller_idx on public.reviews (seller_id, created_at desc);

-- ── The escrow gate ──────────────────────────────────────────────────────────
-- A review requires a COMPLETED deal written by that deal's buyer; seller_id is
-- DERIVED from the deal (not trusted from the input) so it can't be spoofed.
create or replace function public.reviews_gate() returns trigger language plpgsql as $$
declare d record;
begin
  select buyer_id, seller_id, state into d from public.deals where id = new.deal_id;
  if d is null then
    raise exception 'review: deal % not found', new.deal_id;
  end if;
  if d.state <> 'COMPLETED' then
    raise exception 'review: deal % is % — only COMPLETED deals can be reviewed', new.deal_id, d.state;
  end if;
  if new.reviewer_id <> d.buyer_id then
    raise exception 'review: only the deal buyer may review';
  end if;
  new.seller_id := d.seller_id;
  return new;
end;
$$;
drop trigger if exists reviews_gate_trg on public.reviews;
create trigger reviews_gate_trg before insert on public.reviews
  for each row execute function public.reviews_gate();

-- ── Immutable (except the seller's one-time reply) ───────────────────────────
-- The rating/body can never be edited; a seller reply can be posted once, never
-- changed. (DELETE is left to the FK-gated cleanup path, as with deal_events; no app
-- route ever deletes a review.)
create or replace function public.reviews_immutable() returns trigger language plpgsql as $$
begin
  if new.rating <> old.rating
     or new.body is distinct from old.body
     or new.reviewer_id <> old.reviewer_id
     or new.seller_id <> old.seller_id
     or new.deal_id <> old.deal_id
     or new.created_at <> old.created_at then
    raise exception 'reviews are immutable (only a first-time seller reply may change)';
  end if;
  if old.seller_reply is not null and new.seller_reply is distinct from old.seller_reply then
    raise exception 'a seller reply cannot be edited once posted';
  end if;
  return new;
end;
$$;
drop trigger if exists reviews_immutable_trg on public.reviews;
create trigger reviews_immutable_trg before update on public.reviews
  for each row execute function public.reviews_immutable();

-- Reviews are public trust signals — readable by anyone; writes go through the
-- service-role API (which enforces buyer/seller identity on top of the gate).
alter table public.reviews enable row level security;
drop policy if exists reviews_public_read on public.reviews;
create policy reviews_public_read on public.reviews for select using (true);
