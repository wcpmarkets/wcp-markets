-- 0042 — Each deal event records the hand-off terms as they stood after it, so a
-- counter can be shown as a diff against the offer it replaced (design 7h-counter-diff:
-- "sneaky-fee counters can't slip through"). price_kobo and qty were already there.
-- Null on events before this migration; the app then just doesn't diff the fee.
--
-- A decline's canned reason (20h-decline) rides in the existing reason column.

alter table public.deal_events add column if not exists delivery_method text;
alter table public.deal_events add column if not exists delivery_fee_kobo bigint
  check (delivery_fee_kobo is null or delivery_fee_kobo >= 0);
