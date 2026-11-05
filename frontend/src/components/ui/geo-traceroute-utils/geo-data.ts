/**
 * LumeSec Elements: data helpers for the Location components. Time zones, coordinate and IP address parsing and
 * formatting, unit formatting, and the seeded demo places, regions and streams.
 *
 * Everything is pure and safe in render and on the server, except `useNow`, a hook that reads the clock in an effect.
 * Formatters default to the `en-US` locale (never the viewer's), so the server and the client produce the same text;
 * pass `locale` to change digits and words. Nothing here reads the viewer's time zone, language or position.
 * Caches (Intl formatters, offsets, lookups) fill lazily on first use.
 */
import * as React from "react";

import { destinationPoint, distanceKm, fiberRttMs, wrapLongitude, type LatLon } from "@/components/ui/geo-traceroute-utils/geo";
import { stringHash } from "@/components/ui/geo-traceroute-utils/math";
import { isLand } from "@/components/ui/geo-traceroute-utils/geo-world";

// Places

/** A demo place: an IATA-style id, an English name, an ISO country code, an IANA zone and a traffic weight. */
export interface GeoCity extends LatLon {
  /** Lowercase IATA-style id, for example `lhr`. */
  readonly id: string;
  /** English name, for example `London`. */
  readonly name: string;
  /** ISO 3166-1 alpha-2 country code. Some small places (`SG`, `HK`) have no outline in geo-countries. */
  readonly country: string;
  /** IANA time zone, for example `Europe/London`. */
  readonly timeZone: string;
  /** Relative traffic weight from 0 to 1, for weighted demo streams. */
  readonly weight: number;
}

/** A generic cloud-style deployment region (an id such as `eu-central`, never a vendor id) located at a city. */
export interface GeoRegion extends LatLon {
  /** Region id, for example `eu-central`. */
  readonly id: string;
  /** Display label; the demo regions use the id. */
  readonly label: string;
  /** Name of the city the region sits in, for example `Frankfurt`. */
  readonly city: string;
  /** IANA time zone of that city. */
  readonly timeZone: string;
}

// Time

const DEFAULT_LOCALE = "en-US";
/** U+2212, the true minus sign used in readouts. */
const MINUS = "\u2212";
/** Placeholder for values that cannot be shown. */
const MISSING = "\u2013";
const MINUTE_MS = 60_000;
const DAY_SECONDS = 86_400;
/** The largest magnitude a Date can hold, in ms. */
const MAX_TIME = 8.64e15;

/** Epoch ms of a Date or a number, truncated to whole ms like a Date (so negative fractions match Intl). */
const epochOf = (date: Date | number) => Math.trunc(typeof date === "number" ? date : date.getTime());

/** ISO date-times without a zone designator: read as UTC so the server and every viewer agree. */
const ISO_WITHOUT_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * Epoch milliseconds of a time given as epoch ms, an ISO 8601 string or a Date; null when it does not parse. ISO
 * date-times without an offset are read as UTC, never in the viewer's zone. Use it for `time` props that accept all
 * three forms.
 */
export function toEpochMs(value: number | string | Date | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  let ms: number;
  if (typeof value === "number") ms = value;
  else if (typeof value === "string") {
    const text = value.trim();
    ms = Date.parse(ISO_WITHOUT_ZONE.test(text) ? `${text}Z` : text);
  } else ms = value.getTime();
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME ? ms : null;
}

const partFormats = new Map<string, Intl.DateTimeFormat | null>();

/** The cached numeric parts formatter of a zone, or null when Intl rejects the zone. */
function partsFormat(timeZone: string): Intl.DateTimeFormat | null {
  let format = partFormats.get(timeZone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      format = null;
    }
    partFormats.set(timeZone, format);
  }
  return format;
}

/** Whether Intl accepts the time zone (IANA names such as `Asia/Kolkata`, and `UTC`). Cached. */
export function isValidTimeZone(timeZone: string): boolean {
  return typeof timeZone === "string" && timeZone !== "" && partsFormat(timeZone) !== null;
}

/** Days since 1970-01-01 of a proleptic Gregorian date (month 1 to 12). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** Writes year, month and day of a day count since 1970-01-01 into `out`. */
function civilFromDays(days: number, out: ZonedParts): void {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  out.day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  out.month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  out.year = yearOfEra + era * 400 + (out.month <= 2 ? 1 : 0);
}

/** The zone's offset in seconds at an instant, read from Intl (one formatToParts call). */
function readOffset(format: Intl.DateTimeFormat, time: number): number {
  const second = Math.floor(time / 1000) * 1000;
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let seconds = 0;
  for (const part of format.formatToParts(second)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value) % 24;
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "second") seconds = Number(part.value);
  }
  const wall = (daysFromCivil(year, month, day) * DAY_SECONDS + hour * 3600 + minute * 60 + seconds) * 1000;
  return Math.round((wall - second) / 1000);
}

/** Offsets are cached per zone and 6-hour window; a window that holds a transition is marked NaN and read exactly. */
const OFFSET_WINDOW = 6 * 3_600_000;
const offsetWindows = new Map<string, Map<number, number>>();

/** The exact offset in seconds (historical local mean times carry seconds); 0 for invalid zones and times. */
function offsetSeconds(timeZone: string, time: number): number {
  const format = partsFormat(timeZone);
  if (!format || !Number.isFinite(time) || Math.abs(time) > MAX_TIME - 2 * OFFSET_WINDOW) return 0;
  let windows = offsetWindows.get(timeZone);
  if (!windows) {
    windows = new Map();
    offsetWindows.set(timeZone, windows);
  }
  const window = Math.floor(time / OFFSET_WINDOW);
  let offset = windows.get(window);
  if (offset === undefined) {
    const start = readOffset(format, window * OFFSET_WINDOW);
    const end = readOffset(format, (window + 1) * OFFSET_WINDOW - 1000);
    offset = start === end ? start : Number.NaN;
    if (windows.size >= 4096) windows.clear();
    windows.set(window, offset);
  }
  return Number.isNaN(offset) ? readOffset(format, time) : offset;
}

/**
 * The zone's offset from UTC in minutes at an instant, DST-correct (`Asia/Kolkata` gives 330, `America/New_York` in
 * July −240). Invalid zones and invalid times give 0 (UTC). Cached per zone and 6-hour window, so calling it every
 * frame is cheap. Historical local mean times (before about 1920) are rounded to whole minutes.
 */
export function utcOffsetMinutes(timeZone: string, date: Date | number): number {
  return Math.round(offsetSeconds(timeZone, epochOf(date)) / 60) || 0;
}

/** Wall-clock parts of an instant in a zone. `month` is 1 to 12; `weekday` 0 is Sunday. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

/**
 * Wall-clock parts of an instant in a zone, derived from the cached offset (no Intl call per frame). Pass `out` to
 * reuse an object in hot loops. Invalid zones read as UTC; an invalid time reads as 1970-01-01 00:00 UTC.
 */
export function zonedParts(timeZone: string, date: Date | number, out?: ZonedParts): ZonedParts {
  const parts = out ?? { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, weekday: 4 };
  let time = epochOf(date);
  if (!Number.isFinite(time) || Math.abs(time) > MAX_TIME) time = 0;
  const local = Math.floor(time / 1000) + offsetSeconds(timeZone, time);
  const days = Math.floor(local / DAY_SECONDS);
  const secondOfDay = local - days * DAY_SECONDS;
  parts.hour = Math.floor(secondOfDay / 3600);
  parts.minute = Math.floor((secondOfDay % 3600) / 60);
  parts.second = secondOfDay % 60;
  // 1970-01-01 was a Thursday
  parts.weekday = (((days + 4) % 7) + 7) % 7;
  civilFromDays(days, parts);
  return parts;
}

