/**
 * The escrow provider contract. WCP orchestrates; a licensed partner custodies the
 * funds. The whole money spine is written against THIS interface so the real partner
 * (Paystack/Providus + an escrow licence) later drops in behind an unchanged surface.
 * A MockEscrowProvider implements it now and emits webhooks onto the SAME path the
 * real partner will use, so the async reconciliation flow is exercised from day one.
 *
 * All amounts are integer kobo. Every call is idempotent on `idempotencyKey`
 * (dealId-derived) so at-least-once delivery from the outbox never double-acts.
 */
export type HoldStatus = "pending" | "held" | "failed";

export type EscrowTxn = {
  providerRef: string;
  dealId: string;
  amountKobo: number;
  status: HoldStatus | "released" | "refunded";
};

/** A normalized inbound webhook (after signature verification + parsing). */
export type EscrowWebhook = {
  eventId: string; // provider's unique event id → our idempotency_key
  type: "hold.confirmed" | "hold.failed" | "release.settled" | "refund.settled" | "payout.settled";
  providerRef: string;
  dealId: string;
  amountKobo: number;
};

export interface EscrowProvider {
  /** Create a hold for a deal (buyer principal + fee). Async: confirmation arrives by webhook. */
  createHold(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn>;
  /** Release held funds to the seller (net of fee). Settlement arrives by webhook. */
  releaseToSeller(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn>;
  /** Pay out the seller's balance to their bank (L2-gated upstream). Settles by webhook. */
  payoutToSeller(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn>;
  /** Refund held funds to the buyer. Settlement arrives by webhook. */
  refundToBuyer(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn>;
  /** Look up a transaction (reconciliation). */
  getTransaction(providerRef: string): Promise<EscrowTxn | null>;
  /** Verify an inbound webhook's signature. */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean;
  /** Parse a verified webhook body into the normalized shape. */
  parseWebhook(rawBody: string): EscrowWebhook;
}

export { MockEscrowProvider } from "./mock.js";
