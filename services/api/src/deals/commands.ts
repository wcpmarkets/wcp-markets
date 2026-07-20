import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  type Actor,
  type DealAction,
  type DealState,
  DEADLINES,
  nextState,
} from "./machine.js";
import { EFFECTS } from "./effects.js";

/**
 * The deal command handler — the deterministic transactional core. Every command
 * runs in ONE Postgres tx with:
 *   • idempotency: a (deal_id, idempotency_key) prior event → no-op replay
 *   • SELECT ... FOR UPDATE on the deal row → commands on one deal serialize
 *   • state_token rotation → stale timers (and optional client optimistic checks) 409
 *   • the transition validated by the TS machine AND the DB guard trigger
 *   • deadline sync + a transactional-outbox row, all in the SAME tx (never
 *     enqueue-after-commit)
 * No money-math here (M4 adds it); M3 wires the negotiation actions only.
 */

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql<Record<string, never>>;

export type DealRow = {
  id: string;
  listing_id: string;
  buyer_id: string;
  seller_id: string;
  state: DealState;
  state_token: string;
  price_kobo: string | number;
  qty: number;
  created_at: string | Date;
  updated_at: string | Date;
};

export type CommandResult =
  | { ok: true; deal: DealRow; replay?: boolean }
  | {
      ok: false;
      code: "not_found" | "illegal" | "conflict" | "stale" | "idempotency_reuse";
      from?: DealState;
    };

export type CreateResult =
  | { ok: true; deal: DealRow; existing?: boolean }
  | { ok: false; code: "listing_unavailable" | "own_listing" };

/** Set/refresh the single active deadline for a deal's new state, or clear it. */
async function syncDeadline(sql: Tx, dealId: string, state: DealState, token: string) {
  const d = DEADLINES[state];
  if (!d) {
    await sql`delete from public.deal_deadlines where deal_id = ${dealId}`;
    return;
  }
  await sql`
    insert into public.deal_deadlines (deal_id, due_at, action, state_token)
    values (${dealId}, now() + make_interval(hours => ${d.hours}), ${d.action}, ${token})
    on conflict (deal_id) do update
      set due_at = excluded.due_at, action = excluded.action, state_token = excluded.state_token
  `;
}

