/** Transactional email through the Cloudflare Email Service binding. No binding means nothing is sent. */
import type { Env, Settings } from "../env";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Plain text plus a simple HTML twin: one paragraph, one button-style link. */
export function sendMail(env: Env, settings: Settings, m: { to: string; subject: string; body: string; linkLabel: string; url: string }): Promise<unknown> {
  if (!env.EMAIL) return Promise.resolve();
  return env.EMAIL.send({
    to: m.to,
    from: settings.emailFrom,
    subject: m.subject,
    text: `${m.body}\n\n${m.linkLabel}: ${m.url}\n`,
    html: `<p>${esc(m.body)}</p><p><a href="${esc(m.url)}">${esc(m.linkLabel)}</a></p><p style="color:#666;font-size:12px">${esc(m.url)}</p>`,
  });
}
