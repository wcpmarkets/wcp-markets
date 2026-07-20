import { createHmac, timingSafeEqual } from "node:crypto";
import type { EscrowProvider, EscrowTxn, EscrowWebhook } from "./index.js";

/**
 * A deterministic mock escrow partner. createHold/release/refund immediately produce
 * the corresponding webhook payload (signed with a shared secret) instead of calling
 * a real API — the orchestrator POSTs that payload to our own webhook endpoint, so
 * the exact async hold→confirm→release/refund reconciliation flow the real partner
 * will drive is exercised end-to-end. Swap this class for the real provider later.
 */
export class MockEscrowProvider implements EscrowProvider {
  constructor(private readonly secret: string) {}

  private ref(kind: string, dealId: string): string {
    return `mock_${kind}_${dealId}`;
  }

  async createHold(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn> {
    return { providerRef: this.ref("hold", p.dealId), dealId: p.dealId, amountKobo: p.amountKobo, status: "pending" };
  }
  async releaseToSeller(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn> {
    return { providerRef: this.ref("rel", p.dealId), dealId: p.dealId, amountKobo: p.amountKobo, status: "released" };
  }
  async payoutToSeller(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn> {
    return { providerRef: this.ref("pay", p.dealId), dealId: p.dealId, amountKobo: p.amountKobo, status: "released" };
  }
  async refundToBuyer(p: { dealId: string; amountKobo: number; idempotencyKey: string }): Promise<EscrowTxn> {
    return { providerRef: this.ref("ref", p.dealId), dealId: p.dealId, amountKobo: p.amountKobo, status: "refunded" };
  }
  async getTransaction(): Promise<EscrowTxn | null> {
    return null; // mock keeps no store; reconciliation is a no-op here
  }

  /** Build the signed webhook the mock "partner" would POST back for a given event. */
  buildWebhook(w: EscrowWebhook): { body: string; signature: string } {
    const body = JSON.stringify(w);
    return { body, signature: this.sign(body) };
  }

  private sign(body: string): string {
    return createHmac("sha256", this.secret).update(body).digest("hex");
  }

  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = this.sign(rawBody);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: string): EscrowWebhook {
    return JSON.parse(rawBody) as EscrowWebhook;
  }
}
