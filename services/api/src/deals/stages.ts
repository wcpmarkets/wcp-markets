import type { BookingTerms, DealTerms, Tx } from "./commands.js";
import { stageSellerFees } from "../money/fees.js";

/**
 * Milestone escrow (22c-quotebuild, 22c-quotecard-staged, 22c-milestone).
 *
 * A big job's quote can be split into stages that sum to the price. While the deal is
 * being negotiated the plan lives in deals.terms.milestones (it changes with every
 * counter); when escrow is funded it is materialised into public.deal_milestones, and
 * from then on every release/refund works stage by stage against those rows:
 *
 *   held ─(buyer confirms / 48h / admin)→ releasing ─(release.settled)→ released
 *   held ─(refund.settled)→ refunded
 *   held ─(deposit return)→ refunding ─(refund.settled, part)→ refunded   (shortlets)
 *
 * The buyer funds the whole price up front; the provider marks a stage done
 * (hand_off), the buyer confirms it and only that stage's money moves. A dispute
 * freezes whatever is still held.
 */

export const MIN_STAGES = 2;
export const MAX_STAGES = 6;
/** ₦1,000 — below this a stage isn't worth a separate release. */
export const MIN_STAGE_KOBO = 100_000;

export type StagePlan = { title: string; amountKobo: number };
export type StageRow = {
  deal_id: string;
  idx: number;
  title: string;
  amount_kobo: string | number;
  status: "held" | "releasing" | "released" | "refunding" | "refunded";
  release_seq: number | null;
  provider_ref: string | null;
  released_at: string | Date | null;
};

export type StageProblem =
  | "too_few_stages"
  | "too_many_stages"
  | "stage_title_required"
  | "stage_too_small"
  | "stages_must_sum_to_price";

/** Why a stage plan can't be used for this price, or null when it's fine. */
export function stageProblem(stages: readonly StagePlan[], priceKobo: number): StageProblem | null {
  if (stages.length < MIN_STAGES) return "too_few_stages";
  if (stages.length > MAX_STAGES) return "too_many_stages";
  if (stages.some((s) => s.title.trim().length === 0)) return "stage_title_required";
  if (stages.some((s) => !Number.isInteger(s.amountKobo) || s.amountKobo < MIN_STAGE_KOBO)) return "stage_too_small";
  if (stages.reduce((a, s) => a + s.amountKobo, 0) !== priceKobo) return "stages_must_sum_to_price";
  return null;
}

/**
 * A counter on a staged quote names a new total; the stages keep their proportions
 * (rounded to the naira, the last stage absorbing the remainder so they still sum
 * exactly). Returns null when the new price is too small to keep the split.
 */
export function rescaleStages(stages: readonly StagePlan[], priceKobo: number): StagePlan[] | null {
  const old = stages.reduce((a, s) => a + s.amountKobo, 0);
  if (old <= 0) return null;
  const out = stages.map((s, i) => {
    if (i === stages.length - 1) return { ...s, amountKobo: 0 };
    return { ...s, amountKobo: Math.round((s.amountKobo * priceKobo) / old / 100) * 100 };
  });
  const rest = priceKobo - out.reduce((a, s) => a + s.amountKobo, 0);
  out[out.length - 1]!.amountKobo = rest;
  return stageProblem(out, priceKobo) ? null : out;
}

/** The deal's materialised stages, in order (locked when `lock`). */
export async function stagesOf(sql: Tx, dealId: string, lock = false): Promise<StageRow[]> {
  return lock
    ? sql<StageRow[]>`select * from public.deal_milestones where deal_id = ${dealId} order by idx for update`
    : sql<StageRow[]>`select * from public.deal_milestones where deal_id = ${dealId} order by idx`;
}

/**
 * The seller fee each stage carries when it releases. A staged job spreads the
 * ordinary fee on the whole price across its stages. A shortlet booking is not a
 * split price: the stay carries the ordinary fee on the stay, and the caution
 * deposit carries none — it is the guest's money held against damage, and if a claim
 * awards it to the host that is compensation, not a sale WCP takes a cut of.
 */
export function stageFees(terms: DealTerms | null | undefined, amounts: readonly number[]): number[] {
  if (terms?.booking) {
    // The host-bound stages (both halves of the stay + cleaning) share the ordinary
    // fee on their total; the deposit (last, when taken) carries none.
    const dep = terms.booking.cautionKobo > 0 ? 1 : 0;
    const host = amounts.slice(0, amounts.length - dep);
    return [...stageSellerFees(host), ...amounts.slice(host.length).map(() => 0)];
  }
  return stageSellerFees(amounts);
}

// ── Shortlet bookings ────────────────────────────────────────────────────────
// A booking is materialised as stages chosen so that every outcome is a set of whole
// stages released or returned. Stage amounts are immutable once held, so a split can
// never be cut at cancel time — it has to exist from the start:
//
//   1 Stay · first half   floor(nightly total / 2)
//   2 Stay · second half  the rest of the nightly total
//   3 Cleaning            (when the listing charges one)
//   4 Caution deposit     (when the listing takes one) — always last
//
// Checkout releases the stay halves + cleaning. A guest cancelling releases none, one
// or both halves by notice and returns everything else: 7+ days → nothing to the
// host, 2–7 days → 50%, under 48h → the nightly total; cleaning + deposit always back.

export function bookingPlan(b: BookingTerms): StagePlan[] {
  const nightly = b.nightlyKobo * b.nights;
  const first = Math.floor(nightly / 2);
  return [
    { title: "Stay · first half", amountKobo: first },
    { title: "Stay · second half", amountKobo: nightly - first },
    ...(b.cleaningKobo > 0 ? [{ title: "Cleaning", amountKobo: b.cleaningKobo }] : []),
    ...(b.cautionKobo > 0 ? [{ title: "Caution deposit", amountKobo: b.cautionKobo }] : []),
  ];
}

/** Which stage idx plays which role in a booking (1-based, as materialised). */
export function bookingRoles(b: BookingTerms): { stay: [number, number]; cleaning: number | null; deposit: number | null } {
  const cleaning = b.cleaningKobo > 0 ? 3 : null;
  const deposit = b.cautionKobo > 0 ? (cleaning ? 4 : 3) : null;
  return { stay: [1, 2], cleaning, deposit };
}

export type CancelTier = "full_refund" | "half" | "no_refund";
/** Notice (hours before check-in) that decides a cancellation's tier. */
export const CANCEL_FULL_HOURS = 7 * 24;
export const CANCEL_HALF_HOURS = 48;

export function cancelTier(hoursToCheckIn: number): CancelTier {
  if (hoursToCheckIn >= CANCEL_FULL_HOURS) return "full_refund";
  if (hoursToCheckIn >= CANCEL_HALF_HOURS) return "half";
  return "no_refund";
}

/** The stay halves the host keeps for a tier; everything else goes back. */
export function hostStagesFor(tier: CancelTier): number[] {
  return tier === "full_refund" ? [] : tier === "half" ? [1] : [1, 2];
}

/** Stage fees for a deal read from the DB (settlement paths that only hold a deal id). */
export async function stageFeesOf(sql: Tx, dealId: string, stages: readonly StageRow[]): Promise<number[]> {
  const [d] = await sql<{ terms: DealTerms | null }[]>`select terms from public.deals where id = ${dealId}`;
  return stageFees(d?.terms, stages.map((s) => Number(s.amount_kobo)));
}
