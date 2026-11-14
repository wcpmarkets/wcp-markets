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
import { bookingPlan, type StagePlan } from "./stages.js";
import {
  deliveryChoiceProblem,
  listingDelivery,
  nextDelivery,
  type DealDelivery,
  type DeliveryChoice,
} from "./delivery.js";

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
  /** Service quotes only (0025): what the price is for, and when the job starts. */
  terms: DealTerms | null;
  /** Goods hand-off terms (0040): method, where, when, the pinned fee. */
  delivery?: DealDelivery | null;
  /** price_kobo + the delivery fee — what escrow holds before the buyer fee (0040). */
  principal_kobo?: string | number | null;
  /** The money rail, set at pay (0030): Paystack, or the mock for test accounts. */
  payment_provider?: "mock" | "paystack" | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type DealTerms = {
  service: string;
  scope?: string | null;
  startsAt?: string | null;
  /** A staged quote's plan (stages.ts) — materialised into deal_milestones on funding. */
  milestones?: StagePlan[];
  /** A shortlet booking (22a-shortlet): the dates and how the price was made. */
  booking?: BookingTerms;
};

/** A shortlet booking's dates (YYYY-MM-DD, Lagos) and price build-up, fixed at booking. */
export type BookingTerms = {
  checkIn: string;
  checkOut: string;
  guests: number;
  nights: number;
  nightlyKobo: number;
  cleaningKobo: number;
  cautionKobo: number;
};

/**
 * Shortlet clock times (Africa/Lagos, UTC+1 all year): check-in from 2pm, checkout by
 * 11am. The stay releases to the host at the checkout time.
 */
export const checkInAt = (date: string): Date => new Date(`${date}T13:00:00Z`);
export const checkOutAt = (date: string): Date => new Date(`${date}T10:00:00Z`);

export type CommandResult =
  | { ok: true; deal: DealRow; replay?: boolean }
  | {
      ok: false;
      code: "not_found" | "illegal" | "conflict" | "stale" | "idempotency_reuse";
      from?: DealState;
    };

export type CreateResult =
  | { ok: true; deal: DealRow; existing?: boolean }
  | { ok: false; code: "listing_unavailable" | "own_listing" | "lead_gen_lane" | "quote_first" | "book_first" }
  /** The delivery choice doesn't fit the listing (detail: deliveryChoiceProblem's code). */
  | { ok: false; code: "delivery"; detail: string };

export type BookingResult =
  | { ok: true; deal: DealRow; conversationId: string }
  | {
      ok: false;
      code: "listing_unavailable" | "not_shortlet" | "own_listing" | "deal_active" | "dates_unavailable" |
        "min_nights" | "too_many_guests";
      minNights?: number;
    };

export type QuoteResult =
  | { ok: true; deal: DealRow }
  | { ok: false; code: "request_not_found" | "request_closed" | "deal_active" | "listing_unavailable" };

/**
 * Service deals keep the machine's states but not all of its clocks: a quote is
 * weighed (and a job scheduled) on a human timescale, so negotiation gets two days
 * rather than four hours, and escrow's "hand off within 72h" counts from the job's
 * start date — a job booked for next Saturday must not auto-refund on Wednesday.
 */
const SERVICE_NEGOTIATION_HOURS = 48;
const NEGOTIATION: readonly DealState[] = ["OFFERED", "COUNTERED_BY_SELLER", "COUNTERED_BY_BUYER", "ACCEPTED"];

