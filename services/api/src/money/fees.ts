/**
 * WCP fee math — pure, deterministic, integer kobo. Buyer pays a fee on the hold;
 * the seller's fee is netted on release (M5). Both have a MINIMUM FLOOR because a
 * pure-percentage take is underwater on small deals vs. per-transaction payment
 * costs (~₦100-class). Floor + bps chosen conservatively; tune before real money.
 */
export const BUYER_FEE_BPS = 50; // 0.5%
export const SELLER_FEE_BPS = 200; // 2%
export const MIN_FEE_KOBO = 10_000; // ₦100 floor

const bps = (amount: number, b: number) => Math.round((amount * b) / 10_000);

/** Buyer fee on the principal, floored. Charged ON TOP of the principal at hold. */
export const buyerFeeKobo = (principal: number): number =>
  Math.max(bps(principal, BUYER_FEE_BPS), MIN_FEE_KOBO);

/**
 * Seller fee on the principal, floored — but NEVER more than the principal itself.
 * The seller fee is NETTED out of the payout (payout = principal − sellerFee), so an
 * uncapped floor on a sub-floor listing would produce a negative payout. Capping at
 * principal keeps the payout in [0, principal]; use sellerPayoutKobo() as the source
 * of truth for the split so the two numbers can never disagree by a rounding kobo.
 */
export const sellerFeeKobo = (principal: number): number =>
  Math.min(Math.max(bps(principal, SELLER_FEE_BPS), MIN_FEE_KOBO), principal);

/** The seller's net payout = principal − sellerFee, computed as the residual so the
 * fee + payout ALWAYS sum to exactly the principal (no stray rounding kobo). */
export const sellerPayoutKobo = (principal: number): number => principal - sellerFeeKobo(principal);

/**
 * A staged (milestone) job's seller fee, split across its stages. The TOTAL fee is
 * the ordinary fee on the whole principal (so staging never changes what anyone pays);
 * each stage carries its share, allocated on the cumulative amount so the shares sum
 * to the total exactly — fee_k = round(F·cum_k/P) − round(F·cum_{k-1}/P).
 */
export const stageSellerFees = (amounts: readonly number[]): number[] => {
  const principal = amounts.reduce((a, b) => a + b, 0);
  const total = sellerFeeKobo(principal);
  let cum = 0;
  let prev = 0;
  return amounts.map((a) => {
    cum += a;
    const upTo = principal === 0 ? 0 : Math.round((total * cum) / principal);
    const fee = upTo - prev;
    prev = upTo;
    return fee;
  });
};

/**
 * Paystack's local-card/transfer fee on a GROSS charge: 1.5% + ₦100, the ₦100 waived
 * under ₦2,500, the whole fee capped at ₦2,000. Rounded UP (we never under-collect).
 */
export const PAYSTACK_PCT_BPS = 150;
export const PAYSTACK_FLAT_KOBO = 10_000;
export const PAYSTACK_FLAT_WAIVED_BELOW_KOBO = 250_000;
export const PAYSTACK_CAP_KOBO = 200_000;
export const paystackFeeKobo = (gross: number): number =>
  Math.min(
    Math.ceil((gross * PAYSTACK_PCT_BPS) / 10_000) + (gross >= PAYSTACK_FLAT_WAIVED_BELOW_KOBO ? PAYSTACK_FLAT_KOBO : 0),
    PAYSTACK_CAP_KOBO,
  );

/**
 * The buyer pays Paystack's fee (decided 2026-11-10): the processing line that, added
 * to `net` (principal + WCP buyer fee), leaves exactly `net` after Paystack takes its
 * cut — the smallest gross G with G − paystackFee(G) ≥ net. Closed forms for the three
 * fee regimes, then a few kobo of nudging for rounding.
 */
export const processingFeeKobo = (net: number): number => {
  const candidates = [
    Math.ceil((net * 10_000) / (10_000 - PAYSTACK_PCT_BPS)), // under ₦2,500: no flat
    Math.ceil(((net + PAYSTACK_FLAT_KOBO) * 10_000) / (10_000 - PAYSTACK_PCT_BPS)), // flat applies
    net + PAYSTACK_CAP_KOBO, // capped
  ];
  let best = Infinity;
  for (let g of candidates) {
    for (let i = 0; i < 5 && g - paystackFeeKobo(g) < net; i++) g++;
    if (g - paystackFeeKobo(g) >= net) best = Math.min(best, g);
  }
  // Below the flat threshold the first candidate can land just past ₦2,500, where the
  // flat kicks in; the others cover that, so `best` is always finite.
  return best - net;
};