/** A wall-clock time in a zone for `zonedToEpoch`; `hour`, `minute` and `second` default to 0. */
export interface ZonedDateTime {
  year: number;
  /** 1 to 12; values outside roll into the neighbouring years. */
  month: number;
  /** Day of the month; values outside roll into the neighbouring months. */
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
}

/** The instant of a local wall time (as ms of a fictitious UTC clock) in a zone, resolving gaps and overlaps. */
function wallToEpoch(timeZone: string, wall: number): number {
  // probe a day either side: offsets reach +14 h, and zones never change twice within two days
  const before = offsetSeconds(timeZone, wall - 86_400_000);
  const after = offsetSeconds(timeZone, wall + 86_400_000);
  const early = wall - before * 1000;
  const late = wall - after * 1000;
  const earlyValid = offsetSeconds(timeZone, early) === before;
  const lateValid = offsetSeconds(timeZone, late) === after;
  if (earlyValid && lateValid) return Math.min(early, late);
  if (earlyValid) return early;
  if (lateValid) return late;
  // the clock skipped this wall time (spring forward): take the instant just after the skip, like Temporal
  return early;
}

/**
 * Epoch ms of a wall-clock time in a zone. A time that occurs twice (clocks set back) gives the earlier instant; a
 * time that does not exist (clocks set forward) gives the instant after the gap, as `Temporal` does ("compatible").
 * Invalid zones read as UTC.
 */
export function zonedToEpoch(timeZone: string, fields: ZonedDateTime): number {
  const monthIndex = fields.month - 1;
  const year = fields.year + Math.floor(monthIndex / 12);
  const month = (((monthIndex % 12) + 12) % 12) + 1;
  const seconds =
    daysFromCivil(year, month, 1) * DAY_SECONDS +
    (fields.day - 1) * DAY_SECONDS +
    (fields.hour ?? 0) * 3600 +
    (fields.minute ?? 0) * 60 +
    (fields.second ?? 0);
  return wallToEpoch(timeZone, seconds * 1000);
}

const dayParts: ZonedParts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, weekday: 4 };

/**
 * Epoch ms of the local midnight that starts the day containing `date` in a zone (the first instant of that day
 * where midnight is skipped). Use it for 24-hour windows that follow a city's calendar day.
 */
export function startOfZonedDay(timeZone: string, date: Date | number): number {
  const parts = zonedParts(timeZone, date, dayParts);
  return wallToEpoch(timeZone, daysFromCivil(parts.year, parts.month, parts.day) * DAY_SECONDS * 1000);
}

/** Replaces the narrow and regular no-break spaces some ICU versions emit, so server and client text match. */
const plainSpaces = (text: string) => text.replace(/[\u202F\u00A0]/g, " ");

