/**
 * The Vehicles lane's vocabulary and make/model catalogue (design 13h, 13e-filters-
 * vehicles). The catalogue prefills body and fuel from make + model ("✦ from Corolla
 * 2011") — the seller confirms or changes them. It's a starting set of what's common
 * on Nigerian roads, not an exhaustive register: a make outside it is posted as
 * "Other" with a free-text model.
 *
 * Served to clients by GET /vehicles/catalog, so the app doesn't carry a copy.
 */

export const TRANSMISSIONS = ["automatic", "manual"] as const;
export const FUELS = ["petrol", "diesel", "hybrid", "electric"] as const;
export const BODIES = ["saloon", "suv", "hatchback", "bus", "pickup", "coupe", "minivan", "truck"] as const;
export const VEHICLE_CONDITIONS = ["brand_new", "foreign_used", "nigerian_used"] as const;
export const REGISTRATIONS = ["registered", "unregistered", "custom_papers"] as const;

export type Body = (typeof BODIES)[number];
export type Fuel = (typeof FUELS)[number];

/** The make outside the catalogue; its model is free text. */
export const OTHER_MAKE = "Other";

/** Earliest model year accepted; the latest is next year (new models arrive early). */
export const MIN_YEAR = 1980;
export const maxYear = () => new Date().getUTCFullYear() + 1;

type Model = { name: string; body: Body; fuel?: Fuel };

const m = (name: string, body: Body, fuel?: Fuel): Model => ({ name, body, fuel });

export const VEHICLE_CATALOG: { make: string; models: Model[] }[] = [
  { make: "Toyota", models: [m("Corolla", "saloon"), m("Camry", "saloon"), m("Avalon", "saloon"), m("Yaris", "hatchback"), m("RAV4", "suv"), m("Highlander", "suv"), m("Land Cruiser", "suv"), m("Prado", "suv"), m("4Runner", "suv"), m("Venza", "suv"), m("Sienna", "minivan"), m("Hiace", "bus"), m("Hilux", "pickup"), m("Tacoma", "pickup")] },
  { make: "Lexus", models: [m("ES 350", "saloon"), m("IS 250", "saloon"), m("RX 350", "suv"), m("GX 460", "suv"), m("LX 570", "suv"), m("NX 200t", "suv")] },
  { make: "Honda", models: [m("Accord", "saloon"), m("Civic", "saloon"), m("CR-V", "suv"), m("Pilot", "suv"), m("Odyssey", "minivan"), m("Fit", "hatchback")] },
  { make: "Mercedes-Benz", models: [m("C-Class", "saloon"), m("E-Class", "saloon"), m("S-Class", "saloon"), m("GLK", "suv"), m("GLE", "suv"), m("ML", "suv"), m("G-Class", "suv"), m("Sprinter", "bus", "diesel")] },
  { make: "Hyundai", models: [m("Elantra", "saloon"), m("Sonata", "saloon"), m("Accent", "saloon"), m("Tucson", "suv"), m("Santa Fe", "suv"), m("H-1", "bus", "diesel")] },
  { make: "Kia", models: [m("Rio", "hatchback"), m("Picanto", "hatchback"), m("Cerato", "saloon"), m("Optima", "saloon"), m("Sportage", "suv"), m("Sorento", "suv")] },
  { make: "Nissan", models: [m("Altima", "saloon"), m("Sentra", "saloon"), m("Almera", "saloon"), m("Pathfinder", "suv"), m("Rogue", "suv"), m("Murano", "suv"), m("Patrol", "suv"), m("Navara", "pickup", "diesel"), m("Urvan", "bus", "diesel")] },
  { make: "Ford", models: [m("Focus", "saloon"), m("Fusion", "saloon"), m("Edge", "suv"), m("Escape", "suv"), m("Explorer", "suv"), m("Ranger", "pickup", "diesel"), m("Transit", "bus", "diesel")] },
  { make: "Peugeot", models: [m("301", "saloon"), m("406", "saloon"), m("508", "saloon"), m("3008", "suv"), m("5008", "suv"), m("Partner", "minivan")] },
  { make: "Volkswagen", models: [m("Golf", "hatchback"), m("Jetta", "saloon"), m("Passat", "saloon"), m("Tiguan", "suv"), m("Touareg", "suv"), m("Transporter", "bus", "diesel")] },
  { make: "BMW", models: [m("3 Series", "saloon"), m("5 Series", "saloon"), m("X3", "suv"), m("X5", "suv"), m("X6", "suv")] },
  { make: "Mitsubishi", models: [m("Lancer", "saloon"), m("Outlander", "suv"), m("Pajero", "suv"), m("L200", "pickup", "diesel")] },
  { make: "Mazda", models: [m("Mazda3", "saloon"), m("Mazda6", "saloon"), m("CX-5", "suv"), m("CX-9", "suv")] },
  { make: "Suzuki", models: [m("Swift", "hatchback"), m("Ciaz", "saloon"), m("Vitara", "suv"), m("Jimny", "suv")] },
  { make: "Land Rover", models: [m("Range Rover", "suv"), m("Range Rover Sport", "suv"), m("Discovery", "suv"), m("Defender", "suv")] },
  { make: "Acura", models: [m("TL", "saloon"), m("MDX", "suv"), m("RDX", "suv"), m("ZDX", "suv")] },
  { make: "Innoson", models: [m("IVM Fox", "hatchback"), m("IVM G5", "suv"), m("IVM Umu", "suv"), m("IVM Caris", "saloon")] },
  { make: "Chevrolet", models: [m("Cruze", "saloon"), m("Malibu", "saloon"), m("Equinox", "suv"), m("Captiva", "suv")] },
  { make: "Jeep", models: [m("Wrangler", "suv"), m("Grand Cherokee", "suv"), m("Compass", "suv")] },
  { make: "Tata", models: [m("LP 713", "truck", "diesel"), m("Xenon", "pickup", "diesel")] },
];

const byMake = new Map(VEHICLE_CATALOG.map((e) => [e.make, e.models]));

export function isKnownMake(make: string): boolean {
  return make === OTHER_MAKE || byMake.has(make);
}

/** The catalogue entry for a make + model, if it's in the catalogue. */
export function catalogModel(make: string, model: string): Model | undefined {
  return byMake.get(make)?.find((x) => x.name.toLowerCase() === model.toLowerCase());
}
