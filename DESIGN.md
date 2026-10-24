# ChampBeam workspace

## 1. Visual Theme & Atmosphere
Operate mode. Preserve ChampBeam's existing identity and application shell. One paste/drop composer dominates; intent and destination follow the selected content. No marketing hero or decorative animation.

## 2. Color Palette & Roles
Preserve the existing product identity as required by the task. Paper uses warm canvas #FBF8F2, white surfaces, ink #241C14 and terracotta accent #B3502F. Primary actions use ink with explicit white text. Source of truth: frontend/src/index.css. Graphite, Lagoon, Merlot and Slate are alternate light workspace palettes with dark sidebars, not a separate dark-mode implementation. Parent Champions Orange is not substituted for existing product tokens in this refinement.

## 3. Typography Rules
Preserve existing Hanken Grotesk body and Space Grotesk headings, with system fallbacks. Heading 28px/1.2 bold, section 20px/1.3 semibold, body 16px/1.5, metadata 14px/1.5. No gradient text. This product-specific identity takes precedence over parent-brand defaults for the existing application.

## 4. Component Stylings
Reuse house inputs, buttons and status components. The composer mounts @21st/ephraimduncan/file-upload, @kokonutui/ai-prompt and @kokonutui/smooth-tab through ComposerControls, with documented compatibility patches. Inputs have visible labels, focus rings and 44px minimum targets. Separate empty, loading, authorization, missing-content and request-error states. Never substitute fixtures for real data.

## 5. Layout Principles
4px spacing scale. Content max-width 1120px. Composer first, recent resources second. Domain selection is separate from intent. Compact host options expand inline, not in a modal.

## 6. Depth & Elevation
Hairline dividers and solid surfaces. No glass, glow or nested cards. Preserve the existing sidebar contrast.

## 7. Do's and Don'ts
Use server permissions, host names, resource kinds and reporting scope. Never infer authorization from role names. Never imply shares are email sends. Preserve old addresses. Do not fabricate restored pages or a default domain.

## 8. Responsive Behavior
Device class: pointer surface with touch support. At 375px controls stack; at 768px and 1440px preserve readable content widths. Tables scroll within their own wrapper. Motion budget: no decorative entrance animation; registry tab changes respect reduced motion and new workspace surfaces disable transitions when requested. All five shipped palettes must remain readable.

## 9. Agent Prompt Guide
Preserve product identity. Put the user's content first, then ask what should happen when its recipient opens it. Downloads are Files, hosted media are Pages, external redirects and UTM work are Links. Match shared list queries for counts and recents. Report evidence and gaps without recovery claims.