/** An Intl constructor call that falls back to `en-US` when the locale tag is invalid. */
function withLocale<T>(locale: string, create: (locale: string) => T): T {
  try {
    return create(locale);
  } catch {
    return create(DEFAULT_LOCALE);
  }
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();

/** Options of `formatZonedTime`. */
export interface ZonedTimeOptions {
  /** 12-hour clock ('2:20 PM'). Default false ('14:20'). */
  hour12?: boolean;
  /** Adds seconds. Default false. */
  seconds?: boolean;
  /** `short` prefixes the date ('Oct 3, 14:20'). Default `none`. */
  date?: "none" | "short";
  /** BCP 47 locale. Default `en-US`. */
  locale?: string;
}

/**
 * The local time of an instant in a zone: '14:20', '2:20 PM' with `hour12`, 'Oct 3, 14:20' with `date: "short"`.
 * Formatters are cached; invalid zones fall back to UTC; an invalid time gives '--:--'.
 */
export function formatZonedTime(timeZone: string, date: Date | number, options: ZonedTimeOptions = {}): string {
  const time = epochOf(date);
  if (!Number.isFinite(time) || Math.abs(time) > MAX_TIME) return "--:--";
  const { hour12 = false, seconds = false, date: datePart = "none", locale = DEFAULT_LOCALE } = options;
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const key = `${locale}|${zone}|${hour12 ? 12 : 24}|${seconds ? "s" : ""}|${datePart}`;
  let format = timeFormats.get(key);
  if (!format) {
    const settings: Intl.DateTimeFormatOptions = {
      timeZone: zone,
      hour: hour12 ? "numeric" : "2-digit",
      minute: "2-digit",
    };
    if (hour12) settings.hour12 = true;
    else settings.hourCycle = "h23";
    if (seconds) settings.second = "2-digit";
    if (datePart === "short") {
      settings.month = "short";
      settings.day = "numeric";
    }
    format = withLocale(locale, (tag) => new Intl.DateTimeFormat(tag, settings));
    timeFormats.set(key, format);
  }
  return plainSpaces(format.format(time));
}

const weekdayFormats = new Map<string, Intl.DateTimeFormat>();

/** The short weekday of an instant in a zone ('Wed'). Cached formatter; invalid zones read as UTC. */
export function formatWeekday(timeZone: string, date: Date | number, locale: string = DEFAULT_LOCALE): string {
  const time = epochOf(date);
  if (!Number.isFinite(time) || Math.abs(time) > MAX_TIME) return MISSING;
  const zone = isValidTimeZone(timeZone) ? timeZone : "UTC";
  const key = `${locale}|${zone}`;
  let format = weekdayFormats.get(key);
  if (!format) {
    format = withLocale(locale, (tag) => new Intl.DateTimeFormat(tag, { timeZone: zone, weekday: "short" }));
    weekdayFormats.set(key, format);
  }
  return format.format(time);
}

/** An offset in minutes as 'UTC', 'UTC+1', 'UTC+5:30' or 'UTC−3' (true minus sign). */
export function formatUtcOffset(minutes: number): string {
  const total = Math.round(minutes);
  if (!Number.isFinite(total) || total === 0) return "UTC";
  const absolute = Math.abs(total);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return `UTC${total < 0 ? MINUS : "+"}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

/**
 * The current time in epoch ms, for clocks and relative times. It is null on the server and in the first client
 * render (so hydration matches), then `Date.now()` from an effect, refreshed every `intervalMs` while `enabled` and
 * the page is visible (it re-reads at once when the page becomes visible again). Ticks are aligned to multiples of
 * `intervalMs` (a 1,000 ms clock changes on the second). Pass 0 to read the clock once after mount. While disabled
 * it keeps the last value.
 */
export function useNow(intervalMs: number, enabled = true): number | null {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!enabled) return;
    const repeat = intervalMs > 0 && Number.isFinite(intervalMs);
    let timer = 0;
    let pending = true;
    const tick = () => {
      timer = 0;
      if (document.visibilityState === "hidden") return;
      const time = Date.now();
      pending = false;
      setNow(time);
      // aim 2 ms past the next multiple, so a timer that fires a hair early still lands on the new value
      if (repeat) timer = window.setTimeout(tick, intervalMs - (time % intervalMs) + 2);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible" || !(repeat || pending)) return;
      window.clearTimeout(timer);
      tick();
    };
    // the first read is a task away, so the first client render matches the server
    timer = window.setTimeout(tick, 0);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [intervalMs, enabled]);
  return now;
}

// Coordinates

/** A hemisphere letter: N or S for latitudes, E or W for longitudes. */
export type Hemisphere = "N" | "S" | "E" | "W";

/** Pieces of a formatted coordinate, so each part can roll on its own. */
export interface CoordinateParts {
  /** The whole coordinate in the requested format: '48.8566° N' or '48°51′24″ N'. */
  readonly text: string;
  /** The absolute value in decimal degrees ('48.8566'). */
  readonly number: string;
  /** Whole degrees of the DMS form ('48'). */
  readonly degrees: string;
  /** Minutes of the DMS form, two digits ('51'). */
  readonly minutes: string;
  /** Seconds of the DMS form, two digits plus any decimals ('24', '08.5'). */
  readonly seconds: string;
  /** Hemisphere of the value as shown (a value that rounds to 0 is N or E). */
  readonly hemisphere: Hemisphere;
}

const clampDigits = (digits: number | undefined, fallback: number) =>
  Math.min(10, Math.max(0, Math.round(digits ?? fallback) || 0));

/** Absolute decimal degrees at `digits` decimals, and whether the rounded value is negative. */
function decimalPart(value: number, digits: number): { text: string; negative: boolean } {
  const text = Math.abs(value).toFixed(digits);
  return { text, negative: value < 0 && Number(text) !== 0 };
}

/** Degrees, minutes and seconds of an absolute value, with the seconds rounded first so they carry. */
function dmsPart(value: number, digits: number) {
  const scale = 10 ** digits;
  const total = Math.round(Math.abs(value) * 3600 * scale);
  const degrees = Math.floor(total / (3600 * scale));
  const minutes = Math.floor((total - degrees * 3600 * scale) / (60 * scale));
  const seconds = (total - degrees * 3600 * scale - minutes * 60 * scale) / scale;
  return {
    degrees: String(degrees),
    minutes: String(minutes).padStart(2, "0"),
    seconds: seconds.toFixed(digits).padStart(digits ? digits + 3 : 2, "0"),
    negative: value < 0 && total !== 0,
  };
}

/** A latitude clamped to ±90°, or a longitude wrapped into [−180°, 180°). */
const normalizeAxis = (value: number, axis: "lat" | "lon") =>
  axis === "lat" ? Math.min(90, Math.max(-90, value)) : wrapLongitude(value);

/**
 * One coordinate as text and parts. `decimal`: '48.8566° N' (precision = decimals, default 4). `dms`:
 * '48°51′24″ N' (precision = decimals of the seconds, default 0; seconds are rounded and carry into minutes and
 * degrees). Latitudes are clamped, longitudes wrapped; non-finite values give '–'.
 */
export function formatCoordinate(
  value: number,
  axis: "lat" | "lon",
  format: "decimal" | "dms",
  precision?: number,
): CoordinateParts {
  const positive: Hemisphere = axis === "lat" ? "N" : "E";
  const negative: Hemisphere = axis === "lat" ? "S" : "W";
  if (!Number.isFinite(value)) {
    const text = MISSING;
    return { text, number: text, degrees: text, minutes: text, seconds: text, hemisphere: positive };
  }
  const v = normalizeAxis(value, axis);
  const decimal = decimalPart(v, clampDigits(format === "decimal" ? precision : undefined, 4));
  const dms = dmsPart(v, clampDigits(format === "dms" ? precision : undefined, 0));
  if (format === "dms") {
    const hemisphere = dms.negative ? negative : positive;
    const text = `${dms.degrees}°${dms.minutes}′${dms.seconds}″ ${hemisphere}`;
    return { text, number: decimal.text, degrees: dms.degrees, minutes: dms.minutes, seconds: dms.seconds, hemisphere };
  }
  const hemisphere = decimal.negative ? negative : positive;
  const text = `${decimal.text}° ${hemisphere}`;
  return { text, number: decimal.text, degrees: dms.degrees, minutes: dms.minutes, seconds: dms.seconds, hemisphere };
}

/**
 * A point as one line: '48.8566° N, 2.3522° E' (`decimal`, default), '48°51′24″ N, 2°21′08″ E' (`dms`) or
 * '51.5072, −0.1276' (`signed`, latitude first, true minus sign; the form parseCoordinates and map tools read).
 * `precision` as in formatCoordinate (`signed` uses decimals, default 4).
 */
export function formatLatLon(
  point: LatLon,
  format: "decimal" | "dms" | "signed" = "decimal",
  precision?: number,
): string {
  if (format === "signed") {
    const digits = clampDigits(precision, 4);
    const signed = (value: number, axis: "lat" | "lon") => {
      if (!Number.isFinite(value)) return MISSING;
      const part = decimalPart(normalizeAxis(value, axis), digits);
      return `${part.negative ? MINUS : ""}${part.text}`;
    };
    return `${signed(point.lat, "lat")}, ${signed(point.lon, "lon")}`;
  }
  const lat = formatCoordinate(point.lat, "lat", format, precision);
  const lon = formatCoordinate(point.lon, "lon", format, precision);
  return `${lat.text}, ${lon.text}`;
}

interface NumberToken {
  readonly kind: "number";
  /** Absolute value. */
  readonly value: number;
  readonly negative: boolean;
  readonly integer: boolean;
  /** 0 degrees, 1 minutes, 2 seconds, −1 unmarked. */
  readonly mark: number;
}

interface HemisphereToken {
  readonly kind: "hemisphere";
  readonly letter: Hemisphere;
}

interface SeparatorToken {
  readonly kind: "separator";
}

type CoordinateToken = NumberToken | HemisphereToken | SeparatorToken;

interface CoordinateGroup {
  numbers: NumberToken[];
  hemisphere: Hemisphere | null;
}

const NUMBER_PATTERN = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/y;
const WORD_PATTERN = /[a-z]+/iy;
const HEMISPHERE_WORDS: Readonly<Record<string, Hemisphere>> = {
  n: "N",
  north: "N",
  s: "S",
  south: "S",
  e: "E",
  east: "E",
  w: "W",
  west: "W",
};

/** Unifies minus signs, degree, minute and second marks and brackets, and reads decimal commas when unambiguous. */
function normalizeCoordinateText(text: string): string {
  let s = text
    .trim()
    .replace(/[\u2212\u2012\u2013\uFE63\uFF0D]/g, "-")
    .replace(/[\u00BA\u02DA\u2218]/g, "°")
    .replace(/[\u2032\u2018\u2019\u02B9\u00B4`]/g, "'")
    .replace(/[\u2033\u201C\u201D\u02BA]/g, '"')
    .replace(/''/g, '"')
    .replace(/[()[\]{}\u00A0\u202F\u2009]/g, " ");
  // '48,8566; 2,3522' and '48,8566 2,3522' use decimal commas; '48,2' stays a pair
  const decimalCommas = (s.match(/\d,\d/g) ?? []).length;
  if (s.includes(";") || (!s.includes(".") && decimalCommas >= 2 && /\s/.test(s))) {
    s = s.replace(/(\d),(?=\d)/g, "$1.");
  }
  return s;
}

/** Splits coordinate text into numbers (with their degree, minute or second mark), hemisphere letters, separators. */
function tokenizeCoordinates(text: string): CoordinateToken[] | null {
  const tokens: CoordinateToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "," || ch === ";" || ch === "/") {
      tokens.push({ kind: "separator" });
      i++;
      continue;
    }
    NUMBER_PATTERN.lastIndex = i;
    const number = NUMBER_PATTERN.exec(text);
    if (number) {
      const raw = number[0];
      i += raw.length;
      const previous = tokens[tokens.length - 1];
      const previousMark = previous?.kind === "number" ? previous.mark : -1;
      let mark = -1;
      let j = i;
      while (text[j] === " ") j++;
      if (text[j] === "°") mark = 0;
      else if (text[j] === "'") mark = 1;
      else if (text[j] === '"') mark = 2;
      if (mark >= 0) i = j + 1;
      else {
        // letter marks must touch the number; m and s count only after degrees and minutes, so S stays south
        WORD_PATTERN.lastIndex = i;
        const word = WORD_PATTERN.exec(text)?.[0] ?? "";
        const lower = word.toLowerCase();
        if (lower === "d" || lower === "deg") mark = 0;
        else if ((lower === "m" || lower === "min") && previousMark === 0) mark = 1;
        else if ((word === "s" || lower === "sec") && previousMark === 1) mark = 2;
        if (mark >= 0) i += word.length;
      }
      tokens.push({
        kind: "number",
        value: Math.abs(Number(raw)),
        negative: raw.startsWith("-"),
        integer: !raw.includes("."),
        mark,
      });
      continue;
    }
    WORD_PATTERN.lastIndex = i;
    const word = WORD_PATTERN.exec(text)?.[0];
    const letter = word ? HEMISPHERE_WORDS[word.toLowerCase()] : undefined;
    if (!word || !letter) return null;
    tokens.push({ kind: "hemisphere", letter });
    i += word.length;
  }
  return tokens;
}