/** Set/refresh the single active deadline for a deal's new state, or clear it. */
async function syncDeadline(
  sql: Tx,
  dealId: string,
  state: DealState,
  token: string,
  terms: DealTerms | null = null,
) {
  const d = DEADLINES[state];
  if (!d) {
    await sql`delete from public.deal_deadlines where deal_id = ${dealId}`;
    return;
  }
  let hours = d.hours;
  // A shortlet runs on the calendar, not on hand-off clocks: escrow holds the stay
  // until checkout, then the deposit for 48h (none held → complete straight away).
  // Its negotiation is just "pay within 4h", the default — the dates are held meanwhile.
  const booking = terms?.booking;
  if (booking && (state === "PAID_IN_ESCROW" || state === "HANDED_OFF")) {
    let due = checkOutAt(booking.checkOut);
    const action: DealAction = state === "PAID_IN_ESCROW" ? "check_out" : d.action;
    if (state === "HANDED_OFF") {
      const [held] = await sql`select 1 from public.deal_milestones where deal_id = ${dealId} and status = 'held' limit 1`;
      due = new Date(Date.now() + (held ? hours : 0) * 3_600_000);
    }
    await sql`
      insert into public.deal_deadlines (deal_id, due_at, action, state_token)
      values (${dealId}, ${due}, ${action}, ${token})
      on conflict (deal_id) do update
        set due_at = excluded.due_at, action = excluded.action, state_token = excluded.state_token
    `;
    return;
  }
  // Escrow hand-off clock for a scheduled job: d.hours after the later of now and the start.
  let from = sql`now()`;
  if (terms && !booking) {
    if (NEGOTIATION.includes(state)) hours = SERVICE_NEGOTIATION_HOURS;
    if (state === "PAID_IN_ESCROW" && terms.startsAt) {
      from = sql`greatest(now(), ${new Date(terms.startsAt)}::timestamptz)`;
    }
    // A staged job back in escrow after a stage released is work in progress, not a
    // no-show: the "hand off within 72h or refund" clock only guards the first stage.
    // Later stalls are the buyer's to raise (dispute), never an automatic refund of a
    // job that's half done.
    if (state === "PAID_IN_ESCROW" && terms.milestones?.length) {
      const [moved] = await sql`
        select 1 from public.deal_milestones where deal_id = ${dealId} and status <> 'held' limit 1
      `;
      if (moved) {
        await sql`delete from public.deal_deadlines where deal_id = ${dealId}`;
        return;
      }
    }
  }
  await sql`
    insert into public.deal_deadlines (deal_id, due_at, action, state_token)
    values (${dealId}, ${from} + make_interval(hours => ${hours}), ${d.action}, ${token})
    on conflict (deal_id) do update
      set due_at = excluded.due_at, action = excluded.action, state_token = excluded.state_token
  `;
}

