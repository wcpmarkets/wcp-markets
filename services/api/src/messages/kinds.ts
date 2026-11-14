import { z } from "@hono/zod-openapi";

/**
 * Structured chat cards (0040). body is always a readable fallback.
 *  - delivery_fee: the seller pinned a delivery fee to the deal (7h-feereply).
 *  - coverage_request: the buyer asks to be delivered to a state outside coverage (12b-request).
 *  - coverage_reply: the seller added the state (with an optional fee) or can't (12b-seller).
 *  - handoff_window: the seller confirmed when the item changes hands, after payment (20g).
 */
export const MESSAGE_KINDS = ["delivery_fee", "coverage_request", "coverage_reply", "handoff_window"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export const MessageMetaSchema = z
  .object({
    feeKobo: z.number().int().nullable().optional(),
    state: z.string().nullable().optional(),
    /** coverage_request: pending until the seller answers; coverage_reply: accepted or declined. */
    status: z.enum(["pending", "accepted", "declined"]).optional(),
    window: z.string().nullable().optional(),
  })
  .openapi("MessageMeta");