/** Splits a run of numbers by their marks: a new group starts when the mark does not increase. */
function splitByMarks(numbers: NumberToken[]): NumberToken[][] {
  const groups: NumberToken[][] = [];
  let slot = 3;
  for (const token of numbers) {
    const next = token.mark >= 0 ? token.mark : slot + 1;
    if (next <= slot || next > 2 || groups.length === 0) {
      groups.push([]);
      slot = token.mark >= 0 ? token.mark : 0;
    } else slot = next;
    groups[groups.length - 1].push(token);
  }
  return groups;
}

/** One group per axis from the tokens: by a separator, by hemisphere letters, by marks, or by count. */
function groupCoordinates(tokens: CoordinateToken[]): CoordinateGroup[] | null {
  const separators = tokens.filter((token) => token.kind === "separator").length;
  if (separators > 1) return null;
  const groups: CoordinateGroup[] = [];
  if (separators === 1) {
    let current: CoordinateGroup = { numbers: [], hemisphere: null };
    let letterPosition = -1;
    for (const token of tokens) {
      if (token.kind === "separator") {
        groups.push(current);
        current = { numbers: [], hemisphere: null };
        letterPosition = -1;
      } else if (token.kind === "hemisphere") {
        // one letter per side, before or after its numbers
        if (current.hemisphere) return null;
        current.hemisphere = token.letter;
        letterPosition = current.numbers.length;
      } else {
        if (current.hemisphere && letterPosition > 0) return null;
        current.numbers.push(token);
      }
    }
    groups.push(current);
    return groups;
  }
  const letters = tokens.filter((token) => token.kind === "hemisphere").length;
  if (letters > 0) {
    const prefix = tokens[0].kind === "hemisphere";
    let current: CoordinateGroup | null = null;
    for (const token of tokens) {
      if (token.kind === "hemisphere") {
        if (prefix) {
          current = { numbers: [], hemisphere: token.letter };
          groups.push(current);
        } else {
          if (!current || current.hemisphere) return null;
          current.hemisphere = token.letter;
          current = null;
        }
      } else if (token.kind === "number") {
        if (!current) {
          if (prefix) return null;
          current = { numbers: [], hemisphere: null };
          groups.push(current);
        }
        current.numbers.push(token);
      }
    }
    return groups;
  }
  const numbers = tokens.filter((token): token is NumberToken => token.kind === "number");
  if (numbers.some((token) => token.mark >= 0)) {
    return splitByMarks(numbers).map((run) => ({ numbers: run, hemisphere: null }));
  }
  if (numbers.length !== 2 && numbers.length !== 4 && numbers.length !== 6) return null;
  const size = numbers.length / 2;
  return [
    { numbers: numbers.slice(0, size), hemisphere: null },
    { numbers: numbers.slice(size), hemisphere: null },
  ];
}

/** Signed decimal degrees of a group, or null when its parts do not form an angle. */
function groupValue(group: CoordinateGroup): number | null {
  const { numbers, hemisphere } = group;
  if (numbers.length === 0 || numbers.length > 3) return null;
  let slot = -1;
  let value = 0;
  for (let k = 0; k < numbers.length; k++) {
    const token = numbers[k];
    const next = token.mark >= 0 ? token.mark : slot + 1;
    if (next <= slot || next > 2) return null;
    if (k > 0 && token.negative) return null;
    // only the last part may carry decimals; minutes and seconds stay below 60
    if (k < numbers.length - 1 && !token.integer) return null;
    if (next > 0 && token.value >= 60) return null;
    value += token.value / 60 ** next;
    slot = next;
  }
  const negative = numbers[0].negative;
  if (hemisphere && negative) return null;
  return negative || hemisphere === "S" || hemisphere === "W" ? -value : value;
}

/** The groups of a coordinate text, or null. Shared by parseCoordinates and detectCoordinateFormat. */
function readCoordinateGroups(text: string): CoordinateGroup[] | null {
  if (typeof text !== "string") return null;
  const tokens = tokenizeCoordinates(normalizeCoordinateText(text));
  if (!tokens || tokens.length === 0) return null;
  const groups = groupCoordinates(tokens);
  return groups && groups.length === 2 ? groups : null;
}

/** The axis a hemisphere letter names, or null without a letter. */
const axisOf = (letter: Hemisphere | null) =>
  letter === null ? null : letter === "N" || letter === "S" ? "lat" : "lon";

/**
 * Reads a point from text, or null. Accepts signed decimal pairs ('48.8566, 2.3522', '48.8566 2.3522',
 * '-33.86;151.21', '51.5072, −0.1276'), hemisphere letters before or after each number ('48.8566N 2.3522E',
 * 'N 48.8566 E 2.3522', '48.8566° N, 2.3522° E'), DMS with ° ′ ″ ' " or d m s ('48°51′24″N 2°21′08″E',
 * '48d51m24s N 2d21m8s E'), degrees with decimal minutes ('40 42.768 N 74 0.36 W'), and decimal commas when
 * unambiguous ('48,8566; 2,3522'). Swaps the pair when the letters say longitude came first; rejects |lat| > 90,
 * |lon| > 180 and conflicting signs. Longitudes come back in [−180, 180).
 */
export function parseCoordinates(text: string): LatLon | null {
  const groups = readCoordinateGroups(text);
  if (!groups) return null;
  let [first, second] = groups;
  const firstAxis = axisOf(first.hemisphere);
  const secondAxis = axisOf(second.hemisphere);
  if (firstAxis && firstAxis === secondAxis) return null;
  if (firstAxis === "lon" || secondAxis === "lat") [first, second] = [second, first];
  const lat = groupValue(first);
  const lon = groupValue(second);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: lat || 0, lon: lon >= 180 ? lon - 360 : lon || 0 };
}

/**
 * Which notation readable coordinate text uses: `dms` when either axis has minutes or seconds, `decimal` when each
 * axis is one number, null when parseCoordinates cannot read it. Use it to show the other form as a readout.
 */
export function detectCoordinateFormat(text: string): "decimal" | "dms" | null {
  if (!parseCoordinates(text)) return null;
  const groups = readCoordinateGroups(text);
  return groups && groups.some((group) => group.numbers.length > 1 || group.numbers.some((token) => token.mark > 0))
    ? "dms"
    : "decimal";
}

// Numbers and units

const numberFormats = new Map<string, Intl.NumberFormat>();

/** A cached Intl.NumberFormat with `minimum` to `maximum` fraction digits. */
function numberFormat(locale: string, minimum: number, maximum: number, compact = false, sign = false) {
  const key = `${locale}|${minimum}|${maximum}|${compact ? "c" : ""}|${sign ? "s" : ""}`;
  let format = numberFormats.get(key);
  if (!format) {
    const options: Intl.NumberFormatOptions = { minimumFractionDigits: minimum, maximumFractionDigits: maximum };
    if (compact) options.notation = "compact";
    if (sign) options.signDisplay = "exceptZero";
    format = withLocale(locale, (tag) => new Intl.NumberFormat(tag, options));
    numberFormats.set(key, format);
  }
  return format;
}

/** Formats with a cached formatter and a true minus sign. */
const formatWith = (format: Intl.NumberFormat, value: number) => plainSpaces(format.format(value)).replace(/-/g, MINUS);

/** Options of `formatNumber`. */
export interface NumberOptions {
  /** Exact number of decimals. Default 0. */
  fractionDigits?: number;
  /** Shows '+' for positive values (deltas such as '+38'). Default false. */
  sign?: boolean;
  /** BCP 47 locale. Default `en-US`. */
  locale?: string;
}

