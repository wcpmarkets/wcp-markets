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
