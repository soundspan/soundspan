# soundspan Brand Policy

This document defines how the `soundspan` name and related brand assets should be used.

This is an operational policy, not legal advice.

## Scope

This policy applies to:

- `soundspan` word mark usage in product, docs, sites, and social channels
- Logos, icons, and visual identity assets distributed with this repository
- Third-party references to this project name and branding

## Project Identity

- Canonical product name: `soundspan`
- Canonical slug/token: `soundspan`
- Official site: `https://soundspan.io`
- Official repository: `https://github.com/soundspan/soundspan`

Fork attribution remains required:

- soundspan is a fork of `Chevron7Locked/kima-hub`.
- Attribution and GPL obligations are preserved and must not be removed.

## Color Palette

soundspan uses a blue gradient palette derived from the icon assets (deep navy center bars through bright cyan edge dots).

### Brand Colors

| Role | Hex | Tailwind | Usage |
|------|-----|----------|-------|
| Primary | `#3b82f6` | `blue-500` / `brand.DEFAULT` | CTAs, focus rings, active states |
| Hover | `#60a5fa` | `blue-400` / `brand.hover` | Hover highlights, EQ bars, light accents |
| Light | `#93c5fd` | `blue-300` / `brand.light` | Light accent text, subtle backgrounds |
| Dark | `#2563eb` | `blue-600` / `brand.dark` | Pressed/active states, dark accents |
| Deep | `#1d4ed8` | `blue-700` | Deep pressed states |
| Gradient end | `#38bdf8` | `sky-400` | SeekSlider gradient terminus, icon edge dots |

### CSS Variable

```css
--color-primary: #3b82f6; /* PRIMARY CTA ONLY - Blue */
```

### Accent Colors (non-brand)

These colors are functional and independent from the brand palette:

| Role | Hex | Notes |
|------|-----|-------|
| AI features | `#a855f7` | Purple — used for AI/smart features only |
| Success | `#22c55e` | Functional status |
| Warning | `#f59e0b` | Functional status (amber, not brand) |
| Error | `#ef4444` | Functional status |
| Info | `#3b82f6` | Matches primary |

### Gradient Direction

The brand gradient flows from blue to cyan, matching the icon's bar progression:

```
from-[#3b82f6] to-[#38bdf8]  /* blue-500 → sky-400 */
```

### TV Mode

TV mode uses a subtle dark blue tinted background instead of pure black:

```css
linear-gradient(180deg, #0a1628 0%, #0a0a0a 100%)
```

## Permitted Uses

You may use the soundspan name/logo when you are accurately referring to:

- The unmodified upstream soundspan project
- A compatible deployment, package, or mirror of soundspan
- Documentation, tutorials, reviews, and integration guides about soundspan

Requirements:

- Do not imply endorsement, partnership, or sponsorship unless explicitly granted.
- Keep branding intact (no misleading edits that imply official status).
- Preserve license notices and fork attribution where required.

## Restricted Uses

Do not:

- Use soundspan branding for unrelated products/services
- Present modified forks as the official soundspan project
- Reuse logos/name in a way likely to confuse users about source or ownership
- Register domains/org names/packages intended to impersonate official channels

## Fork/Derivative Naming Guidance

If you distribute a modified version:

- Use a distinct project name/logo for the modified product
- Keep explicit lineage attribution (for example: "Forked from soundspan")
- Avoid names/marks that are confusingly similar to soundspan branding

## "Not Affiliated" Language

When appropriate (especially commercial/public distributions), include clear language such as:

- "Not affiliated with the official soundspan project."
- "soundspan is a trademark/brand used by this project; this deployment is independently operated."

## Reporting Brand Misuse

For reported misuse/impersonation concerns, open an issue at:

- `https://github.com/soundspan/soundspan/issues`

Include links/screenshots and a concise description of the confusion risk.
