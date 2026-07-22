/**
 * Nigeria's 36 states + the FCT, each with the areas people actually trade in,
 * and an approximate centre for every area.
 *
 * This is the ONE canonical location list: the API validates listing creation
 * against it, the facets endpoint returns it (with counts) so clients never ship
 * their own copy, and the centres anchor the distance-radius filter — a buyer who
 * picks "Yaba · 10 km" gets listings within 10 km of the point below.
 *
 * The area lists are curated, not exhaustive, and deliberately match how sellers
 * describe themselves (Lekki, not Eti-Osa). Coordinates are area centres good to
 * roughly a kilometre — ample for a 5–25 km ring, and never precise enough to
 * locate anyone. Add areas freely; the only rule is that a name is stable once
 * shipped, because listings store it.
 *
 * CHANGING THIS FILE? The Android app carries a generated copy for offline use
 * (assets/ng-regions.json). Regenerate it, or the picker will disagree with the
 * server whenever the network is down:
 *   cd ../wcp-markets-android && npx tsx tools/gen-regions.ts
 */

export type Area = { city: string; lat: number; lng: number };
export type Region = { state: string; areas: Area[] };

export const NG_REGIONS: Region[] = [
  {
    state: "Abia",
    areas: [
      { city: "Umuahia", lat: 5.525, lng: 7.494 },
      { city: "Aba", lat: 5.107, lng: 7.367 },
      { city: "Ohafia", lat: 5.617, lng: 7.833 },
      { city: "Arochukwu", lat: 5.386, lng: 7.913 },
    ],
  },
  {
    state: "Abuja (FCT)",
    areas: [
      { city: "Wuse", lat: 9.076, lng: 7.47 },
      { city: "Garki", lat: 9.032, lng: 7.489 },
      { city: "Maitama", lat: 9.086, lng: 7.497 },
      { city: "Asokoro", lat: 9.041, lng: 7.526 },
      { city: "Central Area", lat: 9.058, lng: 7.492 },
      { city: "Gwarinpa", lat: 9.109, lng: 7.406 },
      { city: "Jabi", lat: 9.073, lng: 7.427 },
      { city: "Utako", lat: 9.069, lng: 7.442 },
      { city: "Life Camp", lat: 9.096, lng: 7.424 },
      { city: "Lugbe", lat: 8.968, lng: 7.383 },
      { city: "Kubwa", lat: 9.156, lng: 7.325 },
      { city: "Nyanya", lat: 9.0, lng: 7.573 },
      { city: "Karu", lat: 9.001, lng: 7.598 },
      { city: "Kuje", lat: 8.879, lng: 7.227 },
      { city: "Gwagwalada", lat: 8.943, lng: 7.081 },
    ],
  },
  {
    state: "Adamawa",
    areas: [
      { city: "Yola", lat: 9.204, lng: 12.495 },
      { city: "Jimeta", lat: 9.28, lng: 12.453 },
      { city: "Mubi", lat: 10.268, lng: 13.267 },
      { city: "Numan", lat: 9.463, lng: 12.032 },
    ],
  },
  {
    state: "Akwa Ibom",
    areas: [
      { city: "Uyo", lat: 5.038, lng: 7.909 },
      { city: "Eket", lat: 4.641, lng: 7.929 },
      { city: "Ikot Ekpene", lat: 5.181, lng: 7.714 },
      { city: "Oron", lat: 4.821, lng: 8.234 },
    ],
  },
  {
    state: "Anambra",
    areas: [
      { city: "Awka", lat: 6.21, lng: 7.072 },
      { city: "Onitsha", lat: 6.146, lng: 6.802 },
      { city: "Nnewi", lat: 6.019, lng: 6.914 },
      { city: "Ekwulobia", lat: 6.014, lng: 7.078 },
    ],
  },
  {
    state: "Bauchi",
    areas: [
      { city: "Bauchi", lat: 10.314, lng: 9.844 },
      { city: "Azare", lat: 11.677, lng: 10.194 },
      { city: "Misau", lat: 11.317, lng: 10.464 },
      { city: "Jama'are", lat: 11.669, lng: 9.936 },
    ],
  },
  {
    state: "Bayelsa",
    areas: [
      { city: "Yenagoa", lat: 4.925, lng: 6.264 },
      { city: "Ogbia", lat: 4.686, lng: 6.29 },
      { city: "Sagbama", lat: 5.157, lng: 6.198 },
      { city: "Brass", lat: 4.316, lng: 6.24 },
    ],
  },
  {
    state: "Benue",
    areas: [
      { city: "Makurdi", lat: 7.733, lng: 8.521 },
      { city: "Gboko", lat: 7.323, lng: 9.0 },
      { city: "Otukpo", lat: 7.191, lng: 8.131 },
      { city: "Katsina-Ala", lat: 7.169, lng: 9.286 },
    ],
  },
  {
    state: "Borno",
    areas: [
      { city: "Maiduguri", lat: 11.833, lng: 13.151 },
      { city: "Biu", lat: 10.612, lng: 12.195 },
      { city: "Bama", lat: 11.521, lng: 13.689 },
      { city: "Konduga", lat: 11.654, lng: 13.416 },
    ],
  },
  {
    state: "Cross River",
    areas: [
      { city: "Calabar", lat: 4.982, lng: 8.334 },
      { city: "Ugep", lat: 5.815, lng: 8.081 },
      { city: "Ikom", lat: 5.966, lng: 8.708 },
      { city: "Ogoja", lat: 6.653, lng: 8.797 },
    ],
  },
  {
    state: "Delta",
    areas: [
      { city: "Asaba", lat: 6.198, lng: 6.729 },
      { city: "Warri", lat: 5.516, lng: 5.75 },
      { city: "Ughelli", lat: 5.5, lng: 5.993 },
      { city: "Sapele", lat: 5.879, lng: 5.7 },
      { city: "Agbor", lat: 6.256, lng: 6.194 },
    ],
  },
  {
    state: "Ebonyi",
    areas: [
      { city: "Abakaliki", lat: 6.324, lng: 8.113 },
      { city: "Afikpo", lat: 5.893, lng: 7.936 },
      { city: "Onueke", lat: 6.185, lng: 8.006 },
    ],
  },
  {
    state: "Edo",
    areas: [
      { city: "Benin City", lat: 6.335, lng: 5.628 },
      { city: "Auchi", lat: 7.067, lng: 6.267 },
      { city: "Ekpoma", lat: 6.75, lng: 6.133 },
      { city: "Uromi", lat: 6.7, lng: 6.333 },
    ],
  },
  {
    state: "Ekiti",
    areas: [
      { city: "Ado-Ekiti", lat: 7.622, lng: 5.221 },
      { city: "Ikere-Ekiti", lat: 7.5, lng: 5.233 },
      { city: "Ikole-Ekiti", lat: 7.798, lng: 5.514 },
    ],
  },
  {
    state: "Enugu",
    areas: [
      { city: "Enugu", lat: 6.459, lng: 7.548 },
      { city: "Nsukka", lat: 6.858, lng: 7.393 },
      { city: "Agbani", lat: 6.32, lng: 7.55 },
      { city: "Awgu", lat: 6.077, lng: 7.478 },
    ],
  },
  {
    state: "Gombe",
    areas: [
      { city: "Gombe", lat: 10.289, lng: 11.167 },
      { city: "Kaltungo", lat: 9.821, lng: 11.309 },
      { city: "Billiri", lat: 9.869, lng: 11.226 },
      { city: "Dukku", lat: 10.823, lng: 10.772 },
    ],
  },
  {
    state: "Imo",
    areas: [
      { city: "Owerri", lat: 5.484, lng: 7.035 },
      { city: "Orlu", lat: 5.796, lng: 7.034 },
      { city: "Okigwe", lat: 5.828, lng: 7.35 },
      { city: "Mbaise", lat: 5.552, lng: 7.234 },
    ],
  },
  {
    state: "Jigawa",
    areas: [
      { city: "Dutse", lat: 11.756, lng: 9.339 },
      { city: "Hadejia", lat: 12.449, lng: 10.041 },
      { city: "Gumel", lat: 12.627, lng: 9.388 },
      { city: "Birnin Kudu", lat: 11.456, lng: 9.492 },
    ],
  },
  {
    state: "Kaduna",
    areas: [
      { city: "Kaduna", lat: 10.523, lng: 7.44 },
      { city: "Barnawa", lat: 10.472, lng: 7.43 },
      { city: "Zaria", lat: 11.086, lng: 7.72 },
      { city: "Kafanchan", lat: 9.583, lng: 8.293 },
    ],
  },
  {
    state: "Kano",
    areas: [
      { city: "Kano", lat: 12.0, lng: 8.516 },
      { city: "Fagge", lat: 12.008, lng: 8.516 },
      { city: "Sabon Gari", lat: 12.006, lng: 8.524 },
      { city: "Bichi", lat: 12.234, lng: 8.245 },
      { city: "Wudil", lat: 11.79, lng: 8.839 },
    ],
  },
  {
    state: "Katsina",
    areas: [
      { city: "Katsina", lat: 12.985, lng: 7.617 },
      { city: "Daura", lat: 13.031, lng: 8.317 },
      { city: "Funtua", lat: 11.521, lng: 7.312 },
      { city: "Malumfashi", lat: 11.79, lng: 7.622 },
    ],
  },
  {
    state: "Kebbi",
    areas: [
      { city: "Birnin Kebbi", lat: 12.454, lng: 4.199 },
      { city: "Argungu", lat: 12.745, lng: 4.526 },
      { city: "Yauri", lat: 10.79, lng: 4.755 },
      { city: "Zuru", lat: 11.435, lng: 5.236 },
    ],
  },
  {
    state: "Kogi",
    areas: [
      { city: "Lokoja", lat: 7.802, lng: 6.744 },
      { city: "Okene", lat: 7.551, lng: 6.236 },
      { city: "Idah", lat: 7.111, lng: 6.735 },
      { city: "Kabba", lat: 7.834, lng: 6.071 },
    ],
  },
  {
    state: "Kwara",
    areas: [
      { city: "Ilorin", lat: 8.497, lng: 4.542 },
      { city: "Offa", lat: 8.149, lng: 4.72 },
      { city: "Omu-Aran", lat: 8.139, lng: 5.101 },
      { city: "Jebba", lat: 9.135, lng: 4.834 },
    ],
  },
  {
    state: "Lagos",
    areas: [
      { city: "Ikeja", lat: 6.602, lng: 3.352 },
      { city: "Yaba", lat: 6.51, lng: 3.371 },
      { city: "Lekki", lat: 6.47, lng: 3.585 },
      { city: "Victoria Island", lat: 6.428, lng: 3.424 },
      { city: "Ikoyi", lat: 6.452, lng: 3.435 },
      { city: "Surulere", lat: 6.492, lng: 3.354 },
      { city: "Ajah", lat: 6.468, lng: 3.564 },
      { city: "Apapa", lat: 6.449, lng: 3.359 },
      { city: "Festac", lat: 6.466, lng: 3.28 },
      { city: "Ikorodu", lat: 6.615, lng: 3.508 },
      { city: "Agege", lat: 6.622, lng: 3.325 },
      { city: "Maryland", lat: 6.571, lng: 3.367 },
      { city: "Gbagada", lat: 6.554, lng: 3.386 },
      { city: "Magodo", lat: 6.62, lng: 3.372 },
      { city: "Ojota", lat: 6.586, lng: 3.381 },
      { city: "Alimosho", lat: 6.594, lng: 3.267 },
      { city: "Epe", lat: 6.584, lng: 3.983 },
      { city: "Badagry", lat: 6.415, lng: 2.881 },
    ],
  },
  {
    state: "Nasarawa",
    areas: [
      { city: "Lafia", lat: 8.492, lng: 8.516 },
      { city: "Keffi", lat: 8.848, lng: 7.873 },
      { city: "Akwanga", lat: 8.916, lng: 8.404 },
      { city: "Karu", lat: 8.982, lng: 7.688 },
    ],
  },
  {
    state: "Niger",
    areas: [
      { city: "Minna", lat: 9.614, lng: 6.548 },
      { city: "Suleja", lat: 9.181, lng: 7.179 },
      { city: "Bida", lat: 9.083, lng: 6.017 },
      { city: "Kontagora", lat: 10.399, lng: 5.472 },
    ],
  },
  {
    state: "Ogun",
    areas: [
      { city: "Abeokuta", lat: 7.155, lng: 3.348 },
      { city: "Ijebu-Ode", lat: 6.82, lng: 3.918 },
      { city: "Sagamu", lat: 6.842, lng: 3.646 },
      { city: "Ota", lat: 6.682, lng: 3.234 },
      { city: "Ifo", lat: 6.816, lng: 3.196 },
    ],
  },
  {
    state: "Ondo",
    areas: [
      { city: "Akure", lat: 7.252, lng: 5.195 },
      { city: "Ondo", lat: 7.093, lng: 4.837 },
      { city: "Owo", lat: 7.196, lng: 5.587 },
      { city: "Ikare", lat: 7.525, lng: 5.76 },
    ],
  },
  {
    state: "Osun",
    areas: [
      { city: "Osogbo", lat: 7.771, lng: 4.556 },
      { city: "Ile-Ife", lat: 7.483, lng: 4.56 },
      { city: "Ilesa", lat: 7.626, lng: 4.741 },
      { city: "Ede", lat: 7.733, lng: 4.44 },
    ],
  },
  {
    state: "Oyo",
    areas: [
      { city: "Ibadan", lat: 7.378, lng: 3.947 },
      { city: "Bodija", lat: 7.431, lng: 3.901 },
      { city: "Ring Road", lat: 7.351, lng: 3.876 },
      { city: "Ogbomosho", lat: 8.133, lng: 4.25 },
      { city: "Oyo", lat: 7.85, lng: 3.933 },
      { city: "Iseyin", lat: 7.966, lng: 3.598 },
    ],
  },
  {
    state: "Plateau",
    areas: [
      { city: "Jos", lat: 9.897, lng: 8.858 },
      { city: "Bukuru", lat: 9.798, lng: 8.865 },
      { city: "Barkin Ladi", lat: 9.536, lng: 8.9 },
      { city: "Pankshin", lat: 9.323, lng: 9.44 },
    ],
  },
  {
    state: "Rivers",
    areas: [
      { city: "Port Harcourt", lat: 4.816, lng: 7.05 },
      { city: "GRA", lat: 4.815, lng: 7.008 },
      { city: "Trans-Amadi", lat: 4.796, lng: 7.036 },
      { city: "Obio-Akpor", lat: 4.858, lng: 6.999 },
      { city: "Eleme", lat: 4.79, lng: 7.113 },
      { city: "Bonny", lat: 4.427, lng: 7.171 },
    ],
  },
  {
    state: "Sokoto",
    areas: [
      { city: "Sokoto", lat: 13.06, lng: 5.239 },
      { city: "Tambuwal", lat: 12.409, lng: 4.646 },
      { city: "Wurno", lat: 13.297, lng: 5.42 },
      { city: "Bodinga", lat: 12.847, lng: 5.152 },
    ],
  },
  {
    state: "Taraba",
    areas: [
      { city: "Jalingo", lat: 8.894, lng: 11.361 },
      { city: "Wukari", lat: 7.851, lng: 9.78 },
      { city: "Bali", lat: 7.858, lng: 10.968 },
      { city: "Takum", lat: 7.267, lng: 9.983 },
    ],
  },
  {
    state: "Yobe",
    areas: [
      { city: "Damaturu", lat: 11.747, lng: 11.966 },
      { city: "Potiskum", lat: 11.71, lng: 11.081 },
      { city: "Gashua", lat: 12.873, lng: 11.045 },
      { city: "Nguru", lat: 12.879, lng: 10.453 },
    ],
  },
  {
    state: "Zamfara",
    areas: [
      { city: "Gusau", lat: 12.164, lng: 6.662 },
      { city: "Kaura Namoda", lat: 12.594, lng: 6.586 },
      { city: "Talata Mafara", lat: 12.567, lng: 6.067 },
      { city: "Bungudu", lat: 12.11, lng: 6.55 },
    ],
  },
];

const byState = new Map(NG_REGIONS.map((r) => [r.state, r]));

export const NG_STATES: string[] = NG_REGIONS.map((r) => r.state);

export function isState(state: string): boolean {
  return byState.has(state);
}

/** The area's centre, or null if the state/area pair isn't canonical. */
export function areaCentre(state: string, city: string): Area | null {
  return byState.get(state)?.areas.find((a) => a.city === city) ?? null;
}
