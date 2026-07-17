/**
 * WCP design tokens — the single source of truth for the platform's visual
 * language. Values are taken verbatim from the design handoff
 * (`design_handoff_marketing_site/README.md` + `WCP Marketing Site.dc.html`).
 *
 * This TS module is canonical. `theme.css` mirrors these into Tailwind v4
 * `@theme` variables for the web; a Style Dictionary export will mirror them to
 * iOS/Android in Phase 2. Keep the three in sync.
 */

export const colors = {
  /** page background */
  canvas: "#0D0F14",
  /** alternating section background */
  canvasAlt: "#0B0D11",
  /** default card surface */
  panel: "#12151C",
  /** escrow card gradient stops (deep panel) */
  panelDeepFrom: "#141821",
  panelDeepTo: "#0E1116",
  /** default card border */
  border: "#232838",
  /** hovered card border */
  borderHover: "#3A4254",
  /** section top borders */
  divider: "#161B25",

  textPrimary: "#EAEDF2",
  textSecondary: "#C6CCD8",
  textMuted: "#8A93A6",
  textFaint: "#707A8C",

  /** brand gradient start; eyebrows */
  brandPurple: "#7C5CFF",
  /** brand gradient end; accents, links */
  brandCyan: "#22D3EE",
  /** positive / safety signals */
  lime: "#A3E635",

  /** lane accents (Goods = cyan, Services = lime) */
  laneGoods: "#22D3EE",
  laneProperty: "#9EC3DC",
  laneVehicles: "#FFB020",
  laneServices: "#A3E635",
} as const;

export const gradients = {
  /** primary CTAs, active escrow states, headline accents */
  signature: "linear-gradient(120deg, #7C5CFF, #22D3EE)",
  /** escrow card amount text */
  amount: "linear-gradient(120deg, #EAEDF2, #9EC3DC)",
  /** deep panel (escrow card) */
  panelDeep: "linear-gradient(180deg, #141821, #0E1116)",
} as const;

export const radii = {
  pill: "999px",
  cardLg: "24px",
  card: "18px",
  input: "13px",
} as const;

export const shadows = {
  escrowCard:
    "0 40px 90px rgba(124,92,255,.18), 0 12px 30px rgba(0,0,0,.6)",
} as const;

export const font = {
  sans: "'Space Grotesk', system-ui, sans-serif",
} as const;

/** Lane metadata used across the marketing page and later the app. */
export const lanes = {
  goods: { label: "Goods", accent: colors.laneGoods },
  property: { label: "Property", accent: colors.laneProperty },
  vehicles: { label: "Vehicles", accent: colors.laneVehicles },
  services: { label: "Services", accent: colors.laneServices },
} as const;

export type LaneKey = keyof typeof lanes;
