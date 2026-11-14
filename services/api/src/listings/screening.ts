import type { Sql } from "../deals/commands.js";

/**
 * Publish-time screening (design 13d-flagged, migration 0041). Deterministic rules
 * only — no AI — run when a listing is created and whenever its text or price is
 * edited. A hit holds the listing for a human; it never declines anything itself.
 *
 *  - contact_details: a phone number, email or "WhatsApp me" in the title or
 *    description. Moving the chat off-platform is how most marketplace scams start,
 *    and in-app chat is what escrow disputes are judged on.
 *  - off_platform_payment: wording that asks for payment outside escrow.
 *  - price_far_below: under 40% of the median of at least 5 comparable active
 *    listings (goods: same category and condition). Too-good-to-be-true pricing is
 *    the classic bait; a genuine bargain is approved in minutes.
 *
 * The design's catalogue-photo check needs the vision model and isn't here.
 */
export type ScreeningFlag = { code: "contact_details" | "off_platform_payment" | "price_far_below"; detail: string };

export const PRICE_FLOOR_RATIO = 0.4;
export const MIN_COMPARABLES = 5;

// Separators people put inside numbers to dodge filters: spaces, dots, dashes, brackets.
const squash = (s: string) => s.replace(/[\s.\-()_/]/g, "");
// Nigerian mobiles: 080…, 070…, 090…, 081…, 091…, 071… — with or without +234.
const NG_PHONE = /(?:\+?234|0)[789][01]\d{8}/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;
const CONTACT_WORDS = /\b(whats\s?app|wa\.me|telegram|call\s+me|text\s+me|dm\s+me|reach\s+me\s+on|my\s+(number|line|phone)\s+is)\b/i;
const OFF_PLATFORM = new RegExp(
  [
    String.raw`\b(transfer|pay(ment)?|send\s+(the\s+)?money)\b[^.\n]{0,25}\b(first|upfront|up\s+front|before)\b`,
    String.raw`\bpay\s+(in)?to\s+my\s+(account|acct|bank)\b`,
    String.raw`\b(bank|account)\s+details\b`,
    String.raw`\b(outside|off)\s+(the\s+)?(app|platform|wcp)\b`,
    String.raw`\bno\s+escrow\b`,
    String.raw`\bdirect\s+(transfer|payment)\b`,
  ].join("|"),
  "i",
);

function money(kobo: number): string {
  return `₦${Math.round(kobo / 100).toLocaleString("en-NG")}`;
}

/** The text rules — pure, so they're testable without a database. */
export function textFlags(title: string, description: string | null): ScreeningFlag[] {
  const text = `${title}\n${description ?? ""}`;
  const flags: ScreeningFlag[] = [];
  const where = (re: RegExp, squashed = false) => {
    const t = (s: string) => (squashed ? squash(s) : s);
    return re.test(t(title)) ? "title" : re.test(t(description ?? "")) ? "description" : null;
  };
  const phone = where(NG_PHONE, true);
  const email = where(EMAIL);
  const words = where(CONTACT_WORDS);
  if (phone || email || words) {
    const what = phone ? "A phone number" : email ? "An email address" : "A request to contact you off WCP Markets";
    flags.push({
      code: "contact_details",
      detail: `${what} in the ${phone ?? email ?? words}. Buyers reach you through in-app chat — that's what protects both of you if anything goes wrong.`,
    });
  }
  if (OFF_PLATFORM.test(text)) {
    flags.push({
      code: "off_platform_payment",
      detail: "Wording that asks for payment outside escrow. On WCP Markets every payment goes into escrow and is released when the buyer confirms.",
    });
  }
  return flags;
}

/** The price rule: compares against comparable active listings from other sellers. */
export async function priceFlag(
  db: Sql,
  l: { id?: string; sellerId: string; lane: string; category: string; condition: string | null; priceKobo: number },
): Promise<ScreeningFlag | null> {
  if (l.lane !== "goods" || l.priceKobo <= 0) return null;
  const [r] = await db<{ n: number; median: string | null }[]>`
    select count(*)::int as n,
           percentile_cont(0.5) within group (order by price_kobo)::bigint as median
    from public.listings
    where status = 'active' and lane = 'goods'
      and lower(category) = lower(${l.category})
      and condition is not distinct from ${l.condition}
      and seller_id <> ${l.sellerId}
      and id <> ${l.id ?? "00000000-0000-0000-0000-000000000000"}`;
  const median = r?.median == null ? 0 : Number(r.median);
  if (!r || r.n < MIN_COMPARABLES || median <= 0) return null;
  if (l.priceKobo >= median * PRICE_FLOOR_RATIO) return null;
  return {
    code: "price_far_below",
    detail: `${money(l.priceKobo)} is far below similar listings (around ${money(median)}). If that's genuine, no action needed — we'll check it quickly.`,
  };
}

export async function screenListing(
  db: Sql,
  l: { id?: string; sellerId: string; lane: string; category: string; condition: string | null; priceKobo: number; title: string; description: string | null },
): Promise<ScreeningFlag[]> {
  const flags = textFlags(l.title, l.description);
  const p = await priceFlag(db, l);
  if (p) flags.push(p);
  return flags;
}
