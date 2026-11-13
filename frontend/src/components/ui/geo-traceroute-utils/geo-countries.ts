/**
 * Embedded country data for the Location components: ISO 3166-1 alpha-2 codes, names, regions, label points and
 * simplified outlines of 175 countries.
 *
 * Outlines from Natural Earth 110m admin 0 (public domain) through world-atlas 2, simplified to about 0.1° and stored
 * at 0.1° precision in the ring encoding of geo-world (see decodeRing). The data is machine-generated. Outlines are
 * decoded lazily, per country, on first use. Pure; safe on the server.
 *
 * The country table (codes, common names, regions and subregions in ROWS) contains information from world-countries
 * (https://github.com/mledoze/countries), which is made available under the Open Database License 1.0
 * (https://opendatacommons.org/licenses/odbl/1-0/). The table is made available under the ODbL 1.0 as well; the rest
 * of this file is under the MIT license.
 */
import { decodeRing, type GeoRing } from "@/components/ui/geo-traceroute-utils/geo-world";

/** A country: its ISO 3166-1 alpha-2 code, common English name, region and a label point inside its largest area. */
export interface Country {
  /** ISO 3166-1 alpha-2 code, for example `DE`. Kosovo uses `XK`. */
  readonly code: string;
  /** Common English name, for example `Germany`. */
  readonly name: string;
  /** `Africa`, `Americas`, `Antarctic`, `Asia`, `Europe` or `Oceania`. */
  readonly region: string;
  /** Subregion, for example `Western Europe`; empty for the Antarctic. */
  readonly subregion: string;
  /**
   * Label latitude in degrees: a point inside the largest outer ring, its centroid where that lies inside and the
   * point farthest from the border for shapes whose centroid falls outside (Croatia, Norway, Vietnam).
   */
  readonly lat: number;
  /** Label longitude in degrees, in [-180, 180). */
  readonly lon: number;
}

/** A country outline: polygons, each an outer ring followed by its holes. */
export type CountryShape = readonly (readonly GeoRing[])[];

type CountryRow = readonly [code: string, name: string, region: string, subregion: string, lat: number, lon: number];

