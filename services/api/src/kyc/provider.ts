/**
 * KYC provider (Mock NIBSS). The identity number (BVN/NIN) is passed in, matched, and
 * the RESULT ONLY is returned — the number is never stored or echoed. Swap for the
 * real NIBSS BVN/NIN-match + selfie-liveness partner behind this interface later.
 */
export type KycResult = { matched: boolean; providerRef: string };

export interface KycProvider {
  /** Verify a BVN/NIN (+ optional selfie liveness). Returns only the match outcome. */
  verifyIdentity(p: { idType: "bvn" | "nin"; idNumber: string; selfiePath?: string }): Promise<KycResult>;
}

/** Deterministic mock: a well-formed 11-digit BVN/NIN "matches". Never persists the number. */
export class MockKycProvider implements KycProvider {
  async verifyIdentity(p: { idType: "bvn" | "nin"; idNumber: string }): Promise<KycResult> {
    const matched = /^\d{11}$/.test(p.idNumber.trim());
    const ref = `mock_kyc_${p.idType}_${Math.random().toString(36).slice(2, 12)}`;
    return { matched, providerRef: ref };
  }
}

let provider: KycProvider | null = null;
export function getKycProvider(): KycProvider {
  if (!provider) provider = new MockKycProvider();
  return provider;
}
