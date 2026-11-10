/**
 * Phase 3I — the shape of an interpreted search, shared by the Claude interpreter, the
 * rules fallback and the photo route.
 *
 * Whatever produced the filters (a model, a regex, a photo), they pass through
 * `normalizeFilters` before anyone uses them: every value is checked against the same
 * vocabulary the listing forms use, and canonicalised ("lekki" → Lagos / Lekki,
 * "toyota" → Toyota). A value we can't place is dropped, never guessed at, so a search
 * can only narrow by things a listing can actually carry.
 *
 * The banner sentence (13e "Showing homes for rent · Lekki · ≤₦4m/yr") is built here
 * from the *normalised* filters rather than taken from the model, so it always
 * describes exactly what the search applies.
 */
import { NG_REGIONS } from "../data/ng-regions.js";
import { SERVICE_CATALOG, AVAILABILITY } from "../data/services.js";
import {
  BODIES,
  FUELS,
  REGISTRATIONS,
  TRANSMISSIONS,
  VEHICLE_CATALOG,
  VEHICLE_CONDITIONS,
  MIN_YEAR,
  maxYear,
} from "../data/vehicles.js";
import { CONDITIONS, DEAL_TYPES, LANES, PROPERTY_TYPES } from "../routes/listings.js";

export type Lane = (typeof LANES)[number];

/**
 * Goods categories, as the app's category picker names them (GoodsFilterSpec.kt). The
 * slug is the listing's `category`.
 */
export const GOODS_CATEGORIES: readonly { slug: string; label: string }[] = [
  { slug: "phones", label: "Phones & Tablets" },
  { slug: "laptops", label: "Laptops" },
  { slug: "computers", label: "Computers" },
  { slug: "tv-audio", label: "TV & Audio" },
  { slug: "gaming", label: "Gaming" },
  { slug: "fashion", label: "Fashion & Accessories" },
  { slug: "appliances", label: "Appliances & Generators" },
  { slug: "furniture", label: "Furniture & Home" },
  { slug: "health-beauty", label: "Health & Beauty" },
  { slug: "babies-kids", label: "Babies & Kids" },
  { slug: "sports", label: "Sports & Leisure" },
  { slug: "tools", label: "Tools & Equipment" },
  { slug: "vehicle-parts", label: "Vehicle Parts" },
];

/** The filters an interpretation can set: the /listings/search params, minus the text. */
export type Filters = {
  category?: string;
  condition?: (typeof CONDITIONS)[number];
  minPrice?: number; // kobo
  maxPrice?: number; // kobo
  state?: string;
  city?: string;
  propertyType?: (typeof PROPERTY_TYPES)[number];
  dealType?: (typeof DEAL_TYPES)[number];
  minBeds?: number;
  make?: string;
  model?: string;
  minYear?: number;
  maxYear?: number;
  maxMileageKm?: number;
  transmission?: (typeof TRANSMISSIONS)[number];
  fuel?: (typeof FUELS)[number];
  body?: (typeof BODIES)[number];
  vehicleCondition?: (typeof VEHICLE_CONDITIONS)[number];
  registration?: (typeof REGISTRATIONS)[number];
  serviceType?: string;
  availability?: (typeof AVAILABILITY)[number];
};

/** Another reading of the same words (22e "buy or repair?", 22f "Mustang could also mean…"). */
export type Alternative = {
  lane: Lane;
  /** Short, user-facing: "Generator repair", "Sneakers". */
  label: string;
  keywords: string;
  filters: Filters;
  /** Live listings matching it where the buyer is browsing (filled per request). */
  count?: number;
  /** Cheapest of those, kobo. */
  fromKobo?: number | null;
};

export type Interpretation = {
  /** "ai" = Claude read it; "rules" = the keyword fallback (no key, timeout, or budget). */
  source: "ai" | "rules";
  lane: Lane | null;
  /** The words left for full-text matching once the filters took what they could. */
  keywords: string;
  filters: Filters;
  /** The banner sentence; **double asterisks** mark the bold span (13e). */
  summary: string;
  /** True when the lane is a genuine toss-up: show `alternatives` as a choice (22e). */
  tossUp: boolean;
  alternatives: Alternative[];
  /** Photo search only: what the photo shows ("Sony WH-1000XM4"). */
  itemName?: string;
};

// ── Canonicalisers ──────────────────────────────────────────────────────────

const lc = (s: string) => s.trim().toLowerCase();

