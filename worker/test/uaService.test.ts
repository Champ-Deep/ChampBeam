/**
 * UA parsing parity with the Python `user_agents` package (ua_service.py).
 * Expected values were produced by running the Python parse_user_agent on each
 * UA (user-agents 2.2.0 / ua-parser 1.0.2). Two known differences are not in the
 * corpus: Yandex Browser on Android (Python: "Chrome Mobile") and PlayStation OS
 * (Python: "Other").
 */
import { describe, expect, it } from "vitest";
import { parseUserAgent } from "../src/services/ua";

const CORPUS: [string, string, string, string][] = [
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "desktop", "Chrome", "Windows"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.51", "desktop", "Edge", "Windows"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0", "desktop", "Firefox", "Windows"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15", "desktop", "Safari", "Mac OS X"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "desktop", "Chrome", "Mac OS X"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0", "desktop", "Firefox", "Mac OS X"],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "desktop", "Chrome", "Linux"],
  ["Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", "desktop", "Firefox", "Ubuntu"],
  ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "desktop", "Chrome", "Chrome OS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "mobile", "Mobile Safari", "iOS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1", "mobile", "Chrome Mobile iOS", "iOS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15", "mobile", "Firefox iOS", "iOS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148", "mobile", "Mobile Safari UI/WKWebView", "iOS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/460.0.0.36.111;FBBV/585880553;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.4;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]", "mobile", "Facebook", "iOS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 330.0.3.18.85 (iPhone15,2; iOS 17_4; en_US; en; scale=3.00; 1179x2556; 598357893)", "mobile", "Instagram", "iOS"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 LinkedInApp/9.29.6955", "mobile", "Mobile Safari UI/WKWebView", "iOS"],
  ["Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1", "tablet", "Mobile Safari", "iOS"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36", "mobile", "Chrome Mobile", "Android"],
  ["Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36", "mobile", "Chrome Mobile", "Android"],
  ["Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36", "mobile", "Samsung Internet", "Android"],
  ["Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "tablet", "Chrome", "Android"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36", "mobile", "Chrome Mobile WebView", "Android"],
  ["Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0", "mobile", "Firefox Mobile", "Android"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.2478.64", "mobile", "Edge Mobile", "Android"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 OPR/81.0.4196.61", "mobile", "Opera Mobile", "Android"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 OPR/110.0.0.0", "desktop", "Opera", "Windows"],
  ["Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; rv:11.0) like Gecko", "desktop", "IE", "Windows"],
  ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "bot", "Googlebot", "Other"],
  ["Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "mobile", "Googlebot", "Android"],
  ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "bot", "bingbot", "Other"],
  ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "bot", "FacebookBot", "Other"],
  ["LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)", "bot", "LinkedInBot", "Other"],
  ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "bot", "Slackbot-LinkExpanding", "Other"],
  ["Twitterbot/1.0", "bot", "Twitterbot", "Other"],
  ["curl/8.4.0", "desktop", "curl", "Other"],
  ["python-requests/2.31.0", "desktop", "Python Requests", "Other"],
  ["Mozilla/4.0 (compatible; ms-office; MSOffice 16)", "desktop", "Outlook", "Other"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.10136", "desktop", "Edge", "Windows"],
  ["Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1; Microsoft; Lumia 950) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/52.0.2743.116 Mobile Safari/537.36 Edge/15.15063", "mobile", "Edge Mobile", "Windows Phone"],
  ["Mozilla/5.0 (Linux; U; Android 4.0.3; ko-kr; LG-L160L Build/IML74K) AppleWebkit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30", "mobile", "Android", "Android"],
  ["Mozilla/5.0 (Linux; Android 11; KFTRWI) AppleWebKit/537.36 (KHTML, like Gecko) Silk/124.3.1 like Chrome/124.0.6367.111 Safari/537.36", "tablet", "Amazon Silk", "Android"],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36", "desktop", "HeadlessChrome", "Linux"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)", "desktop", "Apple Mail", "Mac OS X"],
  ["WhatsApp/2.23.20.0 A", "bot", "WhatsApp", "Other"],
  ["Mozilla/5.0 (Linux; U; Android 13; en-US; SM-A045F Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 UCBrowser/13.6.6.1316 Mobile Safari/537.36", "mobile", "UC Browser", "Android"],
  ["Opera/9.80 (J2ME/MIDP; Opera Mini/9.80 (S60; SymbOS; Opera Mobi/23.348; U; en) Presto/2.5.25 Version/10.54", "mobile", "Opera Mini", "Symbian OS"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Vivaldi/6.7.3329.17", "desktop", "Vivaldi", "Windows"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 YaBrowser/24.4.0.0 Safari/537.36", "desktop", "Yandex Browser", "Windows"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Brave/124", "desktop", "Brave", "Windows"],
  ["foo", "desktop", "Other", "Other"],
  ["Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", "desktop", "GmailImageProxy", "Windows"],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (compatible; GPTBot/1.0; +https://openai.com/gptbot)", "desktop", "GPTBot", "Linux"],
  ["Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0 (Windows NT 10.0; Win64; x64; Trident/7.0; .NET4.0C; .NET4.0E; Microsoft Outlook 16.0.17425; Microsoft Outlook 16.0.17425; ms-office; MSOffice 16)", "desktop", "Outlook", "Windows"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/460.0.0.48.109;]", "mobile", "Facebook", "Android"],
  ["Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 Instagram 330.0.0.40.92 Android", "mobile", "Instagram", "Android"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/124.0.2478.50 Version/17.0 Mobile/15E148 Safari/604.1", "mobile", "Edge Mobile", "iOS"],
  ["Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", "desktop", "Firefox", "Fedora"],
  ["Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36", "desktop", "Chrome", "Windows"],
  ["Mozilla/5.0 (Windows NT 10.0; ARM; Touch) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "desktop", "Chrome", "Windows"],
  ["Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "tablet", "Chrome", "Android"],
  ["Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/6.0 TV Safari/538.1", "desktop", "Safari", "Tizen"],
];

describe("parseUserAgent", () => {
  it("returns all nulls for an empty UA", () => {
    expect(parseUserAgent("")).toEqual({ device_type: null, browser: null, os: null });
    expect(parseUserAgent(null)).toEqual({ device_type: null, browser: null, os: null });
  });

  it.each(CORPUS)("%s", (ua, deviceType, browser, os) => {
    expect(parseUserAgent(ua)).toEqual({ device_type: deviceType, browser, os });
  });
});