/** Genesis: a buyer opens an offer on a listing → a new deal in OFFERED. */
export async function createOffer(
  db: Sql,
  p: {
    listingId: string;
    buyerId: string;
    priceKobo: number;
    qty: number;
    /** Goods: how the buyer wants it (7h-offer). Checked against what the listing offers. */
    delivery?: DeliveryChoice;
    idempotencyKey?: string;
  },
): Promise<CreateResult> {
  return db.begin(async (sql) => {
    // Lock the listing so concurrent genesis on the same listing serialise.
    const [listing] = await sql<
      { seller_id: string; status: string; lane: string; deal_type: string | null; attributes: Record<string, unknown> | null; state: string | null }[]
    >`
      select seller_id, status, lane, attributes->>'dealType' as deal_type, attributes, state
      from public.listings where id = ${p.listingId} for update
    `;
    if (!listing || listing.status !== "active") return { ok: false, code: "listing_unavailable" };
    // Vehicles are lead-gen (22b): enquire, inspect, pay the dealer offline — no escrow.
    if (listing.lane === "vehicles") return { ok: false, code: "lead_gen_lane" };
    // Services flip the rule (22c-quotecard): the provider names the first price.
    if (listing.lane === "services") return { ok: false, code: "quote_first" };
    // A shortlet's price is per night and taken by booking dates (22a-shortlet).
    if (listing.deal_type === "shortlet") return { ok: false, code: "book_first" };
    if (listing.seller_id === p.buyerId) return { ok: false, code: "own_listing" };

    // One active negotiation per (listing, buyer): dedupes double-taps + reopens.
    const [existing] = await sql<DealRow[]>`
      select * from public.deals
      where listing_id = ${p.listingId} and buyer_id = ${p.buyerId}
        and state <> all (public.deal_terminal_states())
      limit 1
    `;
    if (existing) return { ok: true, deal: existing, existing: true };

    // Delivery is a goods term (rentals and sales of property are viewed, not shipped).
    let delivery: DealDelivery | null = null;
    if (p.delivery && listing.lane === "goods") {
      const bad = deliveryChoiceProblem(p.delivery, listingDelivery(listing.attributes as never, listing.state));
      if (bad) return { ok: false, code: "delivery", detail: bad };
      delivery = nextDelivery(null, p.delivery);
    }

    const [deal] = await sql<DealRow[]>`
      insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty, delivery)
      values (${p.listingId}, ${p.buyerId}, ${listing.seller_id}, 'OFFERED', ${p.priceKobo}, ${p.qty},
              ${delivery ? sql.json(delivery) : null})
      returning *
    `;
    await sql`
      insert into public.deal_events
        (deal_id, seq, actor, actor_id, action, from_state, to_state, price_kobo, qty, idempotency_key,
         delivery_method, delivery_fee_kobo)
      values (${deal!.id}, 1, 'BUYER', ${p.buyerId}, 'offer', null, 'OFFERED', ${p.priceKobo}, ${p.qty}, ${p.idempotencyKey ?? null},
              ${delivery?.method ?? null}, ${delivery?.feeKobo ?? null})
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

/**
 * Genesis for Services: the provider answers an open quote request with a price →
 * a new deal in COUNTERED_BY_SELLER (awaiting the buyer: accept, counter, or let it
 * lapse). The request records which deal answered it.
 */
export async function createQuote(
  db: Sql,
  p: {
    requestId: string;
    sellerId: string;
    priceKobo: number;
    terms: DealTerms;
    idempotencyKey?: string;
  },
): Promise<QuoteResult> {
  return db.begin(async (sql) => {
    const [req] = await sql<{ listing_id: string; buyer_id: string; status: string; deal_id: string | null }[]>`
      select listing_id, buyer_id, status, deal_id from public.quote_requests
      where id = ${p.requestId} and seller_id = ${p.sellerId}
      for update
    `;
    if (!req) return { ok: false, code: "request_not_found" };
    if (req.status !== "open") return { ok: false, code: "request_closed" };
    // Only a fresh brief, or one whose last quote lapsed or was turned down, takes a
    // quote: a request whose job was paid for is history — a repeat job is a new request.
    if (req.deal_id) {
      const [prior] = await sql<{ state: string }[]>`select state from public.deals where id = ${req.deal_id}`;
      if (prior && !["DECLINED", "WITHDRAWN", "EXPIRED"].includes(prior.state)) {
        return { ok: false, code: prior.state === "COMPLETED" || prior.state === "REFUNDED" ? "request_closed" : "deal_active" };
      }
    }

    const [listing] = await sql<{ status: string }[]>`
      select status from public.listings where id = ${req.listing_id} for update
    `;
    if (!listing || listing.status !== "active") return { ok: false, code: "listing_unavailable" };

    // A live quote is revised with "counter", not a second genesis (and the
    // one-active-deal index would refuse it anyway).
    const [active] = await sql<DealRow[]>`
      select * from public.deals
      where listing_id = ${req.listing_id} and buyer_id = ${req.buyer_id}
        and state <> all (public.deal_terminal_states())
      limit 1
    `;
    if (active) return { ok: false, code: "deal_active" };

    const [deal] = await sql<DealRow[]>`
      insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty, terms)
      values (${req.listing_id}, ${req.buyer_id}, ${p.sellerId}, 'COUNTERED_BY_SELLER', ${p.priceKobo}, 1,
              ${sql.json(p.terms)})
      returning *
    `;
    await sql`
      insert into public.deal_events
        (deal_id, seq, actor, actor_id, action, from_state, to_state, price_kobo, qty, idempotency_key)
      values (${deal!.id}, 1, 'SELLER', ${p.sellerId}, 'quote', null, 'COUNTERED_BY_SELLER', ${p.priceKobo}, 1,
              ${p.idempotencyKey ?? null})
    `;
    await sql`update public.quote_requests set deal_id = ${deal!.id} where id = ${p.requestId}`;
    await sql`update public.conversations set last_message_at = now()
      where listing_id = ${req.listing_id} and buyer_id = ${req.buyer_id}`;
    await syncDeadline(sql, deal!.id, "COUNTERED_BY_SELLER", deal!.state_token, p.terms);
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('deal.created',
        ${sql.json({ dealId: deal!.id, seq: 1, listingId: req.listing_id, buyerId: req.buyer_id, sellerId: p.sellerId, quote: true })},
        ${deal!.id}, 1)
    `;
    return { ok: true, deal: deal! };
  });
}

