/**
 * Link attribution, slice 1: deterministic classifiers that run on the click
 * path with no external call (design: Projects/Champbeam/decisions/2026-10-29-link-attribution.md).
 *
 *   classifyChannel(...)   -> where the click came from (D)
 *   detectScanner(...)     -> email-security prefetch, flagged never dropped (F)
 *   classifyVisitor(...)   -> what kind of network the visitor is on (E)
 */
import { isHostingAsn } from "./geoip";

export type Channel = "email" | "paid_social" | "organic_social" | "search" | "referral" | "qr" | "direct" | "in_app";
export type VisitorType = "scanner" | "bot" | "hosting" | "vpn" | "business" | "mobile" | "residential";

const SOCIAL = [
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "lnkd.in", "twitter.com", "t.co", "x.com",
  "reddit.com", "youtube.com", "youtu.be", "pinterest.com", "tiktok.com", "whatsapp.com", "wa.me",
  "t.me", "telegram.org", "threads.net", "bsky.app",
];
const SEARCH = ["bing.com", "duckduckgo.com", "yahoo.com", "baidu.com", "ecosia.org", "yandex.com", "yandex.ru", "brave.com"];

const hostOf = (referrer: string | null | undefined): string | null => {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
};
const inList = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));
const isSocialName = (s: string) => SOCIAL.some((d) => s === d.split(".")[0] || s === d);
const isSearchName = (s: string) => s === "google" || SEARCH.some((d) => s === d.split(".")[0] || s === d);

export function classifyChannel(args: {
  referrer: string | null;
  utmMedium: string | null;
  utmSource: string | null;
  /** shortcut: QR is only known from utm_medium=qr on the link; upgrade when the QR route stamps scans itself. */
  isQr?: boolean;
}): Channel {
  const medium = (args.utmMedium ?? "").trim().toLowerCase();
  const source = (args.utmSource ?? "").trim().toLowerCase();
  const refHost = hostOf(args.referrer);
  const social = isSocialName(source) || (refHost != null && inList(refHost, SOCIAL));
  const search = isSearchName(source) || (refHost != null && (/(^|\.)google\./.test(refHost) || inList(refHost, SEARCH)));

  if (args.isQr || medium === "qr") return "qr";
  if (/^(e-?mail|newsletter)$/.test(medium) || /^(e-?mail|newsletter)$/.test(source)) return "email";
  if (/^(cpc|ppc|paid|paid[-_ ]?social|cpm|display|retargeting)$/.test(medium)) return social ? "paid_social" : "search";
  if (social) return "organic_social";
  if (search) return "search";
  if (args.referrer?.startsWith("android-app://")) return "in_app";
  return refHost ? "referral" : "direct";
}

const SCANNER_UA = /barracuda|proofpoint|mimecast|safelinks|microsoft office|ironport|forcepoint|symantec|trendmicro|fireeye|urldefense/i;
const SCANNER_ASN = /proofpoint|mimecast|barracuda|ironport/i;

/**
 * shortcut: no "first click within seconds of send" test (send time is unknown to the Worker);
 * upgrade when per-recipient sends are recorded. Rules: HEAD, scanner UA, security-vendor ASN,
 * or a datacenter ASN that sends no Accept-Language (real browsers always do).
 */
export function detectScanner(args: {
  method: string;
  userAgent: string | null;
  asnOrg: string | null;
  acceptLanguage: string | null;
}): boolean {
  if (args.method.toUpperCase() === "HEAD") return true;
  if (args.userAgent && SCANNER_UA.test(args.userAgent)) return true;
  if (args.asnOrg && SCANNER_ASN.test(args.asnOrg)) return true;
  return isHostingAsn(args.asnOrg) && !args.acceptLanguage;
}

/** null when nothing supports a claim (we never label a visitor "residential" by default). */
export function classifyVisitor(args: {
  isScanner: boolean;
  deviceType: string | null;
  isVpn: boolean;
  asnOrg: string | null;
  companyType: string | null;
}): VisitorType | null {
  if (args.isScanner) return "scanner";
  if (args.deviceType === "bot") return "bot";
  const ct = (args.companyType ?? "").toLowerCase();
  if (ct === "hosting" || isHostingAsn(args.asnOrg)) return "hosting";
  if (args.isVpn) return "vpn";
  if (ct === "business" || ct === "education") return "business";
  if (ct === "isp") return args.deviceType === "mobile" ? "mobile" : "residential";
  return null;
}
