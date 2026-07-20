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

/** Buyer fee on the principal, floored. Charged on top of the principal at hold. */
export const buyerFeeKobo = (principal: number): number =>
  Math.max(bps(principal, BUYER_FEE_BPS), MIN_FEE_KOBO);

/** Seller fee on the principal, floored. Netted out of the seller's payout at release. */
export const sellerFeeKobo = (principal: number): number =>
  Math.max(bps(principal, SELLER_FEE_BPS), MIN_FEE_KOBO);