/** A number with grouping ('2,400', '412.6' with one fraction digit) and a true minus sign; '–' when not finite. */
export function formatNumber(value: number, options: NumberOptions = {}): string {
  if (!Number.isFinite(value)) return MISSING;
  const { fractionDigits, sign = false, locale = DEFAULT_LOCALE } = options;
  const digits = clampDigits(fractionDigits, 0);
  return formatWith(numberFormat(locale, digits, digits, false, sign), value);
}

const KM_PER_MILE = 1.609344;
const KM_PER_NAUTICAL_MILE = 1.852;
const FEET_PER_MILE = 5280;

/** Decimals for a value shown with one decimal below `limit` and none above, deciding on the rounded value. */
const tenthsBelow = (value: number, limit: number) => (Math.abs(Math.round(value * 10) / 10) < limit ? 1 : 0);

/**
 * A distance given in km: '2,140 km', '3.4 km' below 10 km, '350 m' below 1 km (metres rounded to 10 from 100 m).
 * With `mi`: '1,330 mi', '2.1 mi', and feet below 0.1 mi ('350 ft'). '–' when not finite.
 */
export function formatDistance(km: number, unit: "km" | "mi" = "km", locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(km)) return MISSING;
  const whole = (value: number) => formatWith(numberFormat(locale, 0, 0), value);
  if (unit === "mi") {
    const miles = km / KM_PER_MILE;
    if (Math.abs(miles) < 0.1) {
      const feet = miles * FEET_PER_MILE;
      return `${whole(Math.abs(feet) >= 100 ? Math.round(feet / 10) * 10 : Math.round(feet))} ft`;
    }
    const digits = tenthsBelow(miles, 10);
    return `${formatWith(numberFormat(locale, digits, digits), miles)} mi`;
  }
  const metres = Math.abs(km) >= 0.1 ? Math.round(km * 100) * 10 : Math.round(km * 1000);
  if (Math.abs(metres) < 1000) return `${whole(metres)} m`;
  const digits = tenthsBelow(km, 10);
  return `${formatWith(numberFormat(locale, digits, digits), km)} km`;
}

/**
 * A duration in milliseconds as latency: '18 ms', '162 ms', '0.4 ms' below 1 ms, then seconds from 1,000 ms with two
 * decimals ('1.24 s'), one from 10 s, none from 100 s. '–' when not finite.
 */
export function formatMs(ms: number, locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(ms)) return MISSING;
  const absolute = Math.abs(ms);
  if (absolute > 0 && absolute < 0.95) return `${formatWith(numberFormat(locale, 1, 1), ms)} ms`;
  if (Math.round(absolute) < 1000) return `${formatWith(numberFormat(locale, 0, 0), ms)} ms`;
  const seconds = ms / 1000;
  const rounded = Math.abs(Math.round(seconds * 100) / 100);
  const digits = rounded < 10 ? 2 : Math.abs(Math.round(seconds * 10) / 10) < 100 ? 1 : 0;
  return `${formatWith(numberFormat(locale, digits, digits), seconds)} s`;
}

/**
 * A speed given in km/h, in `km/h` (default), `mph` or `kn`: one decimal below 100 ('16.4 kn'), none above
 * ('8,400 km/h'). '–' when not finite.
 */
export function formatSpeed(
  kmh: number,
  unit: "km/h" | "mph" | "kn" = "km/h",
  locale: string = DEFAULT_LOCALE,
): string {
  if (!Number.isFinite(kmh)) return MISSING;
  const value = unit === "mph" ? kmh / KM_PER_MILE : unit === "kn" ? kmh / KM_PER_NAUTICAL_MILE : kmh;
  const digits = tenthsBelow(value, 100);
  return `${formatWith(numberFormat(locale, digits, digits), value)} ${unit}`;
}

/**
 * A span of time in its two largest units: '45 s', '40 m', '2 h 10 m', '3 d 4 h' (a zero second unit is left out:
 * '2 h', '3 d'). Rounded to the smallest unit shown, with carry; negative spans get a true minus sign. '–' when not
 * finite.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  const sign = ms < 0 ? MINUS : "";
  const absolute = Math.abs(ms);
  const seconds = Math.round(absolute / 1000);
  if (seconds < 60) return `${sign}${seconds} s`;
  const minutes = Math.round(absolute / MINUTE_MS);
  if (minutes < 60) return `${sign}${minutes} m`;
  if (minutes < 1440) {
    const rest = minutes % 60;
    return `${sign}${Math.floor(minutes / 60)} h${rest ? ` ${rest} m` : ""}`;
  }
  const hours = Math.round(absolute / 3_600_000);
  const rest = hours % 24;
  return `${sign}${Math.floor(hours / 24)} d${rest ? ` ${rest} h` : ""}`;
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/**
 * How long ago (or ahead) `time` is from `now`, both epoch ms: 'now', '5 minutes ago', '2 hours ago', 'yesterday',
 * 'in 3 days' (Intl.RelativeTimeFormat, numeric auto, cached). Under 45 s reads 'now'. Pass `now` from a prop or
 * `useNow`, never Date.now() in render. '–' when either time is not finite.
 */
export function formatAgo(time: number, now: number, locale: string = DEFAULT_LOCALE): string {
  const seconds = (time - now) / 1000;
  if (!Number.isFinite(seconds)) return MISSING;
  let format = relativeFormats.get(locale);
  if (!format) {
    format = withLocale(locale, (tag) => new Intl.RelativeTimeFormat(tag, { numeric: "auto" }));
    relativeFormats.set(locale, format);
  }
  const absolute = Math.abs(seconds);
  if (absolute < 45) return format.format(0, "second");
  if (absolute < 45 * 60) return format.format(Math.round(seconds / 60), "minute");
  if (absolute < 22 * 3600) return format.format(Math.round(seconds / 3600), "hour");
  if (absolute < 26 * DAY_SECONDS) return format.format(Math.round(seconds / DAY_SECONDS), "day");
  if (absolute < 320 * DAY_SECONDS) return format.format(Math.round(seconds / (30.44 * DAY_SECONDS)), "month");
  return format.format(Math.round(seconds / (365.25 * DAY_SECONDS)), "year");
}

/** Compact notation with at most one fraction digit ('950', '12.4K', '3.1M'); the default format of counts. */
export function formatCompact(value: number, locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(value)) return MISSING;
  return formatWith(numberFormat(locale, 0, 1, true), value);
}

/**
 * The q-quantile (q from 0 to 1) of a list, interpolated linearly between ranks: 0.5 is the median, 0.95 the p95.
 * Non-finite values are ignored; NaN for an empty list. Sorts a copy, so keep it out of per-frame code.
 */
export function quantile(values: readonly number[], q: number): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const position = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.min(sorted.length - 1, below + 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** The median of a list (quantile 0.5); NaN for an empty list. */
export function median(values: readonly number[]): number {
  return quantile(values, 0.5);
}

// IP addresses

/** A parsed IP address: 4 or 16 bytes and normalised text (IPv6 per RFC 5952). */
export interface IpAddress {
  readonly version: 4 | 6;
  readonly bytes: Uint8Array;
  /** '203.0.113.42', '2001:db8::1', '::ffff:192.0.2.1'. */
  readonly text: string;
}

/** Address classes, by the IANA special-purpose registries. Documentation ranges are valid addresses for demos. */
export type IpScope =
  | "public"
  | "private"
  | "shared"
  | "loopback"
  | "link-local"
  | "documentation"
  | "multicast"
  | "unspecified"
  | "reserved";

/** The 4 bytes of a dotted quad (each part 0 to 255, no leading zeros), or null. */
function parseIpv4Bytes(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

/** The 16-bit groups of one side of '::', with an IPv4 tail allowed at the very end; null when invalid. */
function parseIpv6Groups(text: string, allowIpv4Tail: boolean): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (allowIpv4Tail && i === parts.length - 1 && part.includes(".")) {
      const bytes = parseIpv4Bytes(part);
      if (!bytes) return null;
      groups.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
    } else if (/^[0-9a-f]{1,4}$/i.test(part)) groups.push(parseInt(part, 16));
    else return null;
  }
  return groups;
}

