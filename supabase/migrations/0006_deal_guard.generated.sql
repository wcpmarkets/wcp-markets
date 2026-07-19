-- GENERATED from src/deals/machine.ts by scripts/gen-deal-guard.ts — DO NOT EDIT.
-- Regenerate with `pnpm gen`; CI fails on drift.

-- All valid deal states (for the CHECK on deals.state / deal_events.to_state).
create or replace function public.deal_states() returns text[] language sql immutable as $$
  select array['OFFERED', 'COUNTERED_BY_SELLER', 'COUNTERED_BY_BUYER', 'ACCEPTED', 'PAYMENT_PENDING', 'PAID_IN_ESCROW', 'HANDED_OFF', 'DISPUTED', 'WITHDRAWN', 'DECLINED', 'EXPIRED', 'COMPLETED', 'REFUNDED']::text[];
$$;

create or replace function public.deal_terminal_states() returns text[] language sql immutable as $$
  select array['WITHDRAWN', 'DECLINED', 'EXPIRED', 'COMPLETED', 'REFUNDED']::text[];
$$;

-- The transition table, materialised as a function. Returns the resulting state for
-- a (from, actor, action), or NULL when the transition is illegal.
create or replace function public.deal_next_state(p_from text, p_actor text, p_action text)
returns text language sql immutable as $$
  select to_state from (values
    ('OFFERED', 'SELLER', 'accept', 'ACCEPTED'),
    ('OFFERED', 'SELLER', 'counter', 'COUNTERED_BY_SELLER'),
    ('OFFERED', 'SELLER', 'decline', 'DECLINED'),
    ('OFFERED', 'BUYER', 'withdraw', 'WITHDRAWN'),
    ('OFFERED', 'SYSTEM', 'expire', 'EXPIRED'),
    ('COUNTERED_BY_SELLER', 'BUYER', 'accept', 'ACCEPTED'),
    ('COUNTERED_BY_SELLER', 'BUYER', 'counter', 'COUNTERED_BY_BUYER'),
    ('COUNTERED_BY_SELLER', 'BUYER', 'withdraw', 'WITHDRAWN'),
    ('COUNTERED_BY_SELLER', 'SYSTEM', 'expire', 'EXPIRED'),
    ('COUNTERED_BY_BUYER', 'SELLER', 'accept', 'ACCEPTED'),
    ('COUNTERED_BY_BUYER', 'SELLER', 'counter', 'COUNTERED_BY_SELLER'),
    ('COUNTERED_BY_BUYER', 'SELLER', 'decline', 'DECLINED'),
    ('COUNTERED_BY_BUYER', 'BUYER', 'withdraw', 'WITHDRAWN'),
    ('COUNTERED_BY_BUYER', 'SYSTEM', 'expire', 'EXPIRED'),
    ('ACCEPTED', 'BUYER', 'withdraw', 'WITHDRAWN'),
    ('ACCEPTED', 'SELLER', 'cancel', 'DECLINED'),
    ('ACCEPTED', 'SYSTEM', 'expire', 'EXPIRED'),
    ('ACCEPTED', 'BUYER', 'pay', 'PAYMENT_PENDING'),
    ('PAYMENT_PENDING', 'SYSTEM', 'payment_confirmed', 'PAID_IN_ESCROW'),
    ('PAYMENT_PENDING', 'SYSTEM', 'payment_failed', 'ACCEPTED'),
    ('PAYMENT_PENDING', 'SYSTEM', 'oversold', 'REFUNDED'),
    ('PAID_IN_ESCROW', 'SELLER', 'hand_off', 'HANDED_OFF'),
    ('PAID_IN_ESCROW', 'SELLER', 'cancel_refund', 'REFUNDED'),
    ('PAID_IN_ESCROW', 'SYSTEM', 'auto_refund', 'REFUNDED'),
    ('HANDED_OFF', 'BUYER', 'confirm_receipt', 'COMPLETED'),
    ('HANDED_OFF', 'SYSTEM', 'auto_release', 'COMPLETED'),
    ('PAID_IN_ESCROW', 'BUYER', 'dispute', 'DISPUTED'),
    ('HANDED_OFF', 'BUYER', 'dispute', 'DISPUTED'),
    ('DISPUTED', 'SYSTEM', 'auto_refund', 'REFUNDED'),
    ('DISPUTED', 'ADMIN', 'resolve_release', 'COMPLETED'),
    ('DISPUTED', 'ADMIN', 'resolve_refund', 'REFUNDED')
  ) as t(from_state, actor, action, to_state)
  where from_state = p_from and actor = p_actor and action = p_action;
$$;