/**
 * The machine's generic actions that make no sense for a stay. A shortlet is never
 * "handed off" or "received" (checkout is the calendar's), and once checked out the
 * stay is paid — what's left in escrow is the deposit, which the host claims, not the
 * guest. The shortlet-only actions are refused on everything else.
 */
function bookingRefuses(deal: DealRow, action: DealAction): boolean {
  if (deal.terms?.booking) {
    if (action === "hand_off" || action === "confirm_receipt") return true;
    if (action === "dispute" && deal.state === "HANDED_OFF") return true;
    // Cancelling is for before the stay; once check-in time passes, a problem with
    // the place is a dispute (frozen funds, an admin decides), not a cancellation.
    if (action === "cancel_booking" && Date.now() >= checkInAt(deal.terms.booking.checkIn).getTime()) return true;
    return false;
  }
  return action === "check_out" || action === "claim_deposit" || action === "return_deposit" || action === "cancel_booking";
}

const DAY_MS = 86_400_000;
/** Unpaid booking holds one guest may have at one listing (each lapses after 4h). */
const MAX_UNPAID_HOLDS = 2;
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

/**
 * Genesis for shortlets (22a-shortlet): a guest books dates → a new deal in ACCEPTED
 * (instant book: no host approval), awaiting payment. The price is built here from
 * the listing — never from the client — and the dates are taken in the same tx; the
 * bookings exclusion constraint is the backstop if two guests race.
 */
