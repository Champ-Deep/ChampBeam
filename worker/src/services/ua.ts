/**
 * User-agent parsing. Port of backend/app/services/ua_service.py.
 *
 * The Python service used the `user_agents` package (uap-core regexes); here we
 * parse with `ua-parser-js` and map its names onto the uap-core families the
 * Python stored (e.g. "Mobile Chrome" on Android -> "Chrome Mobile", "macOS" ->
 * "Mac OS X"), and re-apply `user_agents`' is_mobile / is_tablet / is_bot rules
 * so `click_events.device_type/browser/os` keep the same vocabulary for the
 * analytics breakdowns. Verified against the Python output on a corpus of
 * common browsers, in-app browsers, mail clients and bots (test/uaService.test.ts).
 *
 * Exports:
 *   parseUserAgent(ua: string | null | undefined): UaInfo
 *     -> { device_type: "mobile"|"tablet"|"bot"|"desktop"|null, browser, os }
 *   type UaInfo
 */
import { UAParser, type UAParserExt } from "ua-parser-js";
import { CLIs, Crawlers, Emails, Fetchers, InApps, Libraries } from "ua-parser-js/extensions";

export interface UaInfo {
  device_type: string | null;
  browser: string | null;
  os: string | null;
}

// An array of extension sets is accepted at runtime; the .d.ts only types one set.
const EXTENSIONS = [Crawlers, Fetchers, InApps, Emails, CLIs, Libraries] as unknown as UAParserExt;

// user_agents' family lists.
const MOBILE_BROWSER_FAMILIES = new Set([
  "IE Mobile",
  "Opera Mobile",
  "Opera Mini",
  "Chrome Mobile",
  "Chrome Mobile WebView",
  "Chrome Mobile iOS",
]);
const MOBILE_OS_FAMILIES = new Set([
  "Windows Phone",
  "Windows Phone OS",
  "Symbian OS",
  "Bada",
  "Windows CE",
  "Windows Mobile",
  "Maemo",
]);

// uap-core's "Spider" device rules (the ones user_agents' is_bot keys off).
const SPIDER_RES: RegExp[] = [
  /^.{0,100}?(?:(?:iPhone|Windows CE|Windows Phone|Android).{0,300}(?:(?:Bot|Yeti)-Mobile|YRSpider|BingPreview|bots?\/\d|(?:bot|spider)\.html|Google-InspectionTool)|AdsBot-Google-Mobile.{0,200}iPhone)/i,
  /^.{0,100}?(?:DoCoMo|\bMOT\b|\bLG\b|Nokia|Samsung|SonyEricsson).{0,200}(?:(?:Bot|Yeti)-Mobile|bots?\/\d|(?:bot|crawler)\.html|(?:jump|google|Wukong)bot|ichiro\/mobile|\/spider|YahooSeeker)/i,
  / PTST\/\d+(?:\.\d+|)$/,
  /X11; Datanyze; Linux/,
  /Mozilla.{0,200}(AspiegelBot|PetalBot)/,
  /^.{0,100}(bot|BUbiNG|zao|borg|DBot|oegp|silk|Xenu|zeal|^NING|CCBot|crawl|htdig|lycos|slurp|teoma|voila|yahoo|Sogou|CiBra|Nutch|^Java\/|^JNLP\/|Daumoa|Daum|Genieo|ichiro|larbin|pompos|Scrapy|snappy|speedy|spider|msnbot|msrbot|vortex|^vortex|crawler|favicon|indexer|Riddler|scooter|scraper|scrubby|WhatWeb|WinHTTP|bingbot|BingPreview|openbot|gigabot|furlbot|polybot|seekbot|^voyager|archiver|Icarus6j|mogimogi|Netvibes|blitzbot|altavista|charlotte|findlinks|Retreiver|TLSProber|WordPress|SeznamBot|ProoXiBot|wsr-agent|Squrl Java|EtaoSpider|PaperLiBot|SputnikBot|A6-Indexer|netresearch|searchsight|baiduspider|YisouSpider|ICC-Crawler|http%20client|Python-urllib|dataparksearch|converacrawler|Screaming Frog|AppEngine-Google|YahooCacheSystem|fast-webcrawler|Sogou Pic Spider|semanticdiscovery|Innovazion Crawler|facebookexternalhit|Google.{0,200}\/\+\/web\/snippet|Google-HTTP-Java-Client|BlogBridge|IlTrovatore-Setaccio|InternetArchive|GomezAgent|WebThumbnail|heritrix|NewsGator|PagePeeker|Reaper|ZooShot|holmes|NL-Crawler|Pingdom|StatusCake|WhatsApp|masscan|Google Web Preview|Qwantify|Yeti|OgScrper|RecipeRadar|GPTBot|Google-InspectionTool)/i,
];

