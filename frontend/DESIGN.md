# ChampBeam domain setup

## 1. Visual Theme & Atmosphere
Extend the existing Settings document. DNS setup is a practical IT handoff, not a marketing surface. Keep the current domain row, house Card, Button, Badge and ConfirmDialog.

## 2. Color Palette & Roles
Use the product-specific --cb-* contract, overriding parent corporate tokens. Paper uses --cb-bg #FBF8F2, --cb-ink #241C14, --cb-accent #B3502F. Graphite uses #FAFAF9, #191C1D, #2F3437 respectively. Lagoon and Merlot inherit their existing token sets unchanged. Borders use --cb-border, metadata --cb-text-mid, inputs --cb-input. No new palette.

## 3. Typography Rules
Space Grotesk headings, Hanken Grotesk body. JetBrains Mono for hostnames, DNS names, values and URLs. Body 16px, table metadata 14px with 1.5 line height. Long tokens wrap anywhere.

## 4. Component Stylings
Semantic DNS table with Type, Name, Value, Purpose. Stack labelled cells on narrow screens without horizontal scrolling. CNAME carries the DNS only badge. Source: 21st.dev ncdai Copy Button, demo 28469. Adapt to house Button, visible feedback, no audio or haptics. Copy actions have a 44px target and visible focus. Copy all and download use the authenticated records.txt body exactly. Adoption uses the house confirmation and server dry-run counts.

## 5. Layout Principles
Keep SettingsPage and its query/mutation patterns. Domain details use existing row spacing. Actions wrap, text cells shrink, no nested decorative panels or fixed-width token fields.

## 6. Depth & Elevation
Existing house Card borders and elevation only. No glass, glow or additional shadows.

## 7. Do's and Don'ts
Do explain the next DNS step and automatic checks. Do surface clipboard, polling and adoption errors. Do preserve backend automatic adoption semantics. Do not imply a dry-run authorizes a migration that already happened. Do not hardcode counts, touch auth, deploy or change DNS.

## 8. Responsive Behavior
Device class: pointer surface with touch support. Verify 375, 768 and 1440px, Paper and Graphite. Stack table cells below 640px. All DNS controls remain 44px high. Motion budget: existing icon swap only, compositor transforms and opacity, reduced-motion disables animation. No expressive tier.

## 9. Agent Prompt Guide
Extend only DNS setup and adoption feedback. Use --cb-bg, --cb-text, --cb-ink, --cb-border and --cb-accent. Reuse the installed registry control and house components. Verify exact clipboard payloads, pending-to-active polling, collision messages and responsive geometry.
