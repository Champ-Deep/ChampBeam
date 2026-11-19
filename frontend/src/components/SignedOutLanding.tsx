import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, BarChart3, Code2, FileText, Globe, Link2, Users } from 'lucide-react';
import { useReducedMotion, motion } from 'motion/react';
import { BeamGlobe } from './ui/beam-globe';
import { LandingHills } from './ui/landing-hills';
import { LogoMark } from './ui/Logo';
import './signed-out-landing.css';

const tabs = [
  { name: 'Files', Icon: FileText, title: 'A file to keep.', copy: 'Share the download. Follow the open.' },
  { name: 'Pages', Icon: Globe, title: 'A page to explore.', copy: 'Publish your content. See the response.' },
  { name: 'Links', Icon: Link2, title: 'A link to follow.', copy: 'Send people anywhere. Keep the click in view.' },
  { name: 'Analytics', Icon: BarChart3, title: 'The story after send.', copy: 'Read opens, locations and devices in one place.' },
] as const;

// Captures of the actual Files, Pages, Links and Analytics routes with synthetic data.
const screens = [
  { name: 'files', focus: {"--focus-left": "18.584%", "--focus-top": "19.777%", "--focus-width": "5.514%", "--focus-height": "2.286%", "--mobile-focus-left": "59.216%", "--mobile-focus-top": "33.287%", "--mobile-focus-width": "18.263%", "--mobile-focus-height": "3.200%"} },
  { name: 'pages', focus: {"--focus-left": "13.316%", "--focus-top": "16.920%", "--focus-width": "5.514%", "--focus-height": "2.286%", "--mobile-focus-left": "35.938%", "--mobile-focus-top": "29.288%", "--mobile-focus-width": "18.263%", "--mobile-focus-height": "3.200%"} },
  { name: 'links', focus: {"--focus-left": "61.970%", "--focus-top": "10.714%", "--focus-width": "6.364%", "--focus-height": "13.214%", "--mobile-focus-left": "28.266%", "--mobile-focus-top": "19.000%", "--mobile-focus-width": "21.078%", "--mobile-focus-height": "18.500%"} },
  { name: 'analytics', focus: {"--focus-left": "2.465%", "--focus-top": "45.143%", "--focus-width": "69.718%", "--focus-height": "48.357%", "--mobile-focus-left": "0.000%", "--mobile-focus-top": "20.000%", "--mobile-focus-width": "100.000%", "--mobile-focus-height": "67.700%"} }
] as const;

function ProductScreen({ active }: { active: number }) {
  const screen = screens[active] ?? screens[0];
  const name = (tabs[active] ?? tabs[0]).name;
  return <div className="beam-product-screen" data-screen={name}>
    <div className="beam-screen-top"><span><LogoMark size={20} />{name}</span><span className="beam-sample-label">Sample data</span></div>
    <div className="beam-product-capture" style={screen.focus as CSSProperties}>
      <picture><source media="(max-width: 699px)" srcSet={`/landing/${screen.name}-375.webp`} /><img src={`/landing/${screen.name}-1440.webp`} width="1136" height="700" alt={`ChampBeam ${name} screen with synthetic sample records. ${name === 'Files' ? 'Project brief.pdf has 12 opens.' : name === 'Pages' ? 'Project overview has 24 views.' : name === 'Links' ? 'The sample link has 18 clicks.' : 'A chart shows daily opens for sample files and pages.'}`} /></picture>
      <span className="beam-capture-focus" aria-hidden="true" />
    </div>
  </div>;
}

// Layout adapted from ruixen.ui Preview Switch Hero, 21st.dev 13448.
function ProductBand() {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false), { threshold: 0.25 });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (reduced || hovered || focused || !visible) return;
    const interval = window.setInterval(() => setActive((prev) => (prev + 1) % tabs.length), 5000);
    return () => window.clearInterval(interval);
  }, [reduced, hovered, focused, visible]);
  const select = (index: number, focus = false) => {
    setActive(index);
    if (focus) document.getElementById(`beam-preview-tab-${index}`)?.focus();
  };
  return <section ref={ref} className="beam-landing-section beam-product-band beam-landing-container" aria-labelledby="beam-product-heading" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocusCapture={() => setFocused(true)} onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="beam-section-heading"><h2 id="beam-product-heading">See what happens<br />after you share.</h2><p>Files, pages and links. <br />One place to follow them.</p></div>
    <div className="beam-product-layout">
      <div className="beam-preview-rail" role="tablist" aria-label="Product preview" aria-orientation="vertical">{tabs.map(({ name, Icon, copy }, i) => <button key={name} id={`beam-preview-tab-${i}`} type="button" role="tab" aria-selected={active === i} aria-controls="beam-preview-panel" tabIndex={active === i ? 0 : -1} onClick={() => select(i)} onKeyDown={(event) => {
        let next = i;
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (i + tabs.length - 1) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault(); select(next, true);
      }}><span><Icon size={20} aria-hidden="true" />{name}<ArrowUpRight size={16} aria-hidden="true" /></span><small>{copy}</small></button>)}</div>
      <div id="beam-preview-panel" role="tabpanel" aria-labelledby={`beam-preview-tab-${active}`} tabIndex={0} className="beam-preview-panel"><div key={active} className="beam-preview-enter"><ProductScreen active={active} /></div></div>
    </div>
    <p className="beam-preview-caption">{(tabs[active] ?? tabs[0]).title} <span>Illustrative product preview. All records and counts are sample data.</span></p>
  </section>;
}

