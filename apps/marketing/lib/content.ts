/**
 * Marketing page copy — lifted verbatim from the design source of truth
 * (`design_handoff_marketing_site/WCP Marketing Site.dc.html`). This is the
 * single place to edit wording; components render from it.
 */
import { colors } from "@wcp/tokens";

export const announcement =
  "WCP Markets launches soon on Android & iOS — join the waitlist and be first in.";

export const nav = {
  links: [
    { label: "What you can trade", href: "#lanes" },
    { label: "How escrow works", href: "#escrow" },
    { label: "AI search", href: "#ai" },
    { label: "FAQ", href: "#faq" },
  ],
  cta: { label: "Join the waitlist", href: "#waitlist" },
} as const;

export const hero = {
  statusPill: "Built for Nigeria · launching soon",
  headingLine1: "Buy and sell anything.",
  headingLine2: "Money held safe.",
  sub: "WCP Markets is a marketplace for goods, property, vehicles and services — where every naira sits in escrow until you confirm the deal. Describe what you want in plain English; the AI finds it. No pay-and-pray.",
  chips: [
    { icon: "🔒", label: "Escrow on every deal" },
    { icon: "✓", label: "Verified sellers" },
    { icon: "✦", label: "AI-powered search" },
  ],
} as const;

/** Hero escrow-deal card (static product mock). */
export const escrowCard = {
  ref: "#WCP-4821 · Yaba, Lagos",
  item: { title: "PS5 · Disc Edition", meta: "★ 4.9 · Verified seller ✓" },
  amountLabel: "HELD SAFELY IN ESCROW",
  amount: "₦478,000",
  amountCaption: "Seller sees it's secured — but can't touch it",
  steps: [
    { label: "Agreed", glyph: "✓", state: "done" },
    { label: "In escrow", glyph: "🔒", state: "active" },
    { label: "Inspect", glyph: "3", state: "todo" },
    { label: "Release", glyph: "4", state: "todo" },
  ],
  cta: "Confirm receipt & release",
  badge: "Buyer protected",
} as const;

export type LaneCard = {
  tag: string;
  accent: string;
  tagBg: string;
  title: string;
  body: string;
};

export const lanes: LaneCard[] = [
  {
    tag: "GOODS",
    accent: colors.laneGoods,
    tagBg: "rgba(34,211,238,.14)",
    title: "Buy with escrow",
    body: "Phones, laptops, furniture, fashion — pay into escrow, inspect, confirm. Refunded if it goes wrong.",
  },
  {
    tag: "PROPERTY",
    accent: colors.laneProperty,
    tagBg: "rgba(158,195,220,.18)",
    title: "Book a viewing",
    body: "Rentals, sales, land with verified titles, shortlets with escrowed deposits. Viewings logged for safety.",
  },
  {
    tag: "VEHICLES",
    accent: colors.laneVehicles,
    tagBg: "rgba(255,176,32,.16)",
    title: "Enquire & inspect",
    body: "Cars, buses, kekes from verified dealers. Bring your own mechanic — no deposits, no pressure.",
  },
  {
    tag: "SERVICES",
    accent: colors.laneServices,
    tagBg: "rgba(163,230,53,.16)",
    title: "Request a quote",
    body: "Plumbers, tailors, planners — agree a price in chat, pay into escrow, release when the job is done.",
  },
];

export const escrowSteps = [
  {
    n: 1,
    title: "Agree the deal in chat",
    body: "Price, delivery, everything — bundled into one offer card both of you accept.",
    emphasis: false,
  },
  {
    n: 2,
    title: "Pay into escrow",
    body: "Card, transfer or USSD. WCP Markets holds it — the seller sees it's secured but can't touch it.",
    emphasis: false,
  },
  {
    n: 3,
    title: "Receive & inspect",
    body: "Delivery, meet-up or pickup — check the item properly before anything moves.",
    emphasis: false,
  },
  {
    n: 4,
    title: "Confirm — seller gets paid instantly",
    body: "Something wrong? Open a dispute — the money stays frozen until it's resolved.",
    emphasis: true,
  },
] as const;

export const aiSearch = {
  heading: "Just say what you want.",
  body: "No dropdown archaeology. Describe it — by text, photo or voice — and WCP Markets' AI works out what you mean, applies the right filters, and shows you why each result matched. Selling is even easier: snap photos and the AI drafts your whole listing.",
  bullets: [
    "Understands plain Nigerian English",
    "Shows the filters it applied — change any of them",
    "Photos → a complete draft listing with a fair price",
  ],
  userMessage: "2-bed in Lekki under ₦4m a year, serviced if possible",
  filters: [
    { label: "Rent ▾", dashed: false },
    { label: "2 beds ✕", dashed: false },
    { label: "≤₦4m/yr ✕", dashed: false },
    { label: "+ Serviced", dashed: true },
  ],
} as const;

export const trust = [
  {
    icon: "✓",
    title: "Verified sellers",
    body: "Identity-checked (BVN/NIN) before they can ever withdraw a naira.",
  },
  {
    icon: "★",
    title: "Reviews that are real",
    body: "Only buyers who actually paid through escrow can review. Sellers can reply — never delete.",
  },
  {
    icon: "⚖",
    title: "Fair disputes",
    body: "Money freezes, evidence on both sides, a human decides. No response from the seller in 24h? Automatic refund.",
  },
  {
    icon: "🛡",
    title: "Scam guard in chat",
    body: '"Pay outside the app" lures are flagged the moment they\'re typed.',
  },
] as const;

export const faqs = [
  {
    q: "What is WCP Markets?",
    a: "WCP Markets is a Nigerian marketplace for goods, property, vehicles and services. It works like the classifieds you know — anyone can list anything — but the deal closes safely inside the app: your payment is held in escrow by WCP Markets and only released to the seller when you confirm.",
  },
  {
    q: "How is buying on WCP Markets safer?",
    a: "When you buy from a stranger online, you normally pay directly and hope. On WCP Markets the money sits in escrow until you receive and confirm the item, sellers are identity-verified, and reviews come only from real completed purchases.",
  },
  {
    q: "What does escrow cost?",
    a: "A small buyer-side fee (about 0.5%) shown clearly at checkout — no hidden charges. Browsing, listing and chatting are free.",
  },
  {
    q: "What if the item isn’t as described?",
    a: "Don’t confirm. Open a dispute with photos — your money stays frozen while it’s reviewed. If the seller doesn’t respond within 24 hours, you’re refunded automatically.",
  },
  {
    q: "When does WCP Markets launch, and where?",
    a: "We’re launching first in a few selected cities on Android and iOS, then expanding city by city. Join the waitlist and we’ll email you the moment your city opens.",
  },
] as const;

export const waitlistSection = {
  heading: "Be first when WCP Markets opens.",
  sub: "Early waitlist members get priority access at launch — and verified-seller onboarding before the crowd arrives.",
  finePrint: "No spam — one email at launch, one when your city goes live.",
} as const;

export const waitlistNotes = {
  notJoined: "Join 12,400+ Nigerians already waiting.",
  joinedHero: "✓ You’re on the list — check your inbox for a confirmation.",
  successChip:
    "You’re on the list — we’ll email you the moment doors open.",
} as const;

export const footer = {
  copyright: "© 2026 WCP Markets · Lagos, Nigeria",
  links: [
    { label: "Terms", href: "#" },
    { label: "Privacy", href: "#" },
    { label: "Contact", href: "#" },
  ],
} as const;