const BROWSER_RENAMES: Record<string, string> = {
  "Chrome WebView": "Chrome Mobile WebView",
  "Android Browser": "Android",
  Silk: "Amazon Silk",
  "Chrome Headless": "HeadlessChrome",
  Yandex: "Yandex Browser",
  UCBrowser: "UC Browser",
  facebookexternalhit: "FacebookBot",
  "python-requests": "Python Requests",
  "Microsoft Outlook": "Outlook",
  GoogleImageProxy: "GmailImageProxy",
  IEMobile: "IE Mobile",
  "Opera Mobi": "Opera Mobile",
};

const OS_RENAMES: Record<string, string> = {
  macOS: "Mac OS X",
  "Chromium OS": "Chrome OS",
  BlackBerry: "BlackBerry OS",
  Symbian: "Symbian OS",
};

function osFamily(name: string | undefined, ua: string): string {
  if (/SymbOS|SymbianOS|Series ?60/.test(ua)) return "Symbian OS";
  if (!name) return "Other";
  // ua-parser-js infers Android from bare app tokens (e.g. "WhatsApp/2.x A");
  // uap-core only reports it when the UA actually says so.
  if (name === "Android" && !/android/i.test(ua)) return "Other";
  return OS_RENAMES[name] ?? name;
}

function browserFamily(name: string | undefined, os: string, ua: string): string {
  const mobileOs = os === "Android" || os === "iOS" || os === "Windows Phone";
  if (/MSOffice|ms-office|Microsoft Outlook/.test(ua)) return "Outlook";
  if (!name) return "Other";
  switch (name) {
    case "Mobile Chrome":
      return os === "iOS" ? "Chrome Mobile iOS" : "Chrome Mobile";
    case "Mobile Firefox":
      return os === "iOS" ? "Firefox iOS" : "Firefox Mobile";
    case "WebKit":
      // AppleWebKit without a Safari token: an iOS in-app WebView, or Apple Mail on macOS.
      return os === "iOS" ? "Mobile Safari UI/WKWebView" : "Apple Mail";
    case "Edge":
      return mobileOs ? "Edge Mobile" : "Edge";
    case "Opera":
      return os === "Android" ? "Opera Mobile" : "Opera";
    default:
      return BROWSER_RENAMES[name] ?? name;
  }
}

/** Parse a User-Agent into device type, browser and OS (ua_service.parse_user_agent). */
export function parseUserAgent(ua: string | null | undefined): UaInfo {
  if (!ua) return { device_type: null, browser: null, os: null };

  const r = UAParser(ua, EXTENSIONS);
  const os = osFamily(r.os.name, ua);
  const browser = browserFamily(r.browser.name, os, ua);
  const model = r.device.model ?? "";
  const dtype = r.device.type;

  const isSpider = SPIDER_RES.some((re) => re.test(ua));

  // user_agents.is_tablet
  const isAndroidTablet = os === "Android" && !ua.includes("Mobile Safari") && browser !== "Firefox Mobile";
  const isTablet =
    (!isSpider && dtype === "tablet") ||
    model === "iPad" ||
    isAndroidTablet ||
    os.startsWith("Windows RT") ||
    (os === "Windows" && (r.os.version ?? "").startsWith("8") && ua.includes("Touch"));

  // user_agents.is_mobile
  const isMobile =
    model === "iPhone" ||
    model === "iPod" ||
    (!isSpider && dtype === "mobile" && os !== "Android") ||
    MOBILE_BROWSER_FAMILIES.has(browser) ||
    ((os === "Android" || os === "Firefox OS") && !isTablet) ||
    (os === "BlackBerry OS" && !/PlayBook/i.test(ua)) ||
    MOBILE_OS_FAMILIES.has(os) ||
    ua.includes("J2ME") ||
    ua.includes("MIDP") ||
    ua.includes("iPhone;") ||
    ua.includes("Googlebot-Mobile") ||
    (ua.includes("NokiaBrowser") && ua.includes("Mobile"));

  let device_type: string;
  if (isMobile) device_type = "mobile";
  else if (isTablet) device_type = "tablet";
  else if (isSpider) device_type = "bot";
  else device_type = "desktop";

  return { device_type, browser, os };
}
