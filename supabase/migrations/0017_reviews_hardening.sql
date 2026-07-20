-- Phase 2 M7 hardening (Fable review). A reputation surface needs stronger integrity
-- than the ledger precedent: a deleted review is silent and the beneficiary (a seller
-- shedding a 1-star) is the motivated party.

-- ── #2 Reviews cannot be deleted (except a deliberate, greppable erasure) ─────
-- GDPR/cleanup sets the GUC in-tx; a stray DELETE from anywhere else fails loudly.
create or replace function public.reviews_no_delete() returns trigger language plpgsql as $$
begin
  if current_setting('wcp.allow_review_erasure', true) is distinct from 'on' then
    raise exception 'reviews cannot be deleted (set wcp.allow_review_erasure = on to erase)';
  end if;
  return old;
end;
$$;
drop trigger if exists reviews_no_delete_trg on public.reviews;
create trigger reviews_no_delete_trg before delete on public.reviews
  for each row execute function public.reviews_no_delete();

-- ── #3 Immutable trigger now also covers id + replied_at ─────────────────────
-- replied_at may change ONLY in the same UPDATE that posts the one-time reply, so a
-- reply can't be back/forward-dated to look like it predates the criticism.
create or replace function public.reviews_immutable() returns trigger language plpgsql as $$
declare first_reply boolean := old.seller_reply is null and new.seller_reply is not null;
begin
  if new.id <> old.id
     or new.rating <> old.rating
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
  if new.replied_at is distinct from old.replied_at and not first_reply then
    raise exception 'replied_at may only be set when posting the reply';
  end if;
  return new;
end;
$$;

-- ── #5 Force created_at at insert; reply must be non-empty ────────────────────
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
  new.created_at := now(); -- not trusted from input
  return new;
end;
$$;

alter table public.reviews drop constraint if exists reviews_seller_reply_check;
alter table public.reviews add constraint reviews_seller_reply_check
  check (seller_reply is null or char_length(seller_reply) between 1 and 2000);