function pick<T extends string>(allowed: readonly T[], v: unknown): T | undefined {
  if (typeof v !== "string") return undefined;
  const k = lc(v).replace(/[\s-]+/g, "_");
  return allowed.find((a) => a === k);
}

function int(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  return r >= min && r <= max ? r : undefined;
}

export function canonGoodsCategory(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const k = lc(v);
  return GOODS_CATEGORIES.find((c) => c.slug === k || lc(c.label) === k)?.slug;
}

/** A service type (and its group), matched case-insensitively against the catalogue. */
export function canonServiceType(v: unknown): { group: string; type: string } | undefined {
  if (typeof v !== "string") return undefined;
  const k = lc(v);
  for (const g of SERVICE_CATALOG) {
    const t = g.types.find((t) => lc(t) === k);
    if (t) return { group: g.group, type: t };
  }
  return undefined;
}

export function canonServiceGroup(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return SERVICE_CATALOG.find((g) => lc(g.group) === lc(v))?.group;
}

export function canonMake(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const k = lc(v).replace(/[\s-]+/g, "");
  return VEHICLE_CATALOG.find((m) => lc(m.make).replace(/[\s-]+/g, "") === k)?.make;
}

/**
 * Place a state and/or area against the region tree. An area on its own resolves when
 * exactly one state has it; a state on its own is fine; anything unknown is dropped.
 */
export function canonPlace(state: unknown, city: unknown): { state?: string; city?: string } {
  const s = typeof state === "string" ? NG_REGIONS.find((r) => lc(r.state) === lc(state)) : undefined;
  if (typeof city === "string" && city.trim()) {
    const regions = s ? [s] : NG_REGIONS;
    const hits = regions.flatMap((r) =>
      r.areas.filter((a) => lc(a.city) === lc(city)).map((a) => ({ state: r.state, city: a.city })),
    );
    if (hits.length === 1) return hits[0]!;
  }
  return s ? { state: s.state } : {};
}

/**
 * Check every filter against the lane it belongs to; drop anything that doesn't fit.
 * Filters from another lane are dropped too (a "2-bed" can't narrow a phone search).
 */
export function normalizeFilters(lane: Lane | null, raw: Record<string, unknown>): Filters {
  const f: Filters = {};
  const naira = (v: unknown) => int(v, 0, 100_000_000_000);
  const minN = naira(raw.minPriceNaira);
  const maxN = naira(raw.maxPriceNaira);
  if (minN != null) f.minPrice = minN * 100;
  if (maxN != null && maxN > 0) f.maxPrice = maxN * 100;
  if (f.minPrice != null && f.maxPrice != null && f.minPrice > f.maxPrice) delete f.minPrice;

  Object.assign(f, canonPlace(raw.state, raw.city));

  if (lane === "goods") {
    const cat = canonGoodsCategory(raw.category);
    if (cat) f.category = cat;
    const cond = pick(CONDITIONS, raw.condition);
    if (cond) f.condition = cond;
  }
  if (lane === "property") {
    const pt = pick(PROPERTY_TYPES, raw.propertyType);
    if (pt) f.propertyType = pt;
    const dt = pick(DEAL_TYPES, raw.dealType);
    if (dt) f.dealType = dt;
    const beds = int(raw.minBeds, 1, 50);
    if (beds != null && pt !== "land") f.minBeds = beds;
  }
  if (lane === "vehicles") {
    const make = canonMake(raw.make);
    if (make) f.make = make;
    if (typeof raw.model === "string" && raw.model.trim() && make) {
      const known = VEHICLE_CATALOG.find((m) => m.make === make)?.models.find((m) => lc(m.name) === lc(raw.model as string));
      f.model = known?.name ?? raw.model.trim().slice(0, 40);
    }
    const yMin = int(raw.minYear, MIN_YEAR, maxYear());
    const yMax = int(raw.maxYear, MIN_YEAR, maxYear());
    if (yMin != null) f.minYear = yMin;
    if (yMax != null && (yMin == null || yMax >= yMin)) f.maxYear = yMax;
    const km = int(raw.maxMileageKm, 1, 2_000_000);
    if (km != null) f.maxMileageKm = km;
    const t = pick(TRANSMISSIONS, raw.transmission);
    if (t) f.transmission = t;
    const fu = pick(FUELS, raw.fuel);
    if (fu) f.fuel = fu;
    const b = pick(BODIES, raw.body);
    if (b) f.body = b;
    const vc = pick(VEHICLE_CONDITIONS, raw.vehicleCondition);
    if (vc) f.vehicleCondition = vc;
    const reg = pick(REGISTRATIONS, raw.registration);
    if (reg) f.registration = reg;
  }
  if (lane === "services") {
    const st = canonServiceType(raw.serviceType);
    if (st) {
      f.serviceType = st.type;
      f.category = st.group;
    } else {
      const g = canonServiceGroup(raw.category);
      if (g) f.category = g;
    }
    const av = pick(AVAILABILITY, raw.availability);
    if (av) f.availability = av;
  }
  return f;
}

