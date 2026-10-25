---
name: gallery-artifact-design
description: Design and implementation guidance for Gallery HTML artifacts. Load before writing any HTML/CSS/JS for a Gallery share, including React artifacts and skill-instructed Markdown-turned-HTML. Covers the sandbox contract, self-contained assets, layout, theming, and interaction states.
---

# Gallery Artifact Design

A Gallery artifact is a real web page viewed by other people, inside a sandbox.
Design it as a finished product, not a demo snippet.

## The sandbox contract (shapes your code)

HTML runs in an **opaque origin**: CSP `sandbox allow-scripts allow-forms
allow-modals allow-popups allow-downloads`, plus the same flags on the preview
iframe. Consequences:

- **No `localStorage` / `sessionStorage` / IndexedDB / cookies** — access throws
  or is inert. Persist through the Gallery SDK instead (load `gallery-page-data`),
  or keep state in memory for purely ephemeral tools.
- No same-origin access to the Gallery app, no reading the parent's DOM, no
  service workers. Do not try to work around this; it is the security boundary.
- Scripts, forms, `alert`/`confirm`, popups, and downloads work. Network requests
  to CDNs work, but prefer self-contained files (below).
- The SDK bridge (`/sdk/page-state-v1.js`) only connects on the `/s/<slug>`
  preview. Always feature-detect with `Gallery.getCapabilities()` and degrade
  gracefully when a capability is off or the file is opened directly.

## Self-contained by default

- Single-file artifacts: inline CSS and JS in one `.html`. Give it a real
  `<title>`, `<meta charset="utf-8">`, and a viewport meta.
- Multi-file artifacts: relative paths only (`./style.css`, `assets/logo.svg`);
  never absolute paths into the Gallery app except the SDK `/sdk/page-state-v1.js`.
- Avoid external dependencies. If a library truly earns its place, use one pinned
  version from a reputable CDN and make the page still render its content if the
  CDN fails. No external fonts required for the design to hold together.
- No tracking pixels, no exfiltrating visitor data to third parties, no credential
  or payment forms that imitate a real service.

## Layout

- Works at phone width first: 16px side gutter, no horizontal page scroll, touch
  targets ≥40px. Then scale up to a comfortable max-width content column.
- One clear primary action per view. Dense data gets structure (table, cards,
  filters), not walls of text.
- Respect the embed context: with `?embed=1` the page sits in a small iframe, so
  avoid layouts that only work fullscreen and avoid fixed viewport-height traps
  (`100vh` inside iframes is fragile; prefer content-sized layout or `100dvh`
  with a fallback).

## Theming

- Define colors as CSS custom properties on `:root`; re-define them under
  `@media (prefers-color-scheme: dark)`. Give `body` an explicit `background` and
  `color` so the page never flashes unstyled.
- Keep contrast ≥4.5:1 for body text in both themes; do not communicate state by
  color alone.
- Motion is optional and subtle; honor `prefers-reduced-motion`.

## Interaction states — design all four

1. **Loading**: skeleton or spinner while SDK/LLM calls are in flight; disable
   the triggering button.
2. **Empty**: a useful first-run state (sample content, or one clear call to
   action) — never a blank panel.
3. **Error**: human-readable message plus retry; surface SDK conflict/permission
   errors honestly instead of swallowing them.
4. **Success**: optimistic UI only where a failed write can be rolled back
   visibly; shared writes should reconcile from the server snapshot.

For realtime artifacts, show whether the view is live (connected via
`Gallery.events`) and refresh data on change events rather than polling.

## Finish check

Before uploading: the page renders with JS capabilities disabled, at 360px and
desktop widths, in light and dark mode; no console errors; no placeholder text;
title/metadata set via `update_share_metadata` when the default filename is not
a good public title.
