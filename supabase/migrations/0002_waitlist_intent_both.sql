-- Allow 'both' (buyer + seller) as a waitlist intent, in addition to buy/sell.
-- The original inline check in 0001 is auto-named `waitlist_intent_check`.

alter table public.waitlist
  drop constraint if exists waitlist_intent_check;

alter table public.waitlist
  add constraint waitlist_intent_check
  check (intent in ('buy', 'sell', 'both'));