export async function createBooking(
  db: Sql,
  p: { listingId: string; buyerId: string; checkIn: string; checkOut: string; guests: number; idempotencyKey?: string },
): Promise<BookingResult> {
  return db.begin(async (sql) => {
    const [listing] = await sql<{ seller_id: string; status: string; lane: string; title: string; price_kobo: string;
      attributes: Record<string, unknown> }[]>`
      select seller_id, status, lane, title, price_kobo, attributes from public.listings where id = ${p.listingId} for update
    `;
    if (!listing || listing.status !== "active") return { ok: false, code: "listing_unavailable" };
    if (listing.lane !== "property" || listing.attributes.dealType !== "shortlet") return { ok: false, code: "not_shortlet" };
    if (listing.seller_id === p.buyerId) return { ok: false, code: "own_listing" };
    const a = listing.attributes as { minNights?: number; maxGuests?: number; cleaningKobo?: number; cautionKobo?: number };
    const nights = nightsBetween(p.checkIn, p.checkOut);
    const minNights = a.minNights ?? 1;
    if (nights < minNights) return { ok: false, code: "min_nights", minNights };
    if (a.maxGuests != null && p.guests > a.maxGuests) return { ok: false, code: "too_many_guests" };

    // A guest may hold several stays at one place (different dates never clash — the
    // exclusion constraint sees to that), but not squat its calendar: unpaid holds
    // are capped, and each lapses after 4h anyway.
    const [unpaid] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.deals
      where listing_id = ${p.listingId} and buyer_id = ${p.buyerId} and state in ('ACCEPTED', 'PAYMENT_PENDING')
    `;
    if (unpaid!.n >= MAX_UNPAID_HOLDS) return { ok: false, code: "deal_active" };
    // Under the listing lock, so no concurrent booking can slip in between this check
    // and the insert; the exclusion constraint still guards the table itself.
    const [clash] = await sql`
      select 1 from public.bookings
      where listing_id = ${p.listingId} and active
        and daterange(check_in, check_out, '[)') && daterange(${p.checkIn}::date, ${p.checkOut}::date, '[)')
      limit 1
    `;
    if (clash) return { ok: false, code: "dates_unavailable" };

    const nightlyKobo = Number(listing.price_kobo);
    const cleaningKobo = a.cleaningKobo ?? 0;
    const cautionKobo = a.cautionKobo ?? 0;
    const priceKobo = nightlyKobo * nights + cleaningKobo + cautionKobo;
    const booking: BookingTerms = { checkIn: p.checkIn, checkOut: p.checkOut, guests: p.guests, nights, nightlyKobo, cleaningKobo, cautionKobo };
    const terms: DealTerms = { service: listing.title, booking, milestones: bookingPlan(booking) };

    const [deal] = await sql<DealRow[]>`
      insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty, terms)
      values (${p.listingId}, ${p.buyerId}, ${listing.seller_id}, 'ACCEPTED', ${priceKobo}, 1, ${sql.json(terms)})
      returning *
    `;
    await sql`
      insert into public.deal_events
        (deal_id, seq, actor, actor_id, action, from_state, to_state, price_kobo, qty, idempotency_key)
      values (${deal!.id}, 1, 'BUYER', ${p.buyerId}, 'book', null, 'ACCEPTED', ${priceKobo}, 1, ${p.idempotencyKey ?? null})
    `;
    await sql`
      insert into public.bookings (deal_id, listing_id, check_in, check_out, guests)
      values (${deal!.id}, ${p.listingId}, ${p.checkIn}, ${p.checkOut}, ${p.guests})
    `;
    await sql`
      insert into public.conversations (listing_id, buyer_id, seller_id)
      values (${p.listingId}, ${p.buyerId}, ${listing.seller_id})
      on conflict (listing_id, buyer_id) do nothing
    `;
    const [conv] = await sql<{ id: string }[]>`
      update public.conversations set last_message_at = now()
      where listing_id = ${p.listingId} and buyer_id = ${p.buyerId}
      returning id
    `;
    await syncDeadline(sql, deal!.id, "ACCEPTED", deal!.state_token, terms);
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('deal.created',
        ${sql.json({ dealId: deal!.id, seq: 1, listingId: p.listingId, buyerId: p.buyerId, sellerId: listing.seller_id, booking: true })},
        ${deal!.id}, 1)
    `;
    return { ok: true, deal: deal!, conversationId: conv!.id };
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
    /** Replace the deal's terms (a counter on a staged quote re-plans the stages). */
    terms?: DealTerms;
    /** Replace the delivery terms (a counter that changes how the item changes hands). */
    delivery?: DealDelivery;
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

    if (bookingRefuses(deal, p.action)) return { ok: false, code: "illegal", from: deal.state };
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
        action: p.action,
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
    const setTerms = p.terms ? sql`, terms = ${sql.json(p.terms)}` : sql``;
    const setDelivery = p.delivery ? sql`, delivery = ${sql.json(p.delivery)}` : sql``;
    const updated = await sql<DealRow[]>`
      update public.deals
      set state = ${to}, state_token = ${newToken} ${setPrice} ${setQty} ${setTerms} ${setDelivery}
      where id = ${p.dealId} and state_token = ${deal.state_token}
      returning *
    `;
    if (updated.length === 0) return { ok: false, code: "conflict" };

    await sql`
      insert into public.deal_events
        (deal_id, seq, actor, actor_id, action, requested_action, from_state, to_state, price_kobo, qty, reason, idempotency_key,
         delivery_method, delivery_fee_kobo)
      values (${p.dealId}, ${next_seq}, ${p.actor}, ${p.actorId ?? null}, ${action}, ${p.action},
              ${deal.state}, ${to}, ${p.priceKobo ?? null}, ${p.qty ?? null}, ${p.reason ?? null}, ${p.idempotencyKey ?? null},
              ${updated[0]!.delivery?.method ?? null}, ${updated[0]!.delivery?.feeKobo ?? null})
    `;
    await syncDeadline(sql, p.dealId, to, newToken, updated[0]!.terms);
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('deal.transition',
        ${sql.json({ dealId: p.dealId, seq: next_seq, from: deal.state, to, actor: p.actor, action })},
        ${p.dealId}, ${next_seq})
    `;
    return { ok: true, deal: updated[0]! };
  });
}
