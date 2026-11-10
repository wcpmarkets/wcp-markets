/**
 * Phase 3 D — the Services lane's reference data. Groups and their examples come
 * from the design's category taxonomy (WCP Category Taxonomy.html, lane 04); the
 * group is the listing's `category`, the type sits in `attributes.serviceType`
 * (13i: "Home services → Plumbing").
 */

export const SERVICE_CATALOG: readonly { group: string; types: readonly string[] }[] = [
  { group: "Home Services", types: ["Plumbing", "Electrical", "Cleaning", "Fumigation", "AC & refrigeration", "Generator repair", "Painting", "Carpentry"] },
  { group: "Repair & Construction", types: ["Building", "Tiling", "Roofing", "Welding & fabrication", "Interior finishing", "Phone & laptop repair"] },
  { group: "Events", types: ["Event planning", "Catering", "Photography & video", "DJ & music", "Decoration", "Equipment rental"] },
  { group: "Beauty & Wellness", types: ["Hair", "Makeup", "Nails", "Barbing", "Massage & spa", "Fitness training"] },
  { group: "Professional", types: ["Legal", "Accounting", "Design", "Tutoring", "IT & software", "Writing & translation"] },
  { group: "Automotive Services", types: ["Mechanic", "Auto electrician", "Panel & paint", "Detailing", "Towing"] },
  { group: "Logistics & Movers", types: ["Moving", "Dispatch & delivery", "Haulage"] },
];

/** A listing may name its own type within a group ("Other" in the picker). */
export const OTHER_TYPE = "Other";

export const AVAILABILITY = ["today", "this_week", "emergency"] as const;

/** Coverage rings a provider can pick around their area (13i); or anywhere in the state. */
export const COVERAGE_KM = [2, 5, 10] as const;

export const MAX_RATE_ITEMS = 12;

export function isServiceGroup(group: string): boolean {
  return SERVICE_CATALOG.some((g) => g.group === group);
}