const isZero = (bytes: Uint8Array, from: number, to: number) => {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
};

/** RFC 5952 text: lowercase, no leading zeros, the longest run of two or more zero groups as '::'. */
function ipv6Text(bytes: Uint8Array): string {
  if (isZero(bytes, 0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return `::ffff:${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  }
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1]);
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = (from: number, to: number) =>
    groups
      .slice(from, to)
      .map((group) => group.toString(16))
      .join(":");
  if (bestStart < 0) return hex(0, 8);
  return `${hex(0, bestStart)}::${hex(bestStart + bestLength, 8)}`;
}

/**
 * Parses an IPv4 dotted quad or an IPv6 address (full, compressed with '::', with an IPv4 tail, in [brackets], with a
 * %zone that is dropped). Returns the bytes and normalised text, or null when invalid. Ports are not accepted.
 */
export function parseIpAddress(text: string): IpAddress | null {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!s.includes(":")) {
    const bytes = parseIpv4Bytes(s);
    return bytes ? { version: 4, bytes, text: Array.from(bytes).join(".") } : null;
  }
  const zone = s.indexOf("%");
  if (zone >= 0) {
    if (zone === s.length - 1) return null;
    s = s.slice(0, zone);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const compressed = halves.length === 2;
  const head = parseIpv6Groups(halves[0], !compressed);
  const tail = compressed ? parseIpv6Groups(halves[1], true) : [];
  if (!head || !tail) return null;
  const count = head.length + tail.length;
  if (compressed ? count > 7 : count !== 8) return null;
  const groups = [...head, ...new Array<number>(8 - count).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  return { version: 6, bytes, text: ipv6Text(bytes) };
}

/** The class of an IPv4 address from its four bytes. */
function ipv4Scope(a: number, b: number, c: number, d: number): IpScope {
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 100 && (b & 0xc0) === 64) return "shared";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && (b & 0xf0) === 16) return "private";
  // IETF protocol assignments; only the PCP and TURN anycast addresses .9 and .10 are reachable from anywhere
  if (a === 192 && b === 0 && c === 0) return d === 9 || d === 10 ? "public" : "reserved";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b & 0xfe) === 18) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if ((a & 0xf0) === 224) return "multicast";
  if ((a & 0xf0) === 240) return "reserved";
  return "public";
}

/**
 * The class of an address, first match wins. IPv4: 0/8 unspecified, 10/8 private, 100.64/10 shared, 127/8 loopback,
 * 169.254/16 link-local, 172.16/12 private, 192.0.0/24 reserved (IETF protocol assignments, except the anycast
 * addresses 192.0.0.9 and 192.0.0.10), 192.0.2/24 documentation, 192.168/16 private, 198.18/15 reserved
 * (benchmarking), 198.51.100/24 and 203.0.113/24 documentation, 224/4 multicast, 240/4 reserved. IPv6: :: unspecified,
 * ::1 loopback, ::ffff:0:0/96 and the NAT64 prefix 64:ff9b::/96 by their IPv4 part, 64:ff9b:1::/48 private (local-use
 * NAT64), 100::/64 reserved (discard), 2001:2::/48 reserved (benchmarking), 2001:db8::/32 and 3fff::/20
 * documentation, fc00::/7 private, fe80::/10 link-local, ff00::/8 multicast. Everything else is public.
 */
export function ipScope(address: IpAddress): IpScope {
  const b = address.bytes;
  if (address.version === 4) return ipv4Scope(b[0], b[1], b[2], b[3]);
  if (isZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4Scope(b[12], b[13], b[14], b[15]);
  if (isZero(b, 0, 16)) return "unspecified";
  if (isZero(b, 0, 15) && b[15] === 1) return "loopback";
  const nat64 = b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b;
  if (nat64 && isZero(b, 4, 12)) return ipv4Scope(b[12], b[13], b[14], b[15]);
  if (nat64 && b[4] === 0x00 && b[5] === 0x01) return "private";
  if (b[0] === 0x01 && b[1] === 0x00 && isZero(b, 2, 8)) return "reserved";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x02 && isZero(b, 4, 6)) return "reserved";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return "documentation";
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return "documentation";
  if ((b[0] & 0xfe) === 0xfc) return "private";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local";
  if (b[0] === 0xff) return "multicast";
  return "public";
}

// Demo data (invented weights; real city coordinates)

/**
 * 60 demo places on every continent, invented traffic weights, real coordinates (city centres, 4 decimals). Grouped
 * by continent: Europe, the Americas, Africa, the Middle East, Asia, Oceania. Demo data only.
 */
export const DEMO_CITIES: readonly GeoCity[] = [
  { id: "lhr", name: "London", country: "GB", timeZone: "Europe/London", weight: 1, lat: 51.5072, lon: -0.1276 },
  { id: "cdg", name: "Paris", country: "FR", timeZone: "Europe/Paris", weight: 0.8, lat: 48.8566, lon: 2.3522 },
  { id: "fra", name: "Frankfurt", country: "DE", timeZone: "Europe/Berlin", weight: 0.7, lat: 50.1109, lon: 8.6821 },
  { id: "ber", name: "Berlin", country: "DE", timeZone: "Europe/Berlin", weight: 0.6, lat: 52.52, lon: 13.405 },
  { id: "ams", name: "Amsterdam", country: "NL", timeZone: "Europe/Amsterdam", weight: 0.6, lat: 52.3676, lon: 4.9041 },
  { id: "mad", name: "Madrid", country: "ES", timeZone: "Europe/Madrid", weight: 0.6, lat: 40.4168, lon: -3.7038 },
  { id: "lis", name: "Lisbon", country: "PT", timeZone: "Europe/Lisbon", weight: 0.4, lat: 38.7223, lon: -9.1393 },
  { id: "dub", name: "Dublin", country: "IE", timeZone: "Europe/Dublin", weight: 0.4, lat: 53.3498, lon: -6.2603 },
  { id: "mxp", name: "Milan", country: "IT", timeZone: "Europe/Rome", weight: 0.5, lat: 45.4642, lon: 9.19 },
  { id: "zrh", name: "Zurich", country: "CH", timeZone: "Europe/Zurich", weight: 0.4, lat: 47.3769, lon: 8.5417 },
  {
    id: "arn",
    name: "Stockholm",
    country: "SE",
    timeZone: "Europe/Stockholm",
    weight: 0.4,
    lat: 59.3293,
    lon: 18.0686,
  },
  { id: "hel", name: "Helsinki", country: "FI", timeZone: "Europe/Helsinki", weight: 0.3, lat: 60.1699, lon: 24.9384 },
  { id: "waw", name: "Warsaw", country: "PL", timeZone: "Europe/Warsaw", weight: 0.4, lat: 52.2297, lon: 21.0122 },
  { id: "ist", name: "Istanbul", country: "TR", timeZone: "Europe/Istanbul", weight: 0.6, lat: 41.0082, lon: 28.9784 },
  { id: "ham", name: "Hamburg", country: "DE", timeZone: "Europe/Berlin", weight: 0.3, lat: 53.5511, lon: 9.9937 },
  { id: "rtm", name: "Rotterdam", country: "NL", timeZone: "Europe/Amsterdam", weight: 0.3, lat: 51.9244, lon: 4.4777 },
  { id: "mrs", name: "Marseille", country: "FR", timeZone: "Europe/Paris", weight: 0.3, lat: 43.2965, lon: 5.3698 },
  { id: "jfk", name: "New York", country: "US", timeZone: "America/New_York", weight: 1, lat: 40.7128, lon: -74.006 },
  { id: "iad", name: "Ashburn", country: "US", timeZone: "America/New_York", weight: 0.5, lat: 39.0438, lon: -77.4874 },
  { id: "ord", name: "Chicago", country: "US", timeZone: "America/Chicago", weight: 0.6, lat: 41.8781, lon: -87.6298 },
  { id: "dfw", name: "Dallas", country: "US", timeZone: "America/Chicago", weight: 0.5, lat: 32.7767, lon: -96.797 },
  { id: "mia", name: "Miami", country: "US", timeZone: "America/New_York", weight: 0.4, lat: 25.7617, lon: -80.1918 },
  { id: "yyz", name: "Toronto", country: "CA", timeZone: "America/Toronto", weight: 0.5, lat: 43.6532, lon: -79.3832 },
  {
    id: "sea",
    name: "Seattle",
    country: "US",
    timeZone: "America/Los_Angeles",
    weight: 0.5,
    lat: 47.6062,
    lon: -122.3321,
  },
  {
    id: "sfo",
    name: "San Francisco",
    country: "US",
    timeZone: "America/Los_Angeles",
    weight: 0.8,
    lat: 37.7749,
    lon: -122.4194,
  },
  {
    id: "lax",
    name: "Los Angeles",
    country: "US",
    timeZone: "America/Los_Angeles",
    weight: 0.7,
    lat: 34.0522,
    lon: -118.2437,
  },
  {
    id: "mex",
    name: "Mexico City",
    country: "MX",
    timeZone: "America/Mexico_City",
    weight: 0.6,
    lat: 19.4326,
    lon: -99.1332,
  },
  { id: "bog", name: "Bogotá", country: "CO", timeZone: "America/Bogota", weight: 0.4, lat: 4.711, lon: -74.0721 },
  { id: "lim", name: "Lima", country: "PE", timeZone: "America/Lima", weight: 0.3, lat: -12.0464, lon: -77.0428 },
  {
    id: "scl",
    name: "Santiago",
    country: "CL",
    timeZone: "America/Santiago",
    weight: 0.3,
    lat: -33.4489,
    lon: -70.6693,
  },
  {
    id: "gru",
    name: "São Paulo",
    country: "BR",
    timeZone: "America/Sao_Paulo",
    weight: 0.8,
    lat: -23.5505,
    lon: -46.6333,
  },
  {
    id: "eze",
    name: "Buenos Aires",
    country: "AR",
    timeZone: "America/Argentina/Buenos_Aires",
    weight: 0.5,
    lat: -34.6037,
    lon: -58.3816,
  },
  {
    id: "yvr",
    name: "Vancouver",
    country: "CA",
    timeZone: "America/Vancouver",
    weight: 0.3,
    lat: 49.2827,
    lon: -123.1207,
  },
  {
    id: "gig",
    name: "Rio de Janeiro",
    country: "BR",
    timeZone: "America/Sao_Paulo",
    weight: 0.4,
    lat: -22.9068,
    lon: -43.1729,
  },
  { id: "cai", name: "Cairo", country: "EG", timeZone: "Africa/Cairo", weight: 0.5, lat: 30.0444, lon: 31.2357 },
  {
    id: "cmn",
    name: "Casablanca",
    country: "MA",
    timeZone: "Africa/Casablanca",
    weight: 0.3,
    lat: 33.5731,
    lon: -7.5898,
  },
  { id: "los", name: "Lagos", country: "NG", timeZone: "Africa/Lagos", weight: 0.6, lat: 6.5244, lon: 3.3792 },
  { id: "nbo", name: "Nairobi", country: "KE", timeZone: "Africa/Nairobi", weight: 0.4, lat: -1.2921, lon: 36.8219 },
  {
    id: "jnb",
    name: "Johannesburg",
    country: "ZA",
    timeZone: "Africa/Johannesburg",
    weight: 0.5,
    lat: -26.2041,
    lon: 28.0473,
  },
  {
    id: "cpt",
    name: "Cape Town",
    country: "ZA",
    timeZone: "Africa/Johannesburg",
    weight: 0.3,
    lat: -33.9249,
    lon: 18.4241,
  },
  { id: "dxb", name: "Dubai", country: "AE", timeZone: "Asia/Dubai", weight: 0.6, lat: 25.2048, lon: 55.2708 },
  { id: "ruh", name: "Riyadh", country: "SA", timeZone: "Asia/Riyadh", weight: 0.4, lat: 24.7136, lon: 46.6753 },
  { id: "tlv", name: "Tel Aviv", country: "IL", timeZone: "Asia/Jerusalem", weight: 0.3, lat: 32.0853, lon: 34.7818 },
  { id: "bom", name: "Mumbai", country: "IN", timeZone: "Asia/Kolkata", weight: 0.8, lat: 19.076, lon: 72.8777 },
  { id: "del", name: "Delhi", country: "IN", timeZone: "Asia/Kolkata", weight: 0.7, lat: 28.7041, lon: 77.1025 },
  { id: "blr", name: "Bangalore", country: "IN", timeZone: "Asia/Kolkata", weight: 0.6, lat: 12.9716, lon: 77.5946 },
  { id: "sin", name: "Singapore", country: "SG", timeZone: "Asia/Singapore", weight: 0.8, lat: 1.3521, lon: 103.8198 },
  { id: "cgk", name: "Jakarta", country: "ID", timeZone: "Asia/Jakarta", weight: 0.6, lat: -6.2088, lon: 106.8456 },
  { id: "bkk", name: "Bangkok", country: "TH", timeZone: "Asia/Bangkok", weight: 0.5, lat: 13.7563, lon: 100.5018 },
  { id: "mnl", name: "Manila", country: "PH", timeZone: "Asia/Manila", weight: 0.4, lat: 14.5995, lon: 120.9842 },
  { id: "hkg", name: "Hong Kong", country: "HK", timeZone: "Asia/Hong_Kong", weight: 0.6, lat: 22.3193, lon: 114.1694 },
  { id: "tpe", name: "Taipei", country: "TW", timeZone: "Asia/Taipei", weight: 0.4, lat: 25.033, lon: 121.5654 },
  { id: "icn", name: "Seoul", country: "KR", timeZone: "Asia/Seoul", weight: 0.6, lat: 37.5665, lon: 126.978 },
  { id: "nrt", name: "Tokyo", country: "JP", timeZone: "Asia/Tokyo", weight: 0.9, lat: 35.6762, lon: 139.6503 },
  { id: "kix", name: "Osaka", country: "JP", timeZone: "Asia/Tokyo", weight: 0.4, lat: 34.6937, lon: 135.5023 },
  { id: "pvg", name: "Shanghai", country: "CN", timeZone: "Asia/Shanghai", weight: 0.7, lat: 31.2304, lon: 121.4737 },
  { id: "syd", name: "Sydney", country: "AU", timeZone: "Australia/Sydney", weight: 0.6, lat: -33.8688, lon: 151.2093 },
  {
    id: "mel",
    name: "Melbourne",
    country: "AU",
    timeZone: "Australia/Melbourne",
    weight: 0.4,
    lat: -37.8136,
    lon: 144.9631,
  },
  {
    id: "akl",
    name: "Auckland",
    country: "NZ",
    timeZone: "Pacific/Auckland",
    weight: 0.3,
    lat: -36.8485,
    lon: 174.7633,
  },
  { id: "per", name: "Perth", country: "AU", timeZone: "Australia/Perth", weight: 0.2, lat: -31.9505, lon: 115.8605 },
];

/**
 * 16 generic deployment regions at real metro coordinates, label = id. The first 12 are the core set, spread over every
 * inhabited continent, in this order (us-east, us-west, sa-east, eu-west, eu-central, eu-north, me-central, af-south, ap-south,
 * ap-southeast, ap-northeast, au-east); us-central, ca-central, eu-south and ap-east follow. Use
 * `DEMO_REGIONS.slice(0, 12)` for the core set.
 */
export const DEMO_REGIONS: readonly GeoRegion[] = [
  { id: "us-east", label: "us-east", city: "Ashburn", timeZone: "America/New_York", lat: 39.0438, lon: -77.4874 },
  {
    id: "us-west",
    label: "us-west",
    city: "San Francisco",
    timeZone: "America/Los_Angeles",
    lat: 37.7749,
    lon: -122.4194,
  },
  { id: "sa-east", label: "sa-east", city: "São Paulo", timeZone: "America/Sao_Paulo", lat: -23.5505, lon: -46.6333 },
  { id: "eu-west", label: "eu-west", city: "Dublin", timeZone: "Europe/Dublin", lat: 53.3498, lon: -6.2603 },
  { id: "eu-central", label: "eu-central", city: "Frankfurt", timeZone: "Europe/Berlin", lat: 50.1109, lon: 8.6821 },
  { id: "eu-north", label: "eu-north", city: "Stockholm", timeZone: "Europe/Stockholm", lat: 59.3293, lon: 18.0686 },
  { id: "me-central", label: "me-central", city: "Dubai", timeZone: "Asia/Dubai", lat: 25.2048, lon: 55.2708 },
  {
    id: "af-south",
    label: "af-south",
    city: "Johannesburg",
    timeZone: "Africa/Johannesburg",
    lat: -26.2041,
    lon: 28.0473,
  },
  { id: "ap-south", label: "ap-south", city: "Mumbai", timeZone: "Asia/Kolkata", lat: 19.076, lon: 72.8777 },
  {
    id: "ap-southeast",
    label: "ap-southeast",
    city: "Singapore",
    timeZone: "Asia/Singapore",
    lat: 1.3521,
    lon: 103.8198,
  },
  { id: "ap-northeast", label: "ap-northeast", city: "Tokyo", timeZone: "Asia/Tokyo", lat: 35.6762, lon: 139.6503 },
  { id: "au-east", label: "au-east", city: "Sydney", timeZone: "Australia/Sydney", lat: -33.8688, lon: 151.2093 },
  { id: "us-central", label: "us-central", city: "Dallas", timeZone: "America/Chicago", lat: 32.7767, lon: -96.797 },
  { id: "ca-central", label: "ca-central", city: "Toronto", timeZone: "America/Toronto", lat: 43.6532, lon: -79.3832 },
  { id: "eu-south", label: "eu-south", city: "Milan", timeZone: "Europe/Rome", lat: 45.4642, lon: 9.19 },
  { id: "ap-east", label: "ap-east", city: "Hong Kong", timeZone: "Asia/Hong_Kong", lat: 22.3193, lon: 114.1694 },
];

let citiesById: Map<string, GeoCity> | null = null;
let regionsById: Map<string, GeoRegion> | null = null;

/** The demo city with an id ('lhr'), or undefined. */
export function findCity(id: string): GeoCity | undefined {
  citiesById ??= new Map(DEMO_CITIES.map((city) => [city.id, city]));
  return citiesById.get(id);
}

/** The demo region with an id ('eu-central'), or undefined. */
export function findRegion(id: string): GeoRegion | undefined {
  regionsById ??= new Map(DEMO_REGIONS.map((region) => [region.id, region]));
  return regionsById.get(id);
}

/** murmur3's 32-bit finaliser: an integer to a well-mixed unsigned integer. */
function mix32(value: number): number {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A deterministic random stream in [0, 1) (mulberry32). Seed with a number (integers and fractions both spread) or a
 * string (an id). Use it for demo data, in effects or in pure memoised builders, never Math.random in render.
 */
export function createRandom(seed: number | string): () => number {
  let state: number;
  if (typeof seed === "string") state = stringHash(seed) | 0;
  else if (!Number.isFinite(seed)) state = 0;
  else state = (Number.isInteger(seed) ? seed : Math.floor(seed * 4_294_967_296)) | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A weighted random choice: `weight` gives each item's weight (negative and NaN count as 0; all zero picks evenly).
 * No allocation. Throws on an empty list.
 */
export function pickWeighted<T>(random: () => number, items: readonly T[], weight: (item: T) => number): T {
  if (items.length === 0) throw new Error("pickWeighted: the list is empty");
  let total = 0;
  for (const item of items) {
    const w = weight(item);
    if (w > 0) total += w;
  }
  if (!(total > 0)) return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  let remaining = random() * total;
  let last = items[0];
  for (const item of items) {
    const w = weight(item);
    if (!(w > 0)) continue;
    last = item;
    remaining -= w;
    if (remaining < 0) return item;
  }
  return last;
}

/**
 * A point scattered around `center` with a Gaussian spread (σ = `km` in each direction), along a great circle so it
 * holds near the poles and the antimeridian. With `landOnly`, retries up to 8 times to land on the 0.5° land mask;
 * when every try lands in water (small islands, some coastal cities) it returns the try closest to the centre, so
 * points never stack on one spot. Two draws of `random` per try.
 */
export function scatterAround(random: () => number, center: LatLon, km: number, landOnly = false): LatLon {
  if (!(km > 0)) return { lat: center.lat, lon: wrapLongitude(center.lon) };
  let closest: LatLon = center;
  let closestRadius = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < (landOnly ? 9 : 1); attempt++) {
    // Box-Muller: a Rayleigh radius and a uniform bearing give a 2D normal distribution
    const radius = km * Math.sqrt(-2 * Math.log(1 - random()));
    const point = destinationPoint(center, random() * 360, radius);
    if (!landOnly || isLand(point.lat, point.lon)) return point;
    if (radius < closestRadius) {
      closest = point;
      closestRadius = radius;
    }
  }
  return closest;
}

/** Integer key of a point rounded to 0.1°, for order-independent pair seeds. */
const pointKey = (point: LatLon) =>
  Math.round((point.lat + 90) * 10) * 3601 + Math.round((wrapLongitude(point.lon) + 180) * 10);

/**
 * An invented but plausible round-trip time in whole ms: fiberRttMs(distanceKm) × a stretch from 1.3 to 1.9 seeded by
 * the pair's coordinates rounded to 0.1° (the same in both directions, the same on every render), plus 2 ms.
 */
export function demoLatency(a: LatLon, b: LatLon): number {
  const keyA = pointKey(a);
  const keyB = pointKey(b);
  const seed = mix32(Math.imul(Math.min(keyA, keyB), 0x9e3779b1) ^ Math.max(keyA, keyB));
  const stretch = 1.3 + 0.6 * (seed / 4_294_967_296);
  return Math.round(fiberRttMs(distanceKm(a, b)) * stretch + 2);
}

/** A seeded demo point near a demo city. */
export interface DemoPoint extends LatLon {
  /** 'p0', 'p1', … in generation order. */
  readonly id: string;
  /** Id of the city it was scattered around. */
  readonly city: string;
}

/** Options of `demoPoints`. */
export interface DemoPointsOptions {
  /** Cities to scatter around, picked by `weight`. Default DEMO_CITIES. */
  cities?: readonly GeoCity[];
  /** Base spread in km; each city uses spreadKm × (0.5 + weight). Default 160. */
  spreadKm?: number;
  /** Keep points on land. Default true. */
  landOnly?: boolean;
}

/**
 * `count` deterministic demo points: a city picked by weight, then scatterAround it. The same seed gives the same
 * points on the server and the client, so it may run in a memo during render. For demo props only.
 */
export function demoPoints(count: number, seed: number | string = 1, options: DemoPointsOptions = {}): DemoPoint[] {
  const { cities = DEMO_CITIES, spreadKm = 160, landOnly = true } = options;
  const random = createRandom(seed);
  const points: DemoPoint[] = [];
  if (cities.length === 0) return points;
  for (let i = 0; i < count; i++) {
    const city = pickWeighted(random, cities, (item) => item.weight);
    const point = scatterAround(random, city, spreadKm * (0.5 + Math.max(0, city.weight)), landOnly);
    points.push({ id: `p${i}`, city: city.id, lat: point.lat, lon: point.lon });
  }
  return points;
}
