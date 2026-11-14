import { z } from "@hono/zod-openapi";
import { NG_STATES } from "../data/ng-regions.js";

/**
 * How a goods item changes hands (migration 0040). Two halves:
 *
 *  - The LISTING says what the seller offers (13d "DELIVERY YOU OFFER"): any of
 *    deliver / meet / pickup, and for deliver, the states they cover. A goods listing
 *    must offer at least one (12a — escrow releases against a hand-off).
 *  - The DEAL says what this buyer and seller agreed (7h-offer): one method, where,
 *    when, and — for deliver — a fee the seller pins from chat (7h-feereply). Pay
 *    stays shut until a deliver deal has a fee (13b-nodelivery). After payment the
 *    seller confirms the hand-off window (20g).
 *
 * WCP doesn't do logistics: the fee is between the two parties, it simply rides in
 * escrow with the items (deals.principal_kobo) so a no-show refunds it too.
 */
export const DELIVERY_METHODS = ["deliver", "meet", "pickup"] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** States in which a deal's delivery terms can still change: before money moves. */
export const UNPAID_STATES = ["OFFERED", "COUNTERED_BY_SELLER", "COUNTERED_BY_BUYER", "ACCEPTED"] as const;

/** A delivery fee is a real number, not a typo'd ₦4.5m. */
export const MAX_DELIVERY_FEE_KOBO = 50_000_000; // ₦500,000

export const ListingDeliverySchema = z
  .object({
    /** What buyers may pick from. At least one on a goods listing. */
    modes: z.array(z.enum(DELIVERY_METHODS)).min(1).max(3),
    /** States the seller delivers to (deliver only). Empty/absent = the listing's own state. */
    states: z.array(z.string()).max(NG_STATES.length).optional(),
  })
  .openapi("ListingDelivery");
export type ListingDelivery = z.infer<typeof ListingDeliverySchema>;

/** What the buyer proposes with an offer or counter. */
export const DeliveryChoiceSchema = z
  .object({
    method: z.enum(DELIVERY_METHODS),
    /** deliver: the buyer's state (checked against coverage). */
    state: z.string().max(64).optional(),
    /** deliver: the buyer's area ("Yaba"); meet: the spot ("Ikeja City Mall"). Pickup uses the listing's area. */
    place: z.string().trim().max(120).optional(),
    /** Free text the two agree on ("Tomorrow 10am", "Sat, anytime"). */
    when: z.string().trim().max(60).optional(),
  })
  .openapi("DeliveryChoice");
export type DeliveryChoice = z.infer<typeof DeliveryChoiceSchema>;

export const DealDeliverySchema = DeliveryChoiceSchema.extend({
  /** deliver: the fee the seller pinned (null until then — Pay waits for it). */
  feeKobo: z.number().int().nullable(),
  /** After payment: the hand-off window the seller confirmed (20g). */
  window: z.string().nullable(),
  /** Seller only, while a deliver fee is unset: their recent fees, for one-tap chips. */
  suggestedFeesKobo: z.array(z.number().int()).optional(),
}).openapi("DealDelivery");

export type DealDelivery = DeliveryChoice & { feeKobo?: number | null; window?: string | null };

/** The listing's offer, with older listings (before 0040) read as deliver + meet in their own state. */
export function listingDelivery(attrs: { delivery?: ListingDelivery } | null | undefined, ownState: string | null): {
  modes: DeliveryMethod[];
  states: string[];
} {
  const d = attrs?.delivery;
  const modes = d?.modes?.length ? [...new Set(d.modes)] : (["deliver", "meet"] as DeliveryMethod[]);
  const states = d?.states?.length ? d.states : ownState ? [ownState] : [];
  return { modes, states };
}

/** A goods listing's delivery block is valid: known methods, canonical states. */
export function listingDeliveryProblem(d: ListingDelivery | undefined): string | null {
  if (!d || !d.modes.length) return "goods_needs_delivery_mode";
  if (d.states?.some((s) => !NG_STATES.includes(s))) return "unknown_delivery_state";
  return null;
}

/**
 * Whether a buyer's choice fits what the listing offers. Out-of-coverage deliver is
 * refused (12b) — the buyer meets / picks up, or asks the seller to add the state.
 */
export function deliveryChoiceProblem(
  choice: DeliveryChoice,
  offered: { modes: DeliveryMethod[]; states: string[] },
): string | null {
  if (!offered.modes.includes(choice.method)) return "delivery_method_not_offered";
  if (choice.method === "deliver") {
    if (!choice.state || !NG_STATES.includes(choice.state)) return "delivery_needs_state";
    if (offered.states.length && !offered.states.includes(choice.state)) return "outside_delivery_coverage";
  }
  if (choice.method === "meet" && !choice.place) return "meet_needs_place";
  return null;
}

/**
 * The deal's delivery after a new choice: a changed method or destination clears a
 * pinned fee (it was quoted for something else); the same destination keeps it.
 */
export function nextDelivery(prev: DealDelivery | null, choice: DeliveryChoice): DealDelivery {
  const sameDestination = prev?.method === "deliver" && choice.method === "deliver" && prev.state === choice.state && prev.place === choice.place;
  return {
    method: choice.method,
    state: choice.state,
    place: choice.place,
    when: choice.when,
    feeKobo: choice.method === "deliver" ? (sameDestination ? (prev?.feeKobo ?? null) : null) : null,
    window: null,
  };
}

/** Pay must wait: the seller delivers and hasn't pinned a fee yet. */
export const feePending = (d: DealDelivery | null | undefined): boolean => d?.method === "deliver" && d.feeKobo == null;

/** What escrow holds before the buyer fee — 0040's principal_kobo, with a fallback for rows read before it existed. */
export const principalOf = (d: { price_kobo: string | number; principal_kobo?: string | number | null }): number =>
  Number(d.principal_kobo ?? d.price_kobo);

export const formatNaira = (kobo: number): string => `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
