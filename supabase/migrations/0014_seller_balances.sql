-- Phase 2 M5 — a per-seller balance view (Fable review #5). The ledger books all
-- payouts to a single seller_payable account; this derives "what do we owe each
-- seller" so ops can answer it before the payout milestone builds the real payout
-- writer. Balances are derivable from the ledger, so this is a view (no new state).
create or replace view public.seller_balances as
  select d.seller_id,
         sum(le.amount_kobo)::bigint as payable_kobo,
         count(distinct le.deal_id)  as deals
  from public.ledger_entries le
  join public.deals d on d.id = le.deal_id
  where le.account = 'seller_payable'
  group by d.seller_id
  having sum(le.amount_kobo) <> 0;