const ROWS: readonly CountryRow[] = [
  ["AF", "Afghanistan", "Asia", "Southern Asia", 33.86, 66.09],
  ["AL", "Albania", "Europe", "Southeast Europe", 41.14, 20.03],
  ["DZ", "Algeria", "Africa", "Northern Africa", 28.19, 2.6],
  ["AO", "Angola", "Africa", "Middle Africa", -12.29, 17.5],
  ["AQ", "Antarctica", "Antarctic", "", -77.33, 31.21],
  ["AR", "Argentina", "Americas", "South America", -35.22, -65.15],
  ["AM", "Armenia", "Asia", "Western Asia", 40.22, 45],
  ["AU", "Australia", "Oceania", "Australia and New Zealand", -25.56, 134.38],
  ["AT", "Austria", "Europe", "Central Europe", 47.61, 14.08],
  ["AZ", "Azerbaijan", "Asia", "Western Asia", 40.28, 47.68],
  ["BS", "Bahamas", "Americas", "Caribbean", 24.51, -77.92],
  ["BD", "Bangladesh", "Asia", "Southern Asia", 23.84, 90.27],
  ["BY", "Belarus", "Europe", "Eastern Europe", 53.51, 27.98],
  ["BE", "Belgium", "Europe", "Western Europe", 50.65, 4.58],
  ["BZ", "Belize", "Americas", "Central America", 17.2, -88.7],
  ["BJ", "Benin", "Africa", "Western Africa", 9.65, 2.34],
  ["BT", "Bhutan", "Asia", "Southern Asia", 27.43, 90.47],
  ["BO", "Bolivia", "Americas", "South America", -16.73, -64.64],
  ["BA", "Bosnia and Herzegovina", "Europe", "Southeast Europe", 44.18, 17.82],
  ["BW", "Botswana", "Africa", "Southern Africa", -22.1, 23.77],
  ["BR", "Brazil", "Americas", "South America", -10.81, -53.05],
  ["BN", "Brunei", "Asia", "South-Eastern Asia", 4.69, 114.92],
  ["BG", "Bulgaria", "Europe", "Southeast Europe", 42.75, 25.19],
  ["BF", "Burkina Faso", "Africa", "Western Africa", 12.31, -1.78],
  ["BI", "Burundi", "Africa", "Eastern Africa", -3.38, 29.91],
  ["KH", "Cambodia", "Asia", "South-Eastern Asia", 12.68, 104.88],
  ["CM", "Cameroon", "Africa", "Middle Africa", 5.66, 12.61],
  ["CA", "Canada", "Americas", "North America", 57.75, -101.57],
  ["CF", "Central African Republic", "Africa", "Middle Africa", 6.54, 20.37],
  ["TD", "Chad", "Africa", "Middle Africa", 15.33, 18.58],
  ["CL", "Chile", "Americas", "South America", -37.34, -71.67],
  ["CN", "China", "Asia", "Eastern Asia", 36.61, 103.87],
  ["CO", "Colombia", "Americas", "South America", 3.93, -73.08],
  ["CR", "Costa Rica", "Americas", "Central America", 9.97, -84.18],
  ["HR", "Croatia", "Europe", "Southeast Europe", 45.79, 16.56],
  ["CU", "Cuba", "Americas", "Caribbean", 21.63, -78.96],
  ["CY", "Cyprus", "Europe", "Southern Europe", 34.91, 33.04],
  ["CZ", "Czechia", "Europe", "Central Europe", 49.78, 15.33],
  ["DK", "Denmark", "Europe", "Northern Europe", 56.22, 9.31],
  ["DJ", "Djibouti", "Africa", "Eastern Africa", 11.77, 42.5],
  ["DO", "Dominican Republic", "Americas", "Caribbean", 18.88, -70.46],
  ["CD", "DR Congo", "Africa", "Middle Africa", -2.85, 23.58],
  ["EC", "Ecuador", "Americas", "South America", -1.46, -78.38],
  ["EG", "Egypt", "Africa", "Northern Africa", 26.51, 29.84],
  ["SV", "El Salvador", "Americas", "Central America", 13.73, -88.87],
  ["GQ", "Equatorial Guinea", "Africa", "Middle Africa", 1.65, 10.37],
  ["ER", "Eritrea", "Africa", "Eastern Africa", 15.43, 38.68],
  ["EE", "Estonia", "Europe", "Northern Europe", 58.64, 25.83],
  ["SZ", "Eswatini", "Africa", "Southern Africa", -26.49, 31.4],
  ["ET", "Ethiopia", "Africa", "Eastern Africa", 8.65, 39.55],
  ["FK", "Falkland Islands", "Americas", "South America", -51.71, -59.42],
  ["FJ", "Fiji", "Oceania", "Melanesia", -17.84, 178.02],
  ["FI", "Finland", "Europe", "Northern Europe", 64.5, 26.21],
  ["FR", "France", "Europe", "Western Europe", 46.61, 2.34],
  ["TF", "French Southern and Antarctic Lands", "Antarctic", "", -49.31, 69.53],
  ["GA", "Gabon", "Africa", "Middle Africa", -0.65, 11.69],
  ["GM", "Gambia", "Africa", "Western Africa", 13.48, -15.43],
  ["GE", "Georgia", "Asia", "Western Asia", 42.16, 43.48],
  ["DE", "Germany", "Europe", "Western Europe", 51.13, 10.29],
  ["GH", "Ghana", "Africa", "Western Africa", 7.93, -1.24],
  ["GR", "Greece", "Europe", "Southern Europe", 39.34, 22.56],
  ["GL", "Greenland", "Americas", "North America", 74.77, -41.5],
  ["GT", "Guatemala", "Americas", "Central America", 15.7, -90.37],
  ["GN", "Guinea", "Africa", "Western Africa", 10.45, -11.06],
  ["GW", "Guinea-Bissau", "Africa", "Western Africa", 12.02, -15.11],
  ["GY", "Guyana", "Americas", "South America", 4.79, -58.97],
  ["HT", "Haiti", "Americas", "Caribbean", 19.28, -72.22],
  ["HN", "Honduras", "Americas", "Central America", 14.82, -86.59],
  ["HU", "Hungary", "Europe", "Central Europe", 47.2, 19.36],
  ["IS", "Iceland", "Europe", "Northern Europe", 65.07, -18.76],
  ["IN", "India", "Asia", "Southern Asia", 22.92, 79.59],
  ["ID", "Indonesia", "Asia", "South-Eastern Asia", -0.25, 114.02],
  ["IR", "Iran", "Asia", "Southern Asia", 32.52, 54.29],
  ["IQ", "Iraq", "Asia", "Western Asia", 33.04, 43.76],
  ["IE", "Ireland", "Europe", "Northern Europe", 53.18, -8.01],
  ["IL", "Israel", "Asia", "Western Asia", 30.99, 34.87],
  ["IT", "Italy", "Europe", "Southern Europe", 43.47, 12.22],
  ["CI", "Ivory Coast", "Africa", "Western Africa", 7.55, -5.61],
  ["JM", "Jamaica", "Americas", "Caribbean", 18.14, -77.32],
  ["JP", "Japan", "Asia", "Eastern Asia", 36.02, 136.88],
  ["JO", "Jordan", "Asia", "Western Asia", 31.25, 36.78],
  ["KZ", "Kazakhstan", "Asia", "Central Asia", 48.19, 67.28],
  ["KE", "Kenya", "Africa", "Eastern Africa", 0.6, 37.79],
  ["XK", "Kosovo", "Europe", "Southeast Europe", 42.58, 20.9],
  ["KW", "Kuwait", "Asia", "Western Asia", 29.31, 47.6],
  ["KG", "Kyrgyzstan", "Asia", "Central Asia", 41.51, 74.62],
  ["LA", "Laos", "Asia", "South-Eastern Asia", 18.45, 103.75],
  ["LV", "Latvia", "Europe", "Northern Europe", 56.81, 24.83],
  ["LB", "Lebanon", "Asia", "Western Asia", 33.91, 35.87],
  ["LS", "Lesotho", "Africa", "Southern Africa", -29.63, 28.17],
  ["LR", "Liberia", "Africa", "Western Africa", 6.43, -9.41],
  ["LY", "Libya", "Africa", "Northern Africa", 27, 17.97],
  ["LT", "Lithuania", "Europe", "Northern Europe", 55.28, 23.88],
  ["LU", "Luxembourg", "Europe", "Western Europe", 49.77, 5.97],
  ["MG", "Madagascar", "Africa", "Eastern Africa", -19.36, 46.69],
  ["MW", "Malawi", "Africa", "Eastern Africa", -13.17, 34.19],
  ["MY", "Malaysia", "Asia", "South-Eastern Asia", 3.55, 114.68],
  ["ML", "Mali", "Africa", "Western Africa", 17.27, -3.54],
  ["MR", "Mauritania", "Africa", "Western Africa", 20.21, -10.33],
  ["MX", "Mexico", "Americas", "North America", 23.94, -102.58],
  ["MD", "Moldova", "Europe", "Eastern Europe", 47.2, 28.41],
  ["MN", "Mongolia", "Asia", "Eastern Asia", 46.82, 102.95],
  ["ME", "Montenegro", "Europe", "Southeast Europe", 42.79, 19.29],
  ["MA", "Morocco", "Africa", "Northern Africa", 29.89, -8.42],
  ["MZ", "Mozambique", "Africa", "Eastern Africa", -17.23, 35.47],
  ["MM", "Myanmar", "Asia", "South-Eastern Asia", 21.02, 96.51],
  ["NA", "Namibia", "Africa", "Southern Africa", -22.1, 17.16],
  ["NP", "Nepal", "Asia", "Southern Asia", 28.24, 84.01],
  ["NL", "Netherlands", "Europe", "Western Europe", 52.3, 5.51],
  ["NC", "New Caledonia", "Oceania", "Melanesia", -21.26, 165.53],
  ["NZ", "New Zealand", "Oceania", "Australia and New Zealand", -43.99, 170.51],
  ["NI", "Nicaragua", "Americas", "Central America", 12.85, -85.02],
  ["NE", "Niger", "Africa", "Western Africa", 17.35, 9.33],
  ["NG", "Nigeria", "Africa", "Western Africa", 9.55, 8],
  ["KP", "North Korea", "Asia", "Eastern Asia", 40.14, 127.16],
  ["MK", "North Macedonia", "Europe", "Southeast Europe", 41.61, 21.7],
  ["NO", "Norway", "Europe", "Northern Europe", 61.05, 8.74],
  ["OM", "Oman", "Asia", "Western Asia", 20.58, 56.1],
  ["PK", "Pakistan", "Asia", "Southern Asia", 29.97, 69.41],
  ["PS", "Palestine", "Asia", "Western Asia", 31.94, 35.27],
  ["PA", "Panama", "Americas", "Central America", 8.53, -80.11],
  ["PG", "Papua New Guinea", "Oceania", "Melanesia", -6.65, 144.33],
  ["PY", "Paraguay", "Americas", "South America", -23.25, -58.39],
  ["PE", "Peru", "Americas", "South America", -9.19, -74.39],
  ["PH", "Philippines", "Asia", "South-Eastern Asia", 15.75, 121.54],
  ["PL", "Poland", "Europe", "Central Europe", 52.15, 19.31],
  ["PT", "Portugal", "Europe", "Southern Europe", 39.63, -8.06],
  ["PR", "Puerto Rico", "Americas", "Caribbean", 18.24, -66.48],
  ["QA", "Qatar", "Asia", "Western Asia", 25.32, 51.18],
  ["CG", "Republic of the Congo", "Africa", "Middle Africa", -0.84, 15.13],
  ["RO", "Romania", "Europe", "Southeast Europe", 45.86, 24.94],
  ["RU", "Russia", "Europe", "Eastern Europe", 61.72, 99.88],
  ["RW", "Rwanda", "Africa", "Eastern Africa", -2.01, 29.92],
  ["SA", "Saudi Arabia", "Asia", "Western Asia", 24.12, 44.52],
  ["SN", "Senegal", "Africa", "Western Africa", 14.35, -14.51],
  ["RS", "Serbia", "Europe", "Southeast Europe", 44.23, 20.82],
  ["SL", "Sierra Leone", "Africa", "Western Africa", 8.53, -11.8],
  ["SK", "Slovakia", "Europe", "Central Europe", 48.73, 19.51],
  ["SI", "Slovenia", "Europe", "Central Europe", 46.13, 14.94],
  ["SB", "Solomon Islands", "Oceania", "Melanesia", -7.9, 159.1],
  ["SO", "Somalia", "Africa", "Eastern Africa", 4.75, 45.73],
  ["ZA", "South Africa", "Africa", "Southern Africa", -28.96, 25.12],
  ["KR", "South Korea", "Asia", "Eastern Asia", 36.43, 127.82],
  ["SS", "South Sudan", "Africa", "Middle Africa", 7.29, 30.2],
  ["ES", "Spain", "Europe", "Southern Europe", 40.35, -3.62],
  ["LK", "Sri Lanka", "Asia", "Southern Asia", 7.7, 80.67],
  ["SD", "Sudan", "Africa", "Northern Africa", 15.99, 29.86],
  ["SR", "Suriname", "Americas", "South America", 4.12, -55.91],
  ["SE", "Sweden", "Europe", "Northern Europe", 62.81, 16.6],
  ["CH", "Switzerland", "Europe", "Western Europe", 46.79, 8.12],
  ["SY", "Syria", "Asia", "Western Asia", 35.01, 38.54],
  ["TW", "Taiwan", "Asia", "Eastern Asia", 23.74, 120.97],
  ["TJ", "Tajikistan", "Asia", "Central Asia", 38.58, 71.03],
  ["TZ", "Tanzania", "Africa", "Eastern Africa", -6.26, 34.75],
  ["TH", "Thailand", "Asia", "South-Eastern Asia", 15.02, 101.01],
  ["TL", "Timor-Leste", "Asia", "South-Eastern Asia", -8.77, 125.97],
  ["TG", "Togo", "Africa", "Western Africa", 8.44, 1],
  ["TT", "Trinidad and Tobago", "Americas", "Caribbean", 10.43, -61.33],
  ["TN", "Tunisia", "Africa", "Northern Africa", 34.17, 9.53],
  ["TR", "Türkiye", "Asia", "Western Asia", 38.99, 35.39],
  ["TM", "Turkmenistan", "Asia", "Central Asia", 39.09, 59.28],
  ["UG", "Uganda", "Africa", "Eastern Africa", 1.3, 32.36],
  ["UA", "Ukraine", "Europe", "Eastern Europe", 49.15, 31.23],
  ["AE", "United Arab Emirates", "Asia", "Western Asia", 23.87, 54.21],
  ["GB", "United Kingdom", "Europe", "Northern Europe", 53.88, -2.66],
  ["US", "United States", "Americas", "North America", 39.5, -99.06],
  ["UY", "Uruguay", "Americas", "South America", -32.78, -56],
  ["UZ", "Uzbekistan", "Asia", "Central Asia", 41.75, 63.2],
  ["VU", "Vanuatu", "Oceania", "Melanesia", -15.22, 166.91],
  ["VE", "Venezuela", "Americas", "South America", 7.16, -66.16],
  ["VN", "Vietnam", "Asia", "South-Eastern Asia", 21.76, 105.31],
  ["EH", "Western Sahara", "Africa", "Northern Africa", 24.29, -12.14],
  ["YE", "Yemen", "Asia", "Western Asia", 15.91, 47.54],
  ["ZM", "Zambia", "Africa", "Eastern Africa", -13.4, 27.73],
  ["ZW", "Zimbabwe", "Africa", "Eastern Africa", -18.91, 29.79],
];

/** Every country with an outline, sorted by name. */
export const COUNTRIES: readonly Country[] = ROWS.map(([code, name, region, subregion, lat, lon]) => ({
  code,
  name,
  region,
  subregion,
  lat,
  lon,
}));

const byCode = new Map(COUNTRIES.map((country) => [country.code, country]));

/** The country with an ISO alpha-2 code (case-insensitive), or undefined. */
export function getCountry(code: string): Country | undefined {
  return byCode.get(code.toUpperCase());
}

const decoded = new Map<string, CountryShape>();

/** The outline of a country, or an empty list for an unknown code. */
export function countryShape(code: string): CountryShape {
  const key = code.toUpperCase();
  const cached = decoded.get(key);
  if (cached) return cached;
  const stored = Object.hasOwn(SHAPES, key) ? ((SHAPES[key] as readonly (readonly string[])[])) : undefined;
  const shape: CountryShape = stored ? stored.map((polygon) => polygon.map(decodeRing)) : [];
  decoded.set(key, shape);
  return shape;
}