const features = [
  { name: 'Files', Icon: FileText, value: 'Send the download, not the attachment.', detail: 'PDF · ZIP · Images · Video', crop: 'Project brief.pdf' },
  { name: 'Pages', Icon: Globe, value: 'Give your content a place to live.', detail: 'HTML, documents and media', crop: 'Ready to view.' },
  { name: 'Links', Icon: Link2, value: 'Keep the click after the redirect.', detail: 'Tracked links and UTM parameters', crop: 'One link. A clear trail.' },
  { name: 'Analytics', Icon: BarChart3, value: 'See where opens come from.', detail: 'Opens · Locations · Devices', crop: 'Beyond the send.' },
  { name: 'Team', Icon: Users, value: 'Share work within your organization.', detail: 'Organization access and reporting', crop: 'Work, together.' },
  { name: 'Agent API', Icon: Code2, value: 'Make sharing part of your workflow.', detail: 'API keys managed in Settings', crop: 'GET /api/v1/files' },
];

export function SignedOutLanding() {
  const reduced = useReducedMotion();
  return <div className="beam-landing">
    <section className="beam-landing-hero beam-landing-container">
      <div><h1>Share with ChampBeam</h1><p className="beam-hero-lede">Files to download.<br />Pages to view. Links to track.</p><p className="beam-hero-support">Sign in to host a page, send a file or track a link.</p><div className="beam-landing-actions"><Link to="/sign-in" className="beam-landing-primary">Sign in<ArrowUpRight size={18} aria-hidden="true" /></Link><Link to="/sign-up" className="beam-landing-secondary">Sign up<ArrowRight size={18} aria-hidden="true" /></Link></div></div>
      <BeamGlobe />
    </section>
    <ProductBand />
    <section className="beam-landing-section beam-landing-container" aria-labelledby="beam-features-heading">
      <div className="beam-section-heading"><h2 id="beam-features-heading">Everything you share.<br />Nothing left to guess.</h2><p>Choose the right format. <br />Keep the response in sight.</p></div>
      {/* Adapted from avanishverma4 bento grid 01, 21st.dev 9594. */}
      <div className="beam-landing-bento">{features.map(({ name, Icon, value, detail, crop }) => <motion.article key={name} initial={false} whileInView={reduced ? undefined : { opacity: [0.65, 1], y: [16, 0] }} viewport={{ once: true, amount: 0.2 }} transition={{ duration: 0.45 }}><div className="beam-feature-visual" aria-hidden="true"><Icon size={34} strokeWidth={1.2} /><span>{crop}</span></div><div><h3>{name}</h3><p>{value}</p><small>{detail}</small></div></motion.article>)}</div>
    </section>
    {/* Adapted from ln-dev7 How It Works Steps, 21st.dev 26891. */}
    <section className="beam-landing-section beam-landing-container beam-landing-how" aria-labelledby="beam-how-heading"><h2 id="beam-how-heading">From send to seen.</h2><ol>{['Share a file, page or link.', 'Send it anywhere.', 'See who opened it and where.'].map((step, i) => <li key={step}><span>{i + 1}</span><h3>{step}</h3></li>)}</ol><Link to="/sign-up" className="beam-landing-primary">Start sharing<ArrowRight size={18} aria-hidden="true" /></Link></section>
    {/* Adapted from kedhareswer Hills Landscape Footer, 21st.dev 44510. */}
    <footer className="beam-landing-footer"><div className="beam-landing-container beam-footer-cta"><h2>Send it. Know they saw it.</h2><div className="beam-landing-actions"><Link to="/sign-up" className="beam-landing-primary">Sign up<ArrowUpRight size={18} aria-hidden="true" /></Link><Link to="/sign-in" className="beam-landing-secondary">Sign in<ArrowRight size={18} aria-hidden="true" /></Link></div></div><LandingHills /><div className="beam-footer-ground"><div className="beam-landing-container"><Link to="/" className="beam-footer-brand"><LogoMark size={28} />ChampBeam</Link><nav aria-label="Footer"><Link to="/sign-in">Sign in</Link><Link to="/sign-up">Sign up</Link><Link to="/">Generator</Link></nav><p>Files to download. Pages to view. Links to track.</p></div></div></footer>
  </div>;
}
