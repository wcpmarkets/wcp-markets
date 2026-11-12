/**
 * Phase 3I — the keyword interpreter. It is what search runs on with no Anthropic key, and
 * the fallback whenever Claude is slow, refuses, errors, or the daily AI budget is used
 * up. It is deliberately plain: prices ("under 3m", "₦200k-500k"), bedrooms ("2-bed"),
 * places from the region tree, car makes and models, service types, goods categories,
 * and a handful of lane words. Whatever it recognises becomes a filter and is removed
 * from the text; the rest stays as keywords for full-text matching.
 *
 * It never invents a toss-up it can't back. The one ambiguity it knows is a bare object
 * that is both sold and serviced ("generator", "AC", "phone"), with no buy/fix verb.
 */
import { NG_REGIONS } from "../data/ng-regions.js";
import { SERVICE_CATALOG } from "../data/services.js";
import { VEHICLE_CATALOG } from "../data/vehicles.js";
import type { Lane } from "./shape.js";

export type RawReading = {
  lane: Lane | null;
  keywords: string;
  filters: Record<string, unknown>;
  tossUp: boolean;
  alternatives: { lane: Lane; label: string; keywords: string; filters: Record<string, unknown> }[];
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(s)}(?![\\p{L}\\p{N}])`, "iu");

/** "3m" → 3,000,000; "450k" → 450,000; "1.5 million" → 1,500,000; "200,000" → 200,000. */
function amount(num: string, unit: string | undefined): number | null {
  const n = Number(num.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? "").toLowerCase();
  if (u.startsWith("m")) return Math.round(n * 1_000_000);
  if (u.startsWith("b")) return Math.round(n * 1_000_000_000);
  if (u === "k" || u.startsWith("th")) return Math.round(n * 1000);
  return Math.round(n);
}

const NUM = String.raw`₦?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|mil|million|b|bn|billion|thousand)?\b`;

const GOODS_WORDS: [RegExp, string][] = [
  [/\b(i?phones?|smartphones?|samsung galaxy|tecno|infinix|tablets?|ipads?)\b/i, "phones"],
  [/\b(laptops?|macbooks?|notebooks?|chromebooks?)\b/i, "laptops"],
  [/\b(desktops?|computers?|pcs?|monitors?|imacs?)\b/i, "computers"],
  [/\b(tvs?|televisions?|speakers?|soundbars?|headphones?|earbuds|airpods)\b/i, "tv-audio"],
  [/\b(ps[345]|playstation|xbox|nintendo|switch|consoles?)\b/i, "gaming"],
  [/\b(shoes?|sneakers?|dress(es)?|bags?|watch(es)?|clothes|shirts?|jeans)\b/i, "fashion"],
  [/\b(generators?|fridges?|freezers?|refrigerators?|washing machines?|microwaves?|inverters?|air ?conditioners?|ac units?)\b/i, "appliances"],
  [/\b(sofas?|beds?frames?|mattress(es)?|tables?|chairs?|wardrobes?|furniture)\b/i, "furniture"],
  [/\b(perfumes?|creams?|wigs?|makeup kits?)\b/i, "health-beauty"],
  [/\b(prams?|strollers?|cots?|toys?|diapers)\b/i, "babies-kids"],
  [/\b(treadmills?|bicycles?|bikes?|dumbbells?|footballs?)\b/i, "sports"],
  [/\b(drills?|toolbox|tools?|welding machines?)\b/i, "tools"],
  [/\b(tyres?|tires?|car batter(y|ies)|spare parts?|rims?)\b/i, "vehicle-parts"],
];

const PROPERTY_TYPE_WORDS: [RegExp, string][] = [
  [/\b(apartments?|flats?|mini ?flats?|self[- ]?con(tain(ed)?)?|studios?)\b/i, "apartment"],
  [/\b(houses?|duplex(es)?|bungalows?|terraces?|mansions?)\b/i, "house"],
  [/\b(land|plots?|acres?)\b/i, "land"],
  [/\b(shops?)\b/i, "shop"],
  [/\b(offices?|office space)\b/i, "office"],
  [/\b(warehouses?|commercial)\b/i, "commercial"],
];

/** Bare objects that are both sold and repaired — the 22e toss-up. */
const BOTH_WAYS: { re: RegExp; category: string; serviceType: string; buy: string; fix: string }[] = [
  { re: /^generators?$/i, category: "appliances", serviceType: "Generator repair", buy: "Buy a generator", fix: "Generator repair" },
  { re: /^(ac|air ?conditioners?)$/i, category: "appliances", serviceType: "AC & refrigeration", buy: "Buy an AC", fix: "AC repair" },
  { re: /^(fridges?|refrigerators?|freezers?)$/i, category: "appliances", serviceType: "AC & refrigeration", buy: "Buy a fridge", fix: "Fridge repair" },
  { re: /^phones?$/i, category: "phones", serviceType: "Phone & laptop repair", buy: "Buy a phone", fix: "Phone repair" },
  { re: /^laptops?$/i, category: "laptops", serviceType: "Phone & laptop repair", buy: "Buy a laptop", fix: "Laptop repair" },
];

/** Words that say "a service", mapped to the catalogue type they mean. */
const SERVICE_WORDS: [RegExp, string][] = [
  [/\bplumb(er|ing)\b/i, "Plumbing"],
  [/\belectrician\b/i, "Electrical"],
  [/\b(cleaner|cleaning)\b/i, "Cleaning"],
  [/\bfumigat(e|ion|or)\b/i, "Fumigation"],
  [/\bpainter\b/i, "Painting"],
  [/\bcarpenter\b/i, "Carpentry"],
  [/\b(mechanic|vulcani[sz]er)\b/i, "Mechanic"],
  [/\b(barb(er|ing))\b/i, "Barbing"],
  [/\b(hairdresser|braid(s|ing)?|stylist)\b/i, "Hair"],
  [/\bmakeup artist|\bmua\b/i, "Makeup"],
  [/\b(photographer|videographer)\b/i, "Photography & video"],
  [/\b(caterer|catering)\b/i, "Catering"],
  [/\b(dj)\b/i, "DJ & music"],
  [/\b(tutor|lesson teacher)\b/i, "Tutoring"],
  [/\b(movers?|relocation)\b/i, "Moving"],
  [/\b(dispatch rider|delivery rider)\b/i, "Dispatch & delivery"],
  [/\b(lawyer)\b/i, "Legal"],
  [/\b(accountant)\b/i, "Accounting"],
  [/\b(tow(ing)? truck|towing)\b/i, "Towing"],
];

/** "Fix my X": the object decides the trade. */
const FIX_OBJECTS: [RegExp, string][] = [
  [/\b(ac|air ?conditioners?|fridges?|freezers?|refrigerators?)\b/i, "AC & refrigeration"],
  [/\b(generators?|gen)\b/i, "Generator repair"],
  [/\b(phones?|iphones?|laptops?|macbooks?|screens?)\b/i, "Phone & laptop repair"],
  [/\b(cars?|engines?|brakes?)\b/i, "Mechanic"],
  [/\b(pipes?|taps?|toilets?|sinks?)\b/i, "Plumbing"],
  [/\b(wiring|sockets?|lights?)\b/i, "Electrical"],
];

const STOP = /\b(i|im|my|warranty|i'm|want|need|looking|for|a|an|the|to|buy|get|some|any|me|please|in|at|around|near|cheap|good|nice|with|of|and|or|that|is|on|sale|rent|price|naira|show|find)\b/gi;

export function readByRules(q: string, laneHint?: Lane | null): RawReading {
  let text = ` ${q.trim()} `;
  const f: Record<string, unknown> = {};
  const cut = (re: RegExp) => { text = text.replace(re, " "); };
  let lane: Lane | null = laneHint ?? null;
  const vote = (l: Lane) => { if (!laneHint && !lane) lane = l; };

  // Prices.
  let m = new RegExp(String.raw`(?:between|from)\s*${NUM}\s*(?:and|to|-|–)\s*${NUM}`, "i").exec(text)
    ?? new RegExp(String.raw`${NUM}\s*(?:-|–|to)\s*${NUM}`, "i").exec(text);
  if (m) {
    const lo = amount(m[1]!, m[2] ?? m[4]);
    const hi = amount(m[3]!, m[4]);
    if (lo != null && hi != null) { f.minPriceNaira = lo; f.maxPriceNaira = hi; cut(new RegExp(esc(m[0]), "i")); }
  }
  m = new RegExp(String.raw`(?:under|below|less than|max(?:imum)?|not more than|up to|upto|within|≤|<)\s*${NUM}`, "i").exec(text);
  if (m) { const v = amount(m[1]!, m[2]); if (v != null) { f.maxPriceNaira = v; cut(new RegExp(esc(m[0]), "i")); } }
  m = new RegExp(String.raw`(?:over|above|more than|at least|min(?:imum)?|≥|>)\s*${NUM}`, "i").exec(text);
  if (m) { const v = amount(m[1]!, m[2]); if (v != null) { f.minPriceNaira = v; cut(new RegExp(esc(m[0]), "i")); } }
  // A bare "₦250k" with no bound word reads as a ceiling.
  m = /₦\s*(\d[\d,]*(?:\.\d+)?)\s*(k|m|million)?\b/i.exec(text);
  if (m && f.maxPriceNaira == null) { const v = amount(m[1]!, m[2]); if (v != null) { f.maxPriceNaira = v; cut(new RegExp(esc(m[0]), "i")); } }
  // A price period says what kind of deal it is ("4m a year" = rent, "50k a night" =
  // shortlet). Read it before cutting it, so it never lingers as a keyword ("year").
  const perNight = /\/\s*night\b|\b(a|per|each)\s+night\b|\bnightly\b/i.test(text);
  const perTerm = /\/\s*(yr|year|annum|month|mo)\b|\b(a|per|every|each)\s+(year|yr|annum|month)\b|\b(yearly|annually|monthly|per annum)\b/i.test(text);
  // "600k yearly", "50k a night": with a period beside it, a bare amount is the price.
  if (f.maxPriceNaira == null && (perNight || perTerm)) {
    m = /\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|million)\b/i.exec(text);
    if (m) { const v = amount(m[1]!, m[2]); if (v != null) { f.maxPriceNaira = v; cut(new RegExp(esc(m[0]), "i")); } }
  }
  cut(/\/\s*(yr|year|annum|month|mo|night)\b|\b(a|per|every|each)\s+(year|yr|annum|month|night)\b|\b(yearly|annually|monthly|nightly|per annum)\b/gi);

  // Places: areas first (more specific), then states.
  for (const r of NG_REGIONS) {
    for (const a of r.areas) {
      if (!f.city && word(a.city).test(text)) { f.city = a.city; f.state = r.state; cut(word(a.city)); }
    }
  }
  if (!f.state) {
    for (const r of NG_REGIONS) {
      const names = [r.state, ...(/FCT/.test(r.state) ? ["Abuja", "FCT"] : [])];
      for (const n of names) if (word(n).test(text)) { f.state = r.state; cut(word(n)); }
    }
  }

  // Property.
  m = /\b(\d{1,2})\s*-?\s*(bed(room)?s?|br|bd)\b/i.exec(text);
  if (m) { f.minBeds = Number(m[1]); vote("property"); cut(new RegExp(esc(m[0]), "i")); }
  if (/\bshort[- ]?lets?\b|\bairbnb\b/i.test(text) || perNight) { f.dealType = "shortlet"; vote("property"); cut(/\bshort[- ]?lets?\b|\bairbnb\b/gi); }
  else if ((/\b(to let|for rent|rent(al)?|lease)\b/i.test(text) || perTerm) && !/\b(car|equipment)\b/i.test(text)) {
    const hasPropertyNoun = PROPERTY_TYPE_WORDS.some(([re]) => re.test(text)) || f.minBeds != null;
    if (hasPropertyNoun || lane === "property") { f.dealType = "rent"; vote("property"); cut(/\b(to let|for rent|rental|rent|lease)\b/gi); }
  } else if (/\bfor sale\b/i.test(text) && PROPERTY_TYPE_WORDS.some(([re]) => re.test(text))) f.dealType = "sale";
  for (const [re, t] of PROPERTY_TYPE_WORDS) {
    if (re.test(text) && (lane === "property" || lane == null || f.minBeds != null)) {
      if (!(t === "shop" && lane && lane !== "property")) { f.propertyType = t; vote("property"); cut(re); break; }
    }
  }

  // Vehicles: a known make, then its model; years; gearbox; "tokunbo".
  for (const mk of VEHICLE_CATALOG) {
    const names = [mk.make, ...(mk.make === "Mercedes-Benz" ? ["Mercedes", "Benz"] : []), ...(mk.make === "Land Rover" ? ["Range Rover"] : [])];
    const hit = names.find((n) => word(n).test(text));
    if (hit) {
      f.make = mk.make; vote("vehicles"); cut(word(hit));
      const model = mk.models.find((md) => word(md.name).test(text));
      if (model) { f.model = model.name; cut(word(model.name)); }
      break;
    }
  }
  if (!f.make) {
    for (const mk of VEHICLE_CATALOG) {
      const model = mk.models.find((md) => md.name.length > 2 && word(md.name).test(text));
      if (model) { f.make = mk.make; f.model = model.name; vote("vehicles"); cut(word(model.name)); break; }
    }
  }
  if (/\b(cars?|vehicles?|jeeps?|suvs?|buses|pickups?|trucks?|motors?)\b/i.test(text)) {
    vote("vehicles");
    if (/\bsuvs?|jeeps?\b/i.test(text)) f.body = "suv";
    cut(/\b(cars?|vehicles?|jeeps?|suvs?|motors?)\b/gi);
  }
  if (lane === "vehicles" || f.make) {
    const y = /\b(19[89]\d|20[0-3]\d)\b(\s*(and above|upwards|\+|or newer))?/i.exec(text);
    if (y) { if (y[2]) f.minYear = Number(y[1]); else { f.minYear = Number(y[1]); f.maxYear = Number(y[1]); } cut(new RegExp(esc(y[0]), "i")); }
    if (/\b(auto(matic)?)\b/i.test(text)) { f.transmission = "automatic"; cut(/\bauto(matic)?\b/gi); }
    if (/\bmanual\b/i.test(text)) { f.transmission = "manual"; cut(/\bmanual\b/gi); }
    if (/\b(tokunbo|foreign[- ]used)\b/i.test(text)) { f.vehicleCondition = "foreign_used"; cut(/\b(tokunbo|foreign[- ]used)\b/gi); }
    if (/\b(nigerian[- ]used|naija used)\b/i.test(text)) { f.vehicleCondition = "nigerian_used"; cut(/\b(nigerian[- ]used|naija used)\b/gi); }
    if (/\bbrand[- ]new\b/i.test(text)) { f.vehicleCondition = "brand_new"; cut(/\bbrand[- ]new\b/gi); }
    for (const fu of ["diesel", "hybrid", "electric"]) if (word(fu).test(text)) { f.fuel = fu; cut(word(fu)); }
  }

  // Services: a named trade, or a fix-verb with an object.
  const fixVerb = /\b(repair(s|er|ing)?|fix(ing|er)?|servic(e|ing)|install(ation|er)?)\b/i;
  for (const [re, type] of SERVICE_WORDS) {
    if (re.test(text)) { f.serviceType = type; vote("services"); cut(re); break; }
  }
  if (!f.serviceType && fixVerb.test(text)) {
    const t = FIX_OBJECTS.find(([re]) => re.test(text))?.[1] ?? SERVICE_CATALOG.flatMap((g) => g.types).find((t) => t.toLowerCase().split(/[ &]+/).some((w) => w.length > 3 && word(w).test(text)));
    if (t) { f.serviceType = t; vote("services"); for (const [re] of FIX_OBJECTS) cut(new RegExp(re.source, "gi")); }
    else vote("services");
    cut(fixVerb);
  }

  // Goods: a category word; condition.
  if (lane === "goods" || lane == null) {
    for (const [re, cat] of GOODS_WORDS) if (re.test(text)) { f.category = cat; vote("goods"); break; }
    // The category says these generic nouns already; brand words (iPhone, PS5) stay to match titles.
    if (f.category) cut(/\b(phones?|smartphones?|tablets?|laptops?|notebooks?|computers?|desktops?|pcs?|tvs?|televisions?|consoles?|furniture|tools?|appliances?)\b/gi);
    if (/\b(brand[- ]new|new)\b/i.test(text)) { f.condition = "new"; cut(/\b(brand[- ]new|new)\b/gi); }
    else if (/\b(uk[- ]used|used|fairly used|second ?hand)\b/i.test(text)) { f.condition = "used"; cut(/\b(uk[- ]used|used|fairly used|second ?hand)\b/gi); }
    else if (/\brefurb(ished)?\b/i.test(text)) { f.condition = "refurbished"; cut(/\brefurb(ished)?\b/gi); }
  }

  // The bare both-ways object (22e) — only with no lane, verb, or other facet to go on.
  const bare = q.trim();
  const both = !laneHint && Object.keys(f).every((k) => k === "category" || k === "state" || k === "city")
    ? BOTH_WAYS.find((b) => b.re.test(bare.replace(/\b(in|near)\b.*$/i, "").trim()))
    : undefined;

  const keywords = text.replace(STOP, " ").replace(/\s+/g, " ").trim();
  if (both) {
    const place = { state: f.state, city: f.city };
    return {
      lane: null,
      keywords,
      filters: place,
      tossUp: true,
      alternatives: [
        { lane: "goods", label: both.buy, keywords, filters: { ...place, category: both.category } },
        { lane: "services", label: both.fix, keywords: "", filters: { ...place, serviceType: both.serviceType } },
      ],
    };
  }
  return { lane, keywords, filters: f, tossUp: false, alternatives: [] };
}
