import type { Tx } from "./commands.js";

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
  status: "held" | "releasing" | "released" | "refunded";
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
