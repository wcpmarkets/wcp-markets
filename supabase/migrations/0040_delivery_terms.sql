-- 0040 — Delivery terms on goods deals (designs 7h-offer, 7h-feereply, 13b-delivery,
-- 12a–12c, 20g).
--
-- A goods deal says how the item changes hands: the seller delivers (to an area, at a
-- time, for a fee agreed in chat), the two meet (a public spot and a time), or the
-- buyer picks up from the seller's area. The fee is pinned by the seller while the
-- deal is unpaid; Pay stays shut until a "deliver" deal has one.
--
--   deals.delivery = { method: deliver|meet|pickup, state?, place?, when?, feeKobo?,
--                      window? }  (null on services, shortlets and older deals)
--
-- price_kobo keeps its meaning (0008): the whole amount for the items. What escrow
-- holds is the items plus the delivery fee — principal_kobo, derived so the money
-- paths (hold, release, refund, reconcile) read one number and can't disagree.

alter table public.deals add column if not exists delivery jsonb;

alter table public.deals add column if not exists principal_kobo bigint
  generated always as (price_kobo + coalesce((delivery->>'feeKobo')::bigint, 0)) stored;

comment on column public.deals.delivery is
  'Goods hand-off terms: method deliver|meet|pickup, state, place, when, feeKobo (seller-pinned, unpaid only), window (seller-confirmed after payment).';
comment on column public.deals.principal_kobo is
  'What escrow holds before the buyer fee: price_kobo (the items) + the delivery fee.';

-- Structured chat cards: a pinned delivery fee, a buyer asking to be delivered to a
-- state outside the seller's coverage, the seller's answer, and the confirmed
-- hand-off window. body stays a readable fallback for any client that ignores kind.
alter table public.messages add column if not exists kind text;
alter table public.messages add column if not exists meta jsonb;
alter table public.messages drop constraint if exists messages_kind_check;
alter table public.messages add constraint messages_kind_check
  check (kind is null or kind in ('delivery_fee', 'coverage_request', 'coverage_reply', 'handoff_window'));