/**
 * True for a segment of a country ring that is a seam of the antimeridian cut rather than a border: it runs along
 * 180° or jumps across it (Russia, Fiji, Antarctica). Skip these segments when stroking outlines; keep them when
 * filling.
 */
export function isSeam(lonA: number, lonB: number): boolean {
  return Math.abs(lonA - lonB) > 180 || (Math.abs(lonA) >= 179.99 && Math.abs(lonB) >= 179.99);
}

/** Even-odd ray cast of a point against a flat [lon, lat, …] ring. */
function evenOdd(ring: ArrayLike<number>, lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i + 1 < ring.length; j = i, i += 2) {
    const xi = (ring[i] as number);
    const yi = (ring[i + 1] as number);
    const xj = (ring[j] as number);
    const yj = (ring[j + 1] as number);
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const continuousRings = new WeakMap<GeoRing, Float64Array | null>();

/**
 * A ring that jumps across the antimeridian, as a plain polygon with continuous longitudes (which may run past
 * ±180°); null for rings that do not cross. A ring that crosses and comes back (eastern Russia, Fiji) closes by
 * itself. A ring that crosses once goes around a pole (Antarctica), so it is closed through that pole; tested raw,
 * the land between its coast and the pole would read as outside.
 */
function continuousRing(ring: GeoRing): Float64Array | null {
  const cached = continuousRings.get(ring);
  if (cached !== undefined) return cached;
  const length = ring.length - (ring.length % 2);
  const out = new Float64Array(length + 4);
  let shift = 0;
  let crossings = 0;
  let latitudeSum = 0;
  for (let i = 0; i < length; i += 2) {
    if (i > 0) {
      const step = (ring[i] as number) - (ring[i - 2] as number);
      if (step > 180) {
        shift -= 360;
        crossings++;
      } else if (step < -180) {
        shift += 360;
        crossings++;
      }
    }
    out[i] = (ring[i] as number) + shift;
    out[i + 1] = (ring[i + 1] as number);
    latitudeSum += (ring[i + 1] as number);
  }
  let result: Float64Array | null = null;
  if (crossings > 0 && shift === 0) {
    result = out.subarray(0, length);
  } else if (crossings > 0) {
    const pole = latitudeSum < 0 ? -90 : 90;
    out[length] = (out[length - 2] as number);
    out[length + 1] = pole;
    out[length + 2] = (out[0] as number);
    out[length + 3] = pole;
    result = out;
  }
  continuousRings.set(ring, result);
  return result;
}

/** Even-odd test of a point against one ring, correct for rings that cross the antimeridian. */
function insideRing(ring: GeoRing, lon: number, lat: number): boolean {
  const continuous = continuousRing(ring);
  if (!continuous) return evenOdd(ring, lon, lat);
  // the continuous ring may extend past ±180°, so test the point's copies a turn either side as well
  return evenOdd(continuous, lon, lat) || evenOdd(continuous, lon + 360, lat) || evenOdd(continuous, lon - 360, lat);
}

/** A lon/lat box in degrees, for the quick rejection in countryAt. */
interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

let bounds: Map<string, Bounds> | null = null;

/** The box of a country's outer rings as countryAt tests them (a ring around a pole reaches the pole). */
function boundsOf(shape: CountryShape): Bounds {
  const box: Bounds = { west: 180, south: 90, east: -180, north: -90 };
  for (const polygon of shape) {
    const outer = continuousRing((polygon[0] as GeoRing)) ?? (polygon[0] as GeoRing);
    for (let i = 0; i + 1 < outer.length; i += 2) {
      box.west = Math.min(box.west, (outer[i] as number));
      box.east = Math.max(box.east, (outer[i] as number));
      box.south = Math.min(box.south, (outer[i + 1] as number));
      box.north = Math.max(box.north, (outer[i + 1] as number));
    }
  }
  // continuous longitudes can run past ±180°; such a country is tested at every longitude
  if (box.west < -180 || box.east > 180) {
    box.west = -180;
    box.east = 180;
  }
  return box;
}

/**
 * The country that contains a point, or undefined over water. Longitudes wrap. Decodes every outline on the first
 * call.
 */
export function countryAt(lat: number, lon: number): Country | undefined {
  if (!bounds) {
    bounds = new Map();
    for (const country of COUNTRIES) bounds.set(country.code, boundsOf(countryShape(country.code)));
  }
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  for (const country of COUNTRIES) {
    const box = bounds.get(country.code);
    if (!box || x < box.west || x > box.east || lat < box.south || lat > box.north) continue;
    for (const polygon of countryShape(country.code)) {
      if (!insideRing((polygon[0] as GeoRing), x, lat)) continue;
      if (!polygon.slice(1).some((hole) => insideRing(hole, x, lat))) return country;
    }
  }
  return undefined;
}

const SHAPES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  AF: [
    [
      "ypBsXMAUHQGGBGIMAGKIIKDBFGBBPIHQGOKiBBEFjCLJHGRJJCHFFTAILLFHLALHFFCPBBFPAJLBPZHNCDFLETDfKSSBOPCHeKKJEOmBUFQCEKQCKGEQSECIQF",
    ],
  ],
  AL: [["kNwZADFDBFHJPOBIEUDKIKCDGCIHANCHIF"]],
  DZ: [
    ["tFkRAcgBQmBIGKYICOKCKIaEEIFEHgBHOUKWEMIUGiCGKDUIUAIDOADJERFPLLCPeXO1BDtBCLHHMNAJIJKEQJILjClB5BnBbHVBBMTIFKxGoE"],
  ],
  AO: [
    ["kI_CHDDNDBFQOMIH"],
    ["2H5DWE6BAMZMRUGKDIQMCCEKABHYAALEHBLCLGHAXaEIACFBJEJDHCFpBAA_BabjBHvBCNKzCBLINCVHBMMuBKaSWCOAMFGJYGMJiBJMCE"],
  ],
  AQ: [
    ["te3wBoBEeDaJILER_BLvCHvBAZIEIqBGSGuBgB"],
    ["tpBlyB4CBaQUHLT1CCXGLG"],
    ["luBxsBkBCGKCYKKSCMHUXIRJPtBFZAKItBFPGAIWI"],
    ["9_B9sBMEsCHWCMJ7CATEJI"],
    ["zsChuBEIyBHYELFRFbCTG"],
    ["xvC9tBOG0BNlBEbE"],
    ["pmDjxBMImBDiBLGJlBBZGZO"],
    [
      "vwD90BSMkBHeIcHeI6BE8BNmDJsCF6BG2CDwBFsDMEItCChCEPI1BEEKOODKfEPIdGwBBuBEeFkCMQIHI1BKzDGNIpBOFWcHiCEQHgBCqCQeCAIHIGGaEMF2BI2BCqCOeBcCcD2BE4BDyDAsBKaDuBKgBTUGYHyBH2BG2CHKIXOXCLILW8CFUFIHcAuCIUDaCSOQHWDaCQHqCHYQUHcCUDOHaCqBKuCISEMGGKDIXeAICIQQEGFSII2BaIIYMUAMGeGaMQCMDHHbJPEPBbJJFBHAHKFNDRBjBVDHSNgBJSXKFGHCROXBJXNZDVNdFtCLPHjEBGH0BJMFVFhBCbFBPYFEHYHsBBkDRiDHoCNeP8CSsCMyBA6CHMIcG0BCgGUVOAG1DDFICQKE-BIwBMSIgEMkDUkBMGIVEIIOI-BOQIKKOEYAKHYAAIKIWBGHYByBGWAKHWGsDQQGMGQDUCaPYEIIUEaAIHQIkCCsBDWLWEkCAiDQQGWSUDIFSDUAcLWGGIoBKqBGwBOSBgBMSASECISG2BImBDQDCJcLYBeLUAiBM4BJoBAQVADBJjBLCHYADHTPQFYBWESQYMQQqCIQQOIkBIMIaGUBmBEWAOEKOQPSB6CAgBF6BGUB-BgBcHoBRmBBqBGeMYAOEQDYLWAmBJYBWCcMSCoBDkBCkBDoBIwCEGSMFEHOPSDwDEwBBOFDHMFsBJqCJWAOGyBPwBDKHWDQHWB8CBgCLOFBHjBfZBLHZDJHbNLNBRYVmBBIJhCFlBBRJDJRNaHKHqBN6BLuBFKJ6BDSH4BEwCJ_gHA",
    ],
  ],
  AR: [
    ["7qB7gBQXaNcDHJTAJGfAAuB"],
    [
      "_jB7SJjBATFFBVaRDNOHBJRZdJnBDVCELDPEJLFVDRIHFCTOFKIGLRFPLBTFJRAPLFNUNUDHRXLLXRHHHGVMLpCIHMAONAFGBWQIGOBKKQGaBMKEBIJEGIHIFWKEDaKmBMGFUASOOAQMUASFEHiBMWBSGSOUOMFIEGAiBWKGUBGQSaFMNIQYAoBlBQBYPUHEHTdqBHQCSQESKEKLAPfTvBtB",
    ],
  ],
  AM: [["idoYHBHQHAFEZMCIDIcCMHDDKHFFSHAN"]],
  AU: [
    ["q8CvZMBCXHFBPFGNNRCLQBOLQAKiBHaG"],
    [
      "6uCjUlBPDJFHdBREbDLJFATLbCfQAMKCEECWBMNgBAKHUHIDQNYKHHSKFGHAKPcIaBMIOCNIOqBWKCEBcIKGKAWGaeCSOSIRKEHKGKKDCOQSKEAGIBAEUGOJMLYBDMKQIEBGIMMGKBSEAKPGMEMFMHQDGCMFMEIAECKJNRFACHNTCFgBRYRQFEFSFOGIUIcDaEQCEBGIcIGGJCLEBCHGJCTGNOGQPBHERCJGBGRBJGNwBbBDMNITIEIJEEEVoBjBEPAXKPBRHbDXJTNHNZRpBBTLHVARHVPbMCKJDRN7BQLMHaJITCGKDOJNRDMMCMIKBOPRLFHPPIAMVWEEZMNATKjBBvBNTC",
    ],
  ],
  AT: [["0KieBHLAEDJPRAJFrBIDGTDBBfGCIGCKFCGSBOEKAGDCCBOGCIKOFUIOFKCKDAJ"]],
  AZ: [["gdmaGBOLIAQMUXKBGDPBHXFDAJFALKIKFGHBXNAORIGGJIEELIEEaFCCJKGE"], ["6cmYLEJIDIEAGDIAIP"]],
  BS: [["rxB4QYAADVDBI"], ["zwB8QQHDNDCCKJK"], ["7wB4PGAIRAJFBDMHGEM"]],
  BD: [["-5B4NANHECPLeHMRACHFLJEBBNEBQHOEMLGEIMGNMIMQHIACNmBDMBJRHAFLKJEMEAMf"]],
  BY: [["0RkjBUFEDKCUDCJDFMLIDBDODGDHFTAKTRBFDAJZCFEHDhCKNALFJAAIFKMEAIFIAISAWIGKQIBIiBM"]],
  BE: [["8D4fDNDABLRKJBXSHADGyBIYN"]],
  BZ: [["13BkLCEEBGMIDFjBJLFACmB"]],
  BJ: [["2B-DPDFOCuBDEBKLOCKGCEIKCMMGAQJAHELDHCDPTDLArB"]],
  BT: [["q5BsRIFBNfCNDRIAEOOKGaFID"]],
  BO: [
    [
      "trB7GYAGGcQaCBjBWRWBIHWJMAMFEZDAGXoBADLCHMFELDPFHCLFDAGRKRCjBFJRALHVBEXAHPLOZGPRNDHcLWIULIBOJOMWHQEIBGIKAgBEGPgB",
    ],
  ],
  BA: [["0L0aRIXUPQGIGDEEKAwBFFJKHBHPHBL"]],
  BW: [["sS5NbNRPLTLBDPNDPARIJDDJTNNBDGCMLUFCA8BUAAmCuBIIHMIWESfWVIBAHGLQBMJ"]],
  BR: [
    [
      "rhBjVDMIKLOjBWHATQLBwBuBgBUAQJMJDGWAMHEFDHADaDGNGHDTEAcFKGEBMGIEQDMLGBIEMnBAFYEADaLGLAVKHIVCVSCkBZBbPFFXALBHCAePLRAHMLAEKLMHSGEAIMGBKEICIYOSGSAKgCDMHGAOKEEBCILCAMmBAIGIREEMLQCCGYICIOGAERCBaHGEAeFGEkBKIIBGKAEDBHGDGHFHDPITMJKACEOEIEaBAOSAUHGGEBEDKAGISiBIAQtBKDCNPPGFkBBATQM6BTKJDLYGmBJeAePaVOFSAIHKjBHhBlBnBNXNPFBFNClBHrBFHDZTZBTRJDLVAdHPHVFVPRTBNCLHdNJVjBfXHTNL",
    ],
  ],
  BN: [["moCsDDVHADFJKaS"]],
  BG: [["mO0bEH2BBKEWGcJLHFNGLRCTFAJRBNIPFNABOJGCEBCEGIGJIBIGE"]],
  BF: [["rDwGBMGIAGQQCOGGKDIEWWSIMCEDOABJCHMNAHYFANFFJBDHFBZCHDpBCCbNGJAFFVQ"]],
  BI: [["iTvBGTTVJAAYFKMBGMMB"]],
  KH: [["kgC0HFYOQaESBQHKOSHENBXhBNILTBRHPCRgB"]],
  CM: [["iJiIINAZMRZADJKJKDIVLZFDAdKJIRKFCNBLfK9CCEQHMJEDKDCGUISGCMKICMJMIKaMIQqBQQEKHIAGGC"]],
  CA: [
    [
      "3sC0e3BcjBILSEMZKDQXOAKKKAMhBOhBkBdSLKTFTLdWTGTAA8F6CPSIYGeBeIgBGOHOEGKOBgBRcOCPYEIGYBgBHuBHcDUCaJbJkBD2BCSEULWKTIMIqBCQDULWCiBJ-BEDMSEgBHARMQQAKUVMXICWYOaBUJcVRJmBDATaQYNFNUNUOOSCW6BDaJCJPLOJBJlBNbBVGFJXZXNbBPHBLVDZPTVHPBXeBShBcEmBHUHOJuBN2BDBPGTOVeTQGKWJeNMgBIWOMOBONSXOYWJSFeOG2BHSEqBRGHkBAARGXSDOLeMUWMIgChCHNaJSLgBFOFIPODIFCXbNhBFXRhBBrBExBBPNZHzBtBQEgBaqBQeCSJRLMlBaJiBEUWANOHXL_BTXPNCBSkBQ1BDNMAcHGNDFEPNNXNDBFjCAfTFHlBAJBGLZJVDVJNGUgBJiBTKCEHCDIJBCCFCBGlCcRFdGPDTIhBEFCDMHAAHnRA",
    ],
    ["v0BinBQIaAADXJNADG"],
    ["7xBwtBVKCIICuBBkBLAFlCA"],
    ["lyB6mBIGIAEDHLHCDI"],
    ["v6B8uBLHbCXEKKcESFIF"],
    ["z6BuwBvBCDEoBAODBB"],
    ["v8BoxBYHDFdFPGJIAIkBB"],
    ["h3BwuB1CIJWTIpBCVIIIoBBWFoBASFFHkBJ4BBgBEqCAUHGHNDbFZEhDD"],
    ["xlC8wBcDFFlBFbGQIcC"],
    ["rlCoxBaDXDfAAEUGKB"],
    ["3iBigBXdOGMDFFSFIGUHFNOEKXJPVCEQDEXRLAOKTE7BABGMIHEQMUgBOMQGKADF"],
    ["t0B2oBuBLAJQCOHRFdGLIvBTHKZBQKKiBOAEJKEMF"],
    [
      "nxBotBUIoCTCJmBGUNwBHSHSRjBJuBLgBFeReAFNhBXXIfUZBBL4BZMTFNrCUyBbCH1BIpBMXKGG5BUAF5BDRIOOuCEFGIKYULQdKpBGOEVORAPIJFjBDnCGrCIPIUIbAFUQSUI0BGPLQNSQ0BKiBVDLoBG",
    ],
    ["h7BquBqBAmBDdRXDVPVCLQAKKKUE"],
    ["5sCyvBiBQqBM6BCBNPH3CLbE"],
    ["9yC4hBUCHVSPHAdYBKAGKD"],
    ["9hCyxB-CJWRfCfGtBCUGXEBI"],
    ["ltCqeJBhBIFIPGDGVEFKAG0BJSPUHIL"],
    ["9rCwuBcDyBAqBNpCTZNAHzBJJItBMoBkBTMkCC"],
    ["rjCsvBSEUAEJLJjCBxBJdADGqBK5CDbEcUSG4BHkBLiBAbSSIUBQR"],
    ["xiC2tBWHShBmCTBHfBMHFFnCI7BH1CFLKZGRBXQiDIlBEnCBJIuBIfAhBGeW2BMUDJHuBGaJYKSHQRKINUSCUB"],
    ["3-ButBVOWIYDkBEGFTJgBHDRhBHRCNGxBQAGqBB"],
    ["ziCguBaAQDRLdOGC"],
    ["x9B-vBQHALJNfBVEAKfABOWAeGcACC"],
    ["_7BsyBOGUCHEuBCaLiCHQLYHbFjBNtCAVKCGQGlBAVGLKOI"],
    [
      "n5BmzB8CIeIYBWFQM-BEoCA6BCsEDuCHADzDRsBAvCRhBPnBDND7BBcBNDQJRFfFJHbFEDiBAAD1BLzBG5BDjCEBKkBEJOOC0BJZOhBEQIkBEGGbIHMmCDgBIzDAjBIPIXGDG",
    ],
    ["_uBkqBNFVADKIKSEQFBL"],
    ["l8BurBOHNFZGPBbIgBOmBL"],
    ["poBmfGCaFWHADjBGRK"],
    ["_nBsdGJiBBJHHAXIFGIG"],
  ],
  CF: [["kRoDHBZERHHEVJJCHNdGbOLFHJANbELJJRBOJGHSJKAQAOGEKUQCEGIFaISOBIaASKOWKIOCCHMLBVgBXAFWTGLOFEH"]],
  TD: [["8OoMCvCRCNbEDFFCHHPIAEFALIFAFNBJHNVRJZACHRNZHHGDFPBCGHWJEJKEKaALSAaHOCILCAMJIKaYSCaIqBEIHGAGHGDgBUK-ErC"]],
  CL: [
    ["7qB7gBAtBgBAFHPF5BKtBWbYoCZKKGOUIOB"],
    [
      "vrB_KKNCNMHHTMVIbOECFFTVJAhBDFGHNLNTFRCRLVIhBGDARLTAPNNARGTLFJlBEZJDGVIHFHKDCHJDCLFZJPCJFNPHCVGFOAANILiCFRAZLDRHBXItBYHOGMJMBiBIUWQdGSQGiBYHKqBNGFZLEMiCKMFUBWICagCKeFeGQBYMaQ8DF-BKEGK",
    ],
  ],
  CN: [
    ["ukCsLPGBSKIWGMAEHHHFLPJ"],
    [
      "myBwaBKOGRiByBMOkBoBFKKCUQAQOICENSJcHOPHXGH0BFYLMDKRKLgCDaEUDeLYAKFWKgBIeAYIcQJQMMgBFUKeIOOOGeCQBCGROPIPHTELDDIYkBYHcMAKSUKIAKJGQKYCcCeFQHcpBIRiBHYNIReASIgBGRZFVNTXERFGRDXJAAJLMHLdHCJRAHGNNVJPNbFPHTFKKDIQMLKnBTLLTBJJMLQDAJQDWOSHOACLbDJLRJJNUJITahBAPLDELMFHfLBvBnC3BhBVBLJHGLHbJTDHVJAFOGIbGJBTEHICMREJIPLjBBTHCVJADMNDXKGQLEDUVDCYUQAgBJEFMLAVCIIJONJPGXNRNPBHEZGJFNNBQLDtBGPIPEFKLETMPGHDvBaDWOBAKHKCQVYfIFQNIDGBULEHBDSGGDEUKOEUDIOaCGIgBKEG",
    ],
  ],
  CO: [
    [
      "5pBaDDHSHFlBAALMBBHDCJDANIFELJ_BJKFCOUPILAHCJDPCLUbYFBRMFBPCFIXMBGICBKGGKCQWHGEMDSEEDSHKCKIBEGFMCEMBOOICEYMKMACEQBYQIIIAGFDFNDDJNLHZKBINATEBEFaCMBORiBEIDHRBNKXJJMLGR",
    ],
  ],
  CR: [["xzBgGHBAHEDDBBLJEDGCITKBGFECFDDLGBECODCGGODECGBKFEEGJSP"]],
  HR: [["sKidUJSDGCMNHFHEfCJADDFEFHoBjBSHDBvBUPOECJIAILCFHFGAIOAECOBAEICCIQG"]],
  CU: [["tzBwOiBBSFIHUCkBZSDBFQAOHBDND3BAOKHGLAHGDMLAXIZEHEIETCNJHADFHBJCYSeI"]],
  CY: [["uU-VEGQASGNJCBZA"], ["uU-VOCCDICCBTHJCDIIA"]],
  CZ: [["sJ-fKFOBAFKDEGOBAHQAKJNDFHPBBDJEJBNGTHjBSFQqBQGBIC"]],
  DK: [["mGsiBLDPEHKAUIMSCYKBJDFCFKBDHFCPNGJ"], ["4HijBGJLPVMBIeG"]],
  DJ: [["wa6HIAGEEFAHLFIDFLDEPABKOS"]],
  DO: [["5sBoLAGDGEEASCEQAQFEFMABFKAKHHHJEPAJDDEFBHNFEAE"]],
  CD: [
    [
      "qS5CERBJELMLKXHCfFFNGHFrBSLGECVPCNSPEDKLFPCHKVAAGPCZDAYFIBMCMDIAMXACIJABDLBHPJETFLSLa5BAVDBGECEOIEGBGIKACFIDceAQIUWUCGEOCcKYCaIKMGcNeFIOKBWKIDGAEGICaDICMPIBaGGHQNAXIBNLLTBPDHANFFFXGJAX",
    ],
  ],
  EC: [["jvBDENFNVTXHNRBLLJHKPCBGGGBIKODKHJLKEEBSGEMaBIYMYLGHQBGCSL"]],
  EG: [["iX4NtHAAwEFQGODIIKaAwBNYMSCODGJEIgBFKEMhBNhBFDPQNeBBkBpCgBrBDBANcV"]],
  SV: [["73BgJSLIEIDDNLCZGFEMKBEEA"]],
  GQ: [["gGuBiBAAXjBBDEGW"]],
  ER: [["4WgJBIMsBGGOCKMSpBmBbcdKFFDHAdgBRINADELDLKFPXE"]],
  EE: [["wRmlBCDNLGRHFPAZKRDCMFBNGBM0BIqBB"]],
  SZ: [["iU1QDJLBLMAGGOGAKBGR"]],
  ET: [["8dgF3B7BZARNNBDFNAHIRJFHdEXQNAHIAKJELWJEBIJKLCGMKAKsBIGMYMKKkBYDGQMJMEEDOASHOLQTNRCJQAEDDFWbgCXSA"]],
  FK: [["nmBrgBYKQDOIQHFHbFHIRJJK"]],
  FJ: [["qvD9KGEGFBLNBJCBKIGIB"], ["vwDhKECDL0gHDNDBIcK_gHA"]],
  FI: [["8RmrBDNgBNRPWVNRSNHLeNHJ7BlBjBBjCLLMTGEUHSIMSM8BaBIbKFIBe5BYMGYLaCUFUKKOeIaHHN"]],
  FR: [
    ["pgB0CRhBFHJADEDCFFHEKaHMBOKSWHWPCH"],
    ["8D-eKFcDJNBNFDJCCDPLAHKCGHAFGHHFGNMDDHRLlBGdFBLXDVKHDjBIHIKMEoBTWPKdIBOaEiBFFYSJuBQGQSEEFIAYRKCWLGC"],
    ["uF0aOIEPHPHEFOEG"],
  ],
  TF: [["irBreOFSDCDFHfBAMEM"]],
  GA: [["iHuBWBMCCABJGJOCGDJXKLCNBNFJRCJKBJNBFFILPLhBmBLUOqBkBCAY"]],
  GM: [["tKwIWAEGGAIFOEEFJDPEPHRCCI"]],
  GE: [["gZkbCEuBHcJCBMCUDGHMDFDKJBBJAPGDDbBTKTBCKDMdQ"]],
  DE: [
    ["6I0hBGLFDGHGJBHILHBFCpBPGPWLHJFBCNBBFEJANDRCBFJGFBVGDDPACOKObEJGAIDEEODWMAEGGSDIEEQAEDOKDIBMQDMEAHUDAHWEKGgBN"],
  ],
  GH: [["A8GAFIJCdEHDRCJKT9BXRGCIHSEWIQHsBCM6BA"]],
  GR: [["uQiWBFdBAEXEEIKFgBABDMC"], ["sO6ZOAQGOHSCAKKDFNDBXCXDOLVBJKDDGLKJHDUPAJREGJLBIRNAPILeRUAGIKCGGEAEOCIGKBIE"]],
  GL: [
    [
      "nd0zBkCMmCAaGmCCgFB-DPlBH3FBKDmCC-BFmBGQHVJ0BGgDI8BDMHxCNJF_BBuBBnBZAXYLdBhBFmBJERVAaRrBBYHHF3BDaNAHnBIJFcDaLGPhBDnBSGLXLyCBrDfxCHTHbTrBNjCJRNANJLfPIPTjBbBdSnBARKNUhBYJODSbSIONIUYeGIIEQzBLXGBOIK8BDzBSTBPGWSzBqBZIAI1BMvEA5BS0BGoBCzCEtBICI2EUII1BGSIkCOeCHKsDI-BAWF0BK2DNvBKCI",
    ],
  ],
  GT: [["z5BiJCMBEKQYACGVSKAAKmBABlBUDTLCHFFDACDLJVETM"]],
  GN: [["xI8HYFGEOBAFKCQHSKEAORDLECCBAFGFDBBFKXJFALHADHFADECIJMNDBUJOPAJDFJJHRUJGBKHGIKGAOGBGCK"]],
  GW: [["tK4HYEkBABJCFNFFAHJLKHALS"]],
  GY: [["pjBmBPAHDNDBDJALKHUEQGIFIFECIDEJANQGEBKSGFIAIQMOHMNAJIAUPDRLFBNIPGAEJMR"]],
  HT: [["5sBqMARDDEFAFNEVAHDLGCIiBFIGJIAILCEGeD"]],
  HN: [["9zBsJHARHJEFHLLFEDDJACJLFDGFCCIDCLBRMGGBIaQUBSEMBICMDaP"]],
  HU: [["6NoeKDCFLDVbPDLCVHRETKDGDCGMDEMACISFQCCEcEMGWFEC"]],
  IS: [["hJypBDNWNZNrCRxCKUIrBKkBEAGpBEMOgBCeNeMaFgBKiBA"]],
  IN: [
    [
      "68B2RCHFDALNEZNCLLPAJJPPEAVDFCHJFLgBDADLJKGMIAKSLClBEBOHAPIHLOLLFDHMFDLINCPBHlBDAPJJbNXXhBZAHbLJBFPGpBHRAhBLBHPGFRFHLHFRSRwBPcJmBRcNgCAYDUbLNCZYIIFGVSMOsBADQJKBQNIWWYBUWMUUUAOSMPKPeKIgBDWESQWXBPIJAJNCEVwBZLJHRgCbcDMJmBFSAAeMECTSHOEgBBCOHGQCSOYOQFOKKNHHWB",
    ],
  ],
  ID: [
    ["k4CzBAhERQTEDFZAIQOGFWJQlBSPAdUFJHBDIAIPKWGOABGdAHMREHKcEKGgBHInBWLQWWMSAgBNWD"],
    ["kuCxFCJNNPFBEKSUI"],
    ["8zCpEBQIOEFAJJN"],
    ["2pCyCLRORBJWRXBFNARRNBTHdBGVHHMNCJGXHHKdCBaJGJQBSCSMOCNOJOEMBMKKCSFQEKcIIIWoBD"],
    ["8wC3BWFGPPKpBAEMaA"],
    ["qvCrCNEDIUCEHFF"],
    ["-vCsBCLMBCHBPJCBNIJFBHMFaEQGI"],
    ["6sCSYAUOCDPTNDTExBDDNSRMIkBIAJJEHLRHUZDFSXALLFHGKQTHDGCINMCUNFCzBLDHGGSDUHAFOIOMuBEISOQFYB"],
    ["mrCtGZOSESLBDHB"],
    ["6rCpFOASIBLdDbCAIQEMF"],
    ["-pCnFMCEHvBFIKKCGGIF"],
    ["6jC_DCHmBBGIkBHINeDYLVHVKnBApBMNCHDjBIDKRAOUYBYH"],
    ["ohCVCNIJOBKNDXBfVAPSZQXcZqBPSNgBROJQPMTWBKsBF-B9BWAQNMPOJHPMHIA"],
  ],
  IR: [
    [
      "se2SLMAKFACOJQXKNUGOKIBMNGXoBEGFWOGEHKHMDICYOICGFHJMJGAGNSDOJeDeGCESEOMOBIEOBWJQBYROACRNlBKDJJIdQBCNRRSVSHCRIDCHbLHVxCMHaJCPBTJXGTQTGbsBJBNGFH",
    ],
  ],
  IQ: [["wYkUHYsBUIYBQKEKMKEWBIFKEMXOFCLJHFNOTYJKPBNGAAJMLZENTlBC3BoBdOXG"]],
  IE: [["7D2hBENPRjBLbCQWJUqBYEJDJMAQD"]],
  IL: [["qWuUDFFCDLEBDDBDKCAHJfLiBGGKgBOEBL"]],
  IT: [
    [
      "wGqdOBCCUEEFcFBJEHPCPFAPGJSJKPWPQAGFFDgBLSJCDDHLKPCHLOHBJJBJPHBESEENUHEFILEJINChBWNKFUZKJDLHHBEILEFOIGFIAGKDKAKIEDKAEIOBKEAI",
    ],
    ["oJ6XOCFPCFDJ1BUEKWBWC"],
    ["uFyZKGMNBZJAHFHGAYDMKB"],
  ],
  CI: [["_EsGYBCGKCEHMGWPGGKAOFEbHPDVIRBHhBEXDlBLCaTQEIBKCGCAAMKGJYCGEC"]],
  JM: [["vwByLOBKDEFNAFDLEJGCGMA"]],
  JP: [
    ["24CwYRTAVHPEJJNZHjBBbVNGAQjBDVJXAUPNfLJJIESLGHOUGKMUMOMoBGWDUkBOJoBcOYDYIMWEKbAP"],
    ["s6CwbOIEVbFRTfOJVVADUKOWCMsBWVeJ"],
    ["4yC-UKMMDIKOFEFLLHGJDFLLGAK"],
  ],
  JO: [["mWoUEGWHoBWIXrBNUTFDDFPBLNVEBCKgBCa"]],
  KZ: [
    [
      "02B4ePNPABTJJnBGNjBxBLShBNFCJNCJI9BCHBbILDBLhBGLBDHlBRJNFAFIZCDQJACUXO5BDRSzBYzBLCpCJANONGXDHFBEGIDIXGHSLGAGUBAOSEQBESDOTBPEpBLJECKLMPAPOKQDEQWULCOqBWeAkCVWIgBCYLGGcAGKfOSIDGUGNOIGsCIKEyBISIkBDGVUGaHBJUAyBUHFaPsBxBMKaLeGKDKLODIHaCML",
    ],
  ],
  KE: [["wY9CbUBMrCqBAWWkBJiBJOaYKDAJIHOAYPeDGISKIHOARVApCMPNHFHFBDNFHDLHH"]],
  XK: [["8MmaBGHIIGCGECULDJPBBFBC"]],
  KW: [["ge4SIbNBDKRCOUOB"]],
  KG: [["ssBuaEIMCiBFCMMEcHIC-BBKHOBDFfJFHZBHNTEhBNEDFFlBBZGTBCMUDIGQBaQXKNFPISOFC"]],
  LA: [["kjC8IRIJNPIGICSPQBUNQPCDFLBFETLBSGWNABMHGEISMCDKABWKEUhBYAIRLFFFYLepBONGNDT"]],
  LV: [["iR-jBKFIThBLTKJCBE1BBVFAQKMSIQPQAEQSEaJQA"]],
  LB: [["sW6UNDIQKOIAEHJHFJ"]],
  LS: [["kSjSGFJPJBDFFBPOWUIGKH"]],
  LR: [["nF6EAPDHUPBZZIvBoBGMSUICKLBHEDGAEIGA"]],
  LY: [["0P4NAnBXAAH9EsCjBRJKfKHMPKJDHKAKLOIIAgBESHaKEBSeUCOYFICQDaHKRuBLWJUOFQGIQKMCcDGHiBFGFHJEHFNGPAvE"]],
  LT: [["yQ4iBCHPHFJVHRAFGJCCMdGDQWG2BCCDKBUJ"]],
  LU: [["4DqfEDAHJACMEA"]],
  MG: [["-e5HMVCXGHBJDFFMDFEPBHFDBRtBpEhBNbMDKBSHQAOCQKCAIKOCOJWASGKCOmBIcYGKBIIBKOCMGKGJ"]],
  MW: [["wU3FSDMPGZFPGZGAIFINCZJDFNLMBOEKAIHEFBVQGSGIDQIWFQHK"]],
  MY: [
    ["y-BiEECQHCJMCGISNILBXERIFGRAFNBpBgBBKLMBSHKCODK"],
    ["2pCyCnBEHVHHJbPDRGJBLJLCNDNKBOOFQEEQgBIYcKJEGIAEWOOKQIAKJCHeLBHNAEJNH"],
  ],
  ML: [
    [
      "lH4HBOFGFYIECMIAMFMEIAEEwCAEODCTuFgBAmE3CGJUHCLWCAtBLNBLrBFHFZBDELBRHVVHDJEFFBNPPAFFHCLLFDIJBBFXCFGAGBCDBEMNSDARJPIJBAG",
    ],
  ],
  MR: [["1KkNGGuCADeEKUCByBiCAAesCvBfAUtFEBDNvCADDHALDLGHABLHDXcXMJAJDJCHHBMGKESFeCKDKLI"]],
  MX: [
    [
      "lpCqUwBEBDsCX4BAAKiBAeXKTMFQFMQQAOHSZMLKVeLICLfDlBOjBONMVWDIJ8BQMIKiBkBKcAGDAJLJDNEBHXFEHAFLDCBDlBAAJJAWRBFXAJPCDBLhBcPGlBJzCeVOfIHIVMJMDKGCBGEGAGNcvBwBRIBECMVQDOLATWBGReCIPIFBLGBHEXcbEHCAELYVGTMRAJKAQRADLHFMlBaAQBKXQBDRKLMKAIIAKNOLGf6B",
    ],
  ],
  MD: [["0QkeSGYHIFAFGDEHIJVAABHNFBBIASXaFC"]],
  MN: [
    [
      "82B6eUEmBQeKSFUAOJyBFSOHMWUWHqBFEPcHsBGUBUJMJsBDsBIeOMBKFYCXjBEHMEUDQIQHSNBFPCdBNFNNdHTJfGLLKPbPXHdAfHVJJGXAdMTEZD_BEJMJSLEXMzBGFIIYNQbIRKDO",
    ],
  ],
  ME: [["yM0aFBBEHJCFTMGOKGWLDF"]],
  MA: [["rBgWINIfGDDHZDJHJBBNXHFJlBHfPBhBLAFDPCRBFPFBJXbVFbLPrBBAKIGGKAGGOMOGCGMAKIOMGOUKISCaUQQDaKcMMkBSUiBOAMJUCcD"]],
  MZ: [
    [
      "0VlHOCYFUCGGMAWIQMEJCjCEJNbLLpBRzBrBBNKPEPEADbEDBHJHnBRHFCHEBBJNAFYCWNqBUYKQCoCJGHCNIRABW8BQMJGCIDAHDJCNMLGOKEBaHOHGFAFaGQ",
    ],
  ],
  MM: [
    [
      "y-B4MVLNBJVHDerBHRFDSZCTIRTnBBQGOHMCWHKJyBHQjBXXGGaDSPYEGLENQBQIDAOKGBIEGAWQDKQAKMQBMaOODAMGEBIMAGLKDAfTPBXWEETMDFPYJOECHRLDH",
    ],
  ],
  NA: [["uMvPApCRJJAVEDIHGJJNQHOPgCBkBRYPmBPSBQWIOBMH0CCOJwBB0BMOBIDdNHItBHAlCTAA7B"]],
  NP: [["i3BuRAdRAlBGLKbE_BcISUOQFULMDGJQDQHuBF"]],
  NL: [["qEuhBEHFRDFLAEVXOTDNAKGSecIQA"]],
  NC: [["0nDlNaVHDJGbUPUKAaT"]],
  NZ: [
    ["yuDhZRXPHBGHCKQFMVICIOGCQAMHSXaJOIAMJOFGROTCOIFEPQFMBMIKBJdPCFFCJBD"],
    ["iqDnbcWKOIGCKOKIPQIEHAJdfIJPAPFRhBZNRALGVCDGKQaUcK"],
  ],
  NI: [["p0B6GDDPIDBNEBBnBkBCEEDICGGBKKAEEGDMMGIKDSIIADFCHFNAXBBBNDDEJ"]],
  NE: [
    [
      "qJqOEfIFAFIFDHHpBBZXRJZKHALMBBHFBAFDANWDAPLZIFDLCLHJBXKJDJAHITITDFDBJFHBRPKFAFFAOXGAILOBICKMCIGsBGCMMOAuBcI6BoBkCmBgBJKJQI",
    ],
  ],
  NG: [["2B-DAsBEMQUBEEIDMCaGICKGEUEUHIHKAKEYJKCMIMBGEaHQMEAOVEAIHDJPPPpBLHJZLHLKHBLJFBNfTHHCHFPCJMHONOfA"]],
  KP: [["0xCwaEDHCNNANVNVHBLULDDVBHJJBJEHDBEJEKMBCGMBETGQOWKOOIFSABKeIIMML"]],
  MK: [["gOuaKFCNHDJCHFNBHGBIGMgBE"]],
  NO: [
    ["uJ6xBIGeC6CVxBHJPRDJPXApBMSGdGnBSPQ4BGKFcA"],
    ["uTwrBxBJIOZIdHJNTJTGZBXMLFLABNlBEFLRAhBjBdbGHFHTCNTCZMJFXZXLMnBXbDZKHWFuBSM2BSmBU2CiC4CoBsBKgBBeQmBAkBE-BNZFWL"],
    ["kRiyBdL5BB5BEDEbCVI-BGcDUG6CL"],
    ["uP2wBrBJjBGOELIqBEIHcD"],
  ],
  OM: [["wiBmOGYKEDECMKAINMFaFORIDADZlBJCDFBJAPJALFBJDDLAHFAHJFLCVFVuB8BUOoBJO"], ["mjBiQDIGGCBDL"]],
  PK: [
    [
      "0wBmWRPVDfEJHQdQJRLANTTLTTVXCVVOHCPKJEPrBALNPEFQNOhDFIWcMBIHEBSRIRWgBJUEMDEGOBaICQKMQACGQCGBIGAMIMMGHMUAGGBIKKFSKIkCMOHGPgBH",
    ],
  ],
  PS: [["kW2TJBCEEEDCEMGBBR"]],
  PA: [["rwBuFBDGLDFHCBJFGDMEEROJBDFLFBDKLHDJBDMBDFCDIVEADDCCMECDEAIICGHADKAGDeKGGMABBUFOJ"]],
  PG: [
    ["k4CzBoCZYTELgBLGJRBENSLMVMAAHODFDWHBFNBDGlBGZYLQZKbLCPPFfEAiE"],
    ["s_CpCIFCJFFHUTQNGEEaNIJ"],
    ["y-CzDVJJAbMCGSDKCEKCACJMAQOBMMCEDALFLJBDD"],
    ["4gDpDYXBFFBHIJMDQECCF"],
  ],
  PY: [["rkBzMGJAbUDIEOFEFEZIAGEIDALJnBRPPBpBIUeDITIXQPClBiBIWAMKSkBGSBSJAF"]],
  PE: [
    [
      "1rB1CRARFXNBHDHCJLFAHFDIRMLDJMAILSAQMAdIBMCQfDFAfHJCFDHIPRfJDTKBIlBUzBkBHQCGPa1BkDdWIIJUGOQMCHFFCFQBIJMKCMOSYIWUGODOGCcXMTQBKEIBMAQHNTGBKJ",
    ],
  ],
  PH: [
    ["wrC-HJQSBGFDRJK"],
    ["0sCoGEGCMMADLQSBRTZLOEG"],
    ["gvCoFCXFRHUHJGPFHXMFOGKLIFHJCNLDGIQYOGJQGEKOABQQJER"],
    ["iqC6FZRKOaaKUEPXZ"],
    ["usCsLBHGNDPLHDPEPMBICaJBLGDBJPKHMDHNMRDJGCIGEFGBHJMDIAUIHCgBGSMAMFGGCF"],
    ["osCkHBKMFMAAHVPAU"],
    ["uuC0HGXPGGRJFAOFCDMMBAILQSBGF"],
  ],
  PL: [["2O2hBAHGHAHLDQjBBFJBRPGJXKNDJCLDJIHDJMPAAINCDFJEAGNCJGHMCIFKFIGEFMmCWUDCFwCBKBGF"]],
  PT: [["zFmaOIGJaCGJJFAPBBBJHBILFLIFJNAFHFJEJBEQBMJCDGCOIIEUDW"]],
  PR: [["tpByLKBEDDDbBAKCCQA"]],
  QA: [["4fwPBOGKGCGFALDLFAFE"]],
  CG: [["yLmCBLJXBbDNBFVTHTAPbdHEBGJAFHNKNLPUQMHMGGOCCKKJSBGKCOBOJMKYFENBFKCKYBgBJCMKSMKcD"]],
  RO: [["0RucKDKEIDAFJDFCDXbKVFJD1BCHMEEDCHDJGBILEBGLIQEWcUIaBKFUGGEIAGBYZARCH"]],
  RU: [
    ["06B0yBqBGoBLuBRFRpBB3BEhBIPOZE0BO"],
    ["ogCyxB0BLFHxDHmBaeC"],
    ["42CyvB2BAoCJPPpCAfDnBOKMaE"],
    ["08CivByBDVHfClBIGGkBD"],
    ["u3C8tBSIaCcHCFpCE"],
    ["gcsyBmCEEFeIeDtCNVEMItBA"],
    ["mO-hB7BCEKcGeFBL"],
    ["uhBkuBwBQFKwDYiCCiBIoBCOHNFjER9BT9BlBERmBPrCCFIjBGBKUEBMoBQRE"],
    ["q5CyhBITBRe3BdGLbSVANPMLNDQCUBWEOCcLSCcSKHIKEEN"],
    [
      "4xCsaDEAKKAEYFSSGYDOUGWSafFRHdAHSXOhBIHSbqBPIdGzBDPJKFAJJHRTAJbLXIXBJGLCdNrBHrBELKTKTCrBFbIDQpBGVIVTILRNxBGNKTARGdJlBPbFLMZBHINEJMJEdFZMLJrByBZQIGxBTTACKZITFFWjBERHxBHJDrCHHFONTFEFRHgBNFJbAFFXMfBVHjCWdApBVBNTMPVEDJPQNQAMLBJKDJLRDTTSRBNWXPLHANMRGFITELBBCbKtBIBDZSXIPKOEQQJIcIAGRDCIKGSCEGDMIKAGpBGLKPDXIAEHIPCBGGELKbADDHAJUUAIGFENECEHELMEGBKTEJBDETGHUJGIGFSOMBEWKTK8BmBIKdOIMROOSVWSQfOEOyBKUGiBL2BDsCXQHANVJfF5CQNDgBNCdqBJCILKOGwBLQGLOuBUSBUFKOPMKMNM4BHKJXBALOFgBEEMwDcQBTLYBOGmBCeIWLYMVMMI6BHkDbOKTKBGXCIILQAGkBSOSOE2BDELTPOFGNDbWLJNlBbWBIGWGGKSKLKIOVCDKQUZQkBODOKCKLHTWBJOiBIqBAkBLRSBUiBG8CAPMYMWAoBK0BEGE2BCQDsBKmBAEKUIwBIiBFbFuBBEJUE6BAsBJQHDJpCPPF2BHSEKNKGgBEgCDEJ0CBCOqCBgBLKLLHYPgBHUUgBHiBGmBHOGiBBPScI0FLSL0BPwCEoBBQHBPYFcEkBCkBDmBCkBRYGPOKI-BFqBC6BJjgHHmDjBBLOFFQ2BDoBRTJfBBRHDRAPGZGDKTCXBJGEIXDKJLHghHAZJZCSJMPKFCHFFjBEpCP7BbHHbOzBPJIRJbEFNXTCHWDBbTBHPIHhBLHVdDFVbRHOTqCKcSMAIgBGmCsBkBQQeXBLRzBVPazBHxBfQNpCFAOdEZJ7BChCFtE1CgBBKLUDMKWBcVCRPTBXHfdbHNhC5BbLLALKbNBH",
    ],
    ["vwD2sBUCcFBDTDZBqgHADGlgHI"],
    ["8U4cGEUDQLUCDHVDZJLEEITGWMDC"],
  ],
  RW: [["gTVILALFBLCFLLCGYGGEBMG"]],
  SA: [
    [
      "8VsSWDMOQCEGGETUsBOYFeN4BnB4BDEJOCIRKDEHOHAVMPGDGAMf8BJEEKNNnB7BT5BHRHNVJDFIdCbBHGFJCHHHJYJGLSFQNOHCNUAaLWTMLaFEduBJAIa",
    ],
  ],
  SN: [["tKwIHQJGIEOYIIKBKEKAYLYbGXGFCNNCFDNGtBAXDBQSBQIQDKEDGNDHGFADFVA"]],
  RS: [["4L2cQGMBMHCFMDCHKFIEEBDDEDFDCHKHHFDFCBBDPBEKTMJJACVMGCCIJIGKHAIGLO"]],
  SL: [["nIyFKIGKKEQAKNCTGCRTFLTKJKFW"]],
  SK: [["kO2eNPVGLFbDBDPBRGBIEGQCOMOCKHMEKBOEUH"]],
  SI: [["0IidQBKGSAEEEBEFPFBHHBADNCDBNAECDICK"]],
  SB: [["qlDxGGFNAHMQF"], ["ilD_FDDNSDMGAQZ"], ["ykDlGTCFECIODKJ"], ["4jD_EGJhBWECYN"], ["miDrEIFDBHEHIAEMH"]],
  SO: [["gahBLQAqCWcOCSOaA4B8BWeAmBcGIGIABbHbVvBRdnBvBlCzBVXHP"], ["yekHAlBVdRA_BYVcKSIDEHIJyBIkBMKA"]],
  ZA: [
    [
      "mK7RKKIFEHWDKASKAqCGBMTBLEFOCUOEKKESHQAOEEQMCMUSQcOkBDOpBBVAFJCFAFNAFMLMCEKOAFfFJRLXhBlBhBNHfJBDLCJDVETBlBJLHJAHGFCJIABBQHOGEAOlB-B",
      "kSjSJIHFVTQNGCEGKCKQFG",
    ],
  ],
  KR: [["8uCyXKCIKWCEEQXGLAXHJRDPHRBBKEQJUQENQ"]],
  SS: [["oTmCPOFIZFHCPYNGFMVUAGXQMGMcOCOPGBGCOAEDUAAEKECGIEQLMCUaBMDGMAAEKABPCNKHCPEAAPDFJAFLMBKJCHKDMVlBhBNAPDNEHF"]],
  ES: [["1EmXAGKOHGGMHMICCKCCAQKGFKZBFKNHAOHIcOqCFwBAIHkBHIEWJYEALRNZDBFLLHPILLHDNNDNNtBATPJCFIFKTE"]],
  LK: [["kzB2EDTHFRDHQDcIgBOJUjB"]],
  SD: [
    [
      "sPkFVQCWLMBOHGAMDGHAIQBIGGDEOcSBB4CYAAoBuHAGTDDCTIXSLJLNBFFLrBCHBPHTLJLXHFFTARAQDABQJIBOCQJAADLAEFCLTZLBPMHDBFJDADTADENAFBFCNQNBLbLFOH",
    ],
  ],
  SR: [["hiBuBLERAANJCLSDKFAHQCOMGESYDCEQAUDJRCNILJZ"]],
  SE: [["8G6kBaYGYLKBaOUUBGIFIeciBkBSAGMmBDCOMA6BXCdGHhBFTNELnChBNbONUJRVVFHhBJRXCLPXAFSPWPe"]],
  CH: [["gG2dBHSDAHJDNCDHJADEJHJAJEFIJBAIQMBEKBGEQAEEWF"]],
  SY: [["qWuUIWKIDIHABQQSAKIDWGKDQAYIgBCJLJDCPHXzCpBVI"]],
  TW: [["ksCoPVvBJQBQMSQQKFDL"]],
  TJ: [["sqBmXMWDOPEGKQBQYcGDJCFIAHFTEBLUCaFmBCERICMDCThBCNJPFHICQFCCGJEHHFJLAFHFCPFFC"]],
  TZ: [["mVTsCpBCLcTJXCLMFDRAPQfGDPLVHLAFFTBXGNBFaLQREpBSJYLMDMCKDSKAUWFUGCAMHMIC-BA"]],
  TH: [
    [
      "4hC-IRCZDNPGXRIRAEQRABVPtBAPOAIRERKJMDKJFHLBBKPIDBHGDKTWDLDKKgBUoBHSBURaGEISdsBIEKWOCWMIFCLOAFVCRUMGDMCEGQBOPCTQPBRFH",
    ],
  ],
  TL: [["kuCxFCEQGWCGBrBTBK"]],
  TG: [["S8GBJMNCJEDBtBGNPDJUBKESDIBeHKAGSA"]],
  TT: [["xmB4GQCAPVAGGAI"]],
  TN: [["-F-SHkBdYBQMMGQDSEKWKODAJQICDJJAJGDBRLJCJMAEJIDBNdTCRJD"]],
  TR: [
    ["gcoXJDHGVCpBFXHPAJEVFHEAJLJFKIILBRENLdBPKVCDHNDTMVALUNKKQLKWSeCIOmBBYMYGiBAiBNcHYESBYKUCUJEHBHWLNFGVDFMP"],
    ["qQkaUGSBCHSFDDXBXPFMECGOJE"],
  ],
  TM: [["6gBkaIGYEOFONgBADKSIQMcLCPIDUCIDKTkBXuBRALPGBHRDDPJFPBDJPBTGBSNAXSPCVKNCHDNCNLRDDOEWPGGONAESUFQINMFKPDBPFO"]],
  UG: [["mVT9BATHDCAOEICQMUOMHCAYIGODQEOAMKKNKhBVjBAV"]],
  UA: [
    [
      "8TygBIAEEcAMJFDCFQBIHADYHQEMJqBFAFHJELDFRBJFBHPBLFTBPFALFGTEFDhBGAITBVZHEJDJEGCIOACWAHKDIFEAGHGXIZFFDTFJGZCHDBGJEKOEBFKSQKCCGJSKAMGOAiCJIEGDaBAKGESC",
    ],
  ],
  AE: [["ogBkPECAFQEcBqBoBEHCPJABLEDJDAHJT7BKHY"]],
  GB: [
    ["7D2hBPELAEKDKSCULJN"],
    ["9BshBEMNMXEFGIIFGLJAULKIUQQoBAVTqBCDPRRUBUZOBSfYDBLLFIJRJZAhBFJELJRCNFLEeUSEfEFIWGLKEOeB"],
  ],
  US: [
    [
      "3sC0eoRAAIIAELGBiBDUHQEeFSGmCbCFGBBBKCEHIBBDUJKhBTdCFGBsCYFMKCmBAGIgBUkCACGOEOYQOGDOEIFAbQR9BVNPALGJIABGGDBF5BHPFeEGDbFNAAEFFGBDNNPBGJGEJEDAHPXEOJIDQBHELNCOFARGBGZNPTFNLJAJHBFVNTVDNENQdAJIVAVFLFBJCBIHGXoBEODKPQHETJNMLEVBRCXDEFAHEDDBHCHDNANMRBNEdFRPTHJJFHANGPHBdMJWLMRaNIPALPPGLGJUdYhBAAJ3BArCYCEvBDDKLMJCBGLCFETCDEBMTUPcAEXYDQJKEQASFQISEkBDcLaCEeHKRGGJgB",
    ],
    ["jhDyMMLRLDEDMEGAGKD"],
    ["vhDgNHDFGCCMD"],
    ["_hDoNABJAACKA"],
    ["3iDyNGHHADGGC"],
    ["zjD8NBFFEIC"],
    ["hoD4lBQBCHLBZIUE"],
    ["3_CokBMBKFlBRJGDKeK"],
    [
      "j4CyrBA7FUAUFeVUMUGMJeRiBjBiBNALJJdODSZQLSxBCXGpBU1BMbB9BSVDENhBFnBJDKKUWGFGZLNLbNOJRPpBNFHdJFJXHNA3BRhBFBE-BaYCKIcMUMCOMMXFFELHLKFFHKTHLABMEGLIZDdOBMNIIMQKGKQCOBQIQAOGDIJEOIhBDFFNGdDbGHIZMoCSQABJqBAPMXIhBSbIMKkBAYKGKUI6BMSBeMeFQHIEiBBBDgBDUCgDJaE0BJ",
    ],
    ["prD8nBMDMCkBHPFXIRBDCCI"],
  ],
  UY: [["_jB7SMCUPIAkBVMNHJELHLVLPEJBRKNBLMAMGGAUKkB"]],
  UZ: [["gjB6ZBqC0BM0BXSR6BEYNBTKAEPaBGHGAKOmBSGBRNQHOGYJZPXCBGEKbFPXPCFJQDENLVZGAMtBSjBYJUHETBHEBQbMPLRHEJVA"]],
  VU: [["woD9JMLFBFIAG"], ["ooD5JDWKFEPJA"]],
  VE: [
    [
      "9lBoDCFHHjBJFDdGDAIFCZSBADNFBHXHBFPBLMFSLMKKJYCOISHEhBDNSLCZBDGDCAUHOJCIaOMEKOEBFJBGHALJJIPIAGQHGAQYIBIIIGNOBOJAFoBAKHQBMGAEwBCPFGJQAQJCPKAIDPLAHGHRFCJFDOP",
    ],
  ],
  VN: [["mhCyGSIUCHMiBOCYDOEUFONOdqBXMGGMGHSXATiBKEkBCQMKHSDBLIHUDZRPRDNiBvBSLMPIlBBhBnBZPRXRHMGOPM"]],
  EH: [["tFqRAjBhCACxBTBDJEdtCAFFCIsBCMQGccWKYGCGQSCQBGEMAAMCA"]],
  YE: [["wgB8LWtBNFDPzBRRNPAJHjBFLLdBFMCMNcECAUIIBIGKIFcCeBGHKEOWSI6BI"]],
  ZM: [["mTlFqBRIJGPHVEPFHFRKF7BPCNPBLHBHFBdbhBELGNCPDZcAgCqBABoBIBAFWAIJQBMGEJQDORQBBWFDRMGsBFIGOGCaEIB"]],
  ZW: [["wT9NjBELKPCFMAIHCVWRgBiBDecGCCIMIQCAHSAOHIBKFBnCJPTX"]],
};