/** Keywords as the full-text search should see them: trimmed, collapsed, bounded. */
export function cleanKeywords(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[^\p{L}\p{N}\s.+'&-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

// ── The banner sentence ─────────────────────────────────────────────────────

/** ₦ amount, compact: ₦850k, ₦4m, ₦2.5m, ₦12,000. */
export function naira(kobo: number): string {
  const n = kobo / 100;
  if (n >= 1_000_000) return `₦${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}m`;
  if (n >= 10_000) return `₦${Math.round(n / 1000)}k`;
  return `₦${n.toLocaleString("en-NG")}`;
}

const VEHICLE_COND_WORDS: Record<string, string> = {
  brand_new: "Brand new",
  foreign_used: "Foreign used",
  nigerian_used: "Nigerian used",
};

/**
 * "Showing **homes for rent** · 2+ bed · Lekki · ≤₦4m". The bold span says what kind
 * of thing; then each applied facet; then where.
 */
export function buildSummary(lane: Lane | null, f: Filters, keywords: string): string {
  const what = (() => {
    switch (lane) {
      case "property": {
        const thing = f.propertyType === "land" ? "land"
          : f.propertyType === "shop" || f.propertyType === "office" || f.propertyType === "commercial" ? `${f.propertyType === "commercial" ? "commercial space" : f.propertyType + "s"}`
          : f.propertyType === "apartment" ? "apartments"
          : f.propertyType === "house" ? "houses"
          : "homes";
        return f.dealType === "shortlet" ? `shortlets` : f.dealType === "sale" ? `${thing} for sale` : f.dealType === "rent" ? `${thing} for rent` : thing;
      }
      case "vehicles": return "vehicles for sale";
      case "services": return f.serviceType ? f.serviceType.toLowerCase() : f.category ? f.category.toLowerCase() : "services";
      case "goods": {
        const c = GOODS_CATEGORIES.find((c) => c.slug === f.category);
        return c ? c.label.toLowerCase() : "items for sale";
      }
      default: return "everything";
    }
  })();
  const parts: string[] = [`**${what}**`];
  if (lane === "vehicles") {
    const mm = [f.make, f.model].filter(Boolean).join(" ");
    if (mm) parts.push(mm);
    if (f.minYear && f.maxYear) parts.push(f.minYear === f.maxYear ? `${f.minYear}` : `${f.minYear}–${f.maxYear}`);
    else if (f.minYear) parts.push(`${f.minYear}+`);
    else if (f.maxYear) parts.push(`up to ${f.maxYear}`);
    if (f.vehicleCondition) parts.push(VEHICLE_COND_WORDS[f.vehicleCondition]!);
    if (f.transmission) parts.push(f.transmission === "automatic" ? "Auto" : "Manual");
    if (f.body) parts.push(f.body === "suv" ? "SUV" : f.body[0]!.toUpperCase() + f.body.slice(1));
    if (f.fuel) parts.push(f.fuel[0]!.toUpperCase() + f.fuel.slice(1));
    if (f.maxMileageKm) parts.push(`≤${Math.round(f.maxMileageKm / 1000)}k km`);
  } else if (keywords) {
    parts.push(`“${keywords}”`);
  }
  if (f.minBeds) parts.push(`${f.minBeds}+ bed`);
  if (f.condition) parts.push(f.condition[0]!.toUpperCase() + f.condition.slice(1));
  if (f.availability) parts.push(f.availability === "today" ? "Available today" : f.availability === "this_week" ? "This week" : "Emergency");
  if (f.city) parts.push(f.city);
  else if (f.state) parts.push(f.state);
  if (f.minPrice != null && f.maxPrice != null) parts.push(`${naira(f.minPrice)}–${naira(f.maxPrice)}`);
  else if (f.maxPrice != null) parts.push(`≤${naira(f.maxPrice)}`);
  else if (f.minPrice != null) parts.push(`≥${naira(f.minPrice)}`);
  return "Showing " + parts.join(" · ");
}