/** Genesis: a buyer opens an offer on a listing → a new deal in OFFERED. */
export async function createOffer(
  db: Sql,
  p: { listingId: string; buyerId: string; priceKobo: number; qty: number; idempotencyKey?: string },
): Promise<CreateResult> {
  return db.begin(async (sql) => {
    // Lock the listing so concurrent genesis on the same listing serialise.
    const [listing] = await sql<{ seller_id: string; status: string }[]>`
      select seller_id, status from public.listings where id = ${p.listingId} for update
    `;
    if (!listing || listing.status !== "active") return { ok: false, code: "listing_unavailable" };
    if (listing.seller_id === p.buyerId) return { ok: false, code: "own_listing" };

    // One active negotiation per (listing, buyer): dedupes double-taps + reopens.
    const [existing] = await sql<DealRow[]>`
      select * from public.deals
      where listing_id = ${p.listingId} and buyer_id = ${p.buyerId}
        and state <> all (public.deal_terminal_states())
      limit 1
    `;
    if (existing) return { ok: true, deal: existing, existing: true };

    const [deal] = await sql<DealRow[]>`
      insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty)
      values (${p.listingId}, ${p.buyerId}, ${listing.seller_id}, 'OFFERED', ${p.priceKobo}, ${p.qty})
      returning *
    `;
    await sql`
      insert into public.deal_events
        (deal_id, seq, actor, actor_id, action, from_state, to_state, price_kobo, qty, idempotency_key)
      values (${deal!.id}, 1, 'BUYER', ${p.buyerId}, 'offer', null, 'OFFERED', ${p.priceKobo}, ${p.qty}, ${p.idempotencyKey ?? null})
    `;
    await syncDeadline(sql, deal!.id, "OFFERED", deal!.state_token);
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('deal.created',
        ${sql.json({ dealId: deal!.id, seq: 1, listingId: p.listingId, buyerId: p.buyerId, sellerId: listing.seller_id })},
        ${deal!.id}, 1)
    `;
    return { ok: true, deal: deal! };
  });
}

/** Apply a transition to an existing deal (user action or SYSTEM timer/webhook). */
export async function transition(
  db: Sql,
  p: {
    dealId: string;
    actor: Actor;
    actorId?: string | null;
    action: DealAction;
    priceKobo?: number;
    qty?: number;
    reason?: string;
    idempotencyKey?: string;
    /** SYSTEM timers pass the token they were scheduled with; a mismatch = stale, skip. */
    expectedStateToken?: string;
    /** From a confirming escrow webhook — passed to the effect for the ledger. */
    providerRef?: string;
    confirmedAmountKobo?: number;
  },
): Promise<CommandResult> {
  return db.begin(async (sql) => {
    const [deal] = await sql<DealRow[]>`
      select * from public.deals where id = ${p.dealId} for update
    `;
    if (!deal) return { ok: false, code: "not_found" };

    if (p.idempotencyKey) {
      // Safe under the row lock: request B blocks above until A commits, then sees
      // A's event (READ COMMITTED fresh snapshot). Same key + same action = replay;
      // same key + DIFFERENT action = client bug, refuse rather than silently no-op.
      // Match on requested_action (what the caller asked for) so an EFFECTS redirect
      // — which records a DIFFERENT action (payment_confirmed → oversold) — still
      // replays cleanly; fall back to action for pre-M4 rows without the column.
      const [prior] = await sql<{ requested_action: string | null; action: string }[]>`
        select requested_action, action from public.deal_events
        where deal_id = ${p.dealId} and idempotency_key = ${p.idempotencyKey} limit 1
      `;
      if (prior) {
        if ((prior.requested_action ?? prior.action) !== p.action) return { ok: false, code: "idempotency_reuse" };
        return { ok: true, deal, replay: true };
      }
    }

    if (p.expectedStateToken && p.expectedStateToken !== deal.state_token) {
      return { ok: false, code: "stale" }; // a user action already moved the deal
    }

    const to0 = nextState(deal.state, p.actor, p.action);
    if (!to0) return { ok: false, code: "illegal", from: deal.state };

    // seq is fixed before the effect so ledger/outbox rows can key to this event.
    const seqRows = await sql<{ next_seq: number }[]>`
      select coalesce(max(seq), 0) + 1 as next_seq from public.deal_events where deal_id = ${p.dealId}
    `;
    const next_seq = seqRows[0]!.next_seq;

    // ── EFFECTS seam: run side effects in-tx; an effect may redirect the target ──
    let action = p.action;
    let to = to0;
    const effect = EFFECTS[p.action];
    if (effect) {
      const res = await effect(sql, {
        deal,
        to: to0,
        seq: next_seq,
        providerRef: p.providerRef,
        confirmedAmountKobo: p.confirmedAmountKobo,
      });
      if (res?.redirectAction) {
        action = res.redirectAction;
        const rto = nextState(deal.state, p.actor, action);
        if (!rto) throw new Error(`effect redirect ${p.action}->${action} illegal from ${deal.state}`);
        to = rto;
      }
    }

    const newToken = randomUUID();
    const setPrice = p.priceKobo != null ? sql`, price_kobo = ${p.priceKobo}` : sql``;
    const setQty = p.qty != null ? sql`, qty = ${p.qty}` : sql``;
    const updated = await sql<DealRow[]>`
      update public.deals
      set state = ${to}, state_token = ${newToken} ${setPrice} ${setQty}
      where id = ${p.dealId} and state_token = ${deal.state_token}
      returning *
    `;
    if (updated.length === 0) return { ok: false, code: "conflict" };

    await sql`
      insert into public.deal_events
        (deal_id, seq, actor, actor_id, action, requested_action, from_state, to_state, price_kobo, qty, reason, idempotency_key)
      values (${p.dealId}, ${next_seq}, ${p.actor}, ${p.actorId ?? null}, ${action}, ${p.action},
              ${deal.state}, ${to}, ${p.priceKobo ?? null}, ${p.qty ?? null}, ${p.reason ?? null}, ${p.idempotencyKey ?? null})
    `;
    await syncDeadline(sql, p.dealId, to, newToken);
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('deal.transition',
        ${sql.json({ dealId: p.dealId, seq: next_seq, from: deal.state, to, actor: p.actor, action })},
        ${p.dealId}, ${next_seq})
    `;
    return { ok: true, deal: updated[0]! };
  });
}
