/**
 * Champions Group one-pager for the A2 agent job (POST /api/v1/assistant/pages). The model writes the
 * copy (PageContent), this file writes the markup: one self-contained document, inline <style>, no
 * script, no image, no external URL except the CTA href, and every string HTML-escaped.
 * Tokens: champions-group-brand SKILL.md (orange + white). "Champions Group" is text only, no logo
 * image (ruling t_79fe95af).
 */
import { z } from "zod";
import { escapeHtml as esc } from "../../lib/accessPages";

export const PageContent = z.object({
  headline: z.string().min(8).max(90),
  subhead: z.string().max(200),
  pains: z.array(z.string().min(4).max(160)).min(2).max(4),
  how_we_help: z.array(z.object({ title: z.string().min(2).max(60), body: z.string().min(10).max(280) })).min(2).max(4),
  proof: z.array(z.string().max(160)).max(3),
  cta_label: z.string().min(2).max(40),
});
export type PageContent = z.infer<typeof PageContent>;

const STYLE = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#FFFFFF;color:#1A1A1A;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:16px;line-height:1.6}
main{max-width:760px;margin:0 auto;padding:56px 32px 40px}
.top{margin:0 0 20px;color:#6B6B6B;font-size:14px;font-weight:600;letter-spacing:0.01em}
h1{margin:0;color:#1A1A1A;font-size:40px;line-height:1.15;font-weight:700;letter-spacing:-0.01em}
.rule{width:64px;height:4px;margin:20px 0 0;border:0;border-radius:2px;background:#F26722}
.sub{margin:20px 0 0;font-size:19px;line-height:1.5;color:#2E2E2E}
h2{margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:#1A1A1A}
section{margin-top:44px}
.heard ul,.proof ul{margin:0;padding:0;list-style:none}
.heard li,.proof li{position:relative;padding:12px 0 12px 22px;border-top:1px solid #E5E7EB}
.heard li:last-child,.proof li:last-child{border-bottom:1px solid #E5E7EB}
.heard li::before{content:"";position:absolute;left:0;top:22px;width:8px;height:8px;border-radius:2px;background:#F26722}
.proof li::before{content:"";position:absolute;left:0;top:22px;width:8px;height:8px;border-radius:50%;border:2px solid #F26722}
.help{background:#FFF4EC;border-radius:16px;padding:32px}
.help ol{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
.help li{display:flex;gap:16px;align-items:flex-start}
.num{flex:0 0 40px;width:40px;height:40px;border-radius:50%;background:#F26722;color:#FFFFFF;font-size:20px;font-weight:700;line-height:40px;text-align:center}
.help h3{margin:6px 0 4px;font-size:17px;line-height:1.35;font-weight:700}
.help p{margin:0;color:#2E2E2E}
.act{margin-top:44px}
.cta{display:inline-flex;align-items:center;min-height:48px;padding:12px 24px;border-radius:8px;background:#F26722;color:#FFFFFF;font-size:19px;font-weight:700;text-decoration:none;transition:background-color .15s ease}
.cta:hover{background:#D94F0A}
.cta:focus-visible{outline:2px solid #1A1A1A;outline-offset:3px}
footer{margin-top:56px;padding-top:16px;border-top:1px solid #E5E7EB;color:#6B6B6B;font-size:14px}
@media (max-width:639.98px){
  main{padding:32px 20px 28px}
  h1{font-size:32px}
  .sub{font-size:17px}
  .help{padding:24px 20px}
  .cta{display:flex;justify-content:center}
}
@media (prefers-reduced-motion:reduce){.cta{transition:none}}
`;

export function renderChampionsGroup(content: PageContent, opts: { company: string; ctaUrl?: string | null; title?: string | null }): string {
  const company = esc(opts.company);
  const title = esc(opts.title || `${opts.company}: ${content.headline}`.slice(0, 120));
  const pains = content.pains.map((p) => `<li>${esc(p)}</li>`).join("");
  const steps = content.how_we_help
    .map((s, i) => `<li><span class="num" aria-hidden="true">${i + 1}</span><div><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p></div></li>`)
    .join("");
  const proof = content.proof.length
    ? `<section class="proof"><h2>Proof</h2><ul>${content.proof.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></section>`
    : "";
  const cta = opts.ctaUrl ? `<div class="act"><a class="cta" href="${esc(opts.ctaUrl)}" rel="noopener">${esc(content.cta_label)}</a></div>` : "";
  const sub = content.subhead ? `<p class="sub">${esc(content.subhead)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="top">Champions Group for ${company}</p>
<h1>${esc(content.headline)}</h1>
<hr class="rule">
${sub}
<section class="heard"><h2>What we heard</h2><ul>${pains}</ul></section>
<section class="help"><h2>How we help</h2><ol>${steps}</ol></section>
${proof}
${cta}
<footer>Prepared for ${company} by Champions Group.</footer>
</main>
</body>
</html>
`;
}
