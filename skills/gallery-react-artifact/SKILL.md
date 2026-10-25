---
name: gallery-react-artifact
description: Build Gallery artifacts on the pinned server-side React runtime — JSX/TSX entry with a default-exported component, relative imports and CSS, the strict dependency whitelist, multi-file publishing, and build/runtime error handling. Load before writing any .jsx/.tsx artifact or setting runtime=react.
---

# Gallery React Artifacts

React artifacts are bundled **on the server** with esbuild from the share's
virtual files. No npm install, no network dependency resolution, no execution of
uploaded source outside the browser sandbox. Externally the share is still HTML
(`kind`/`mimeType`), and the same sandbox and SDK rules as static HTML apply —
load `gallery-artifact-design` too.

## Hard constraints

- Entry file must be `.jsx` or `.tsx` and **default-export a component**. The
  host renders it into `#root` inside an error boundary — do not call
  `createRoot` yourself and do not render into `document.body`.
- Only these imports resolve, pinned to the server's React (**19.3.1**):
  `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`,
  `react/jsx-dev-runtime`. Everything else must be relative files within the
  artifact (`./components/Button.jsx`, `../lib/format.ts`).
- No other packages — no Tailwind runtime, no lodash, no CDN `import` from URLs.
  If you need a utility, ship it as a file in the artifact.
- JSX transform is automatic (`jsx: "automatic"`); no need to `import React` for
  JSX itself. TypeScript is stripped by esbuild, not type-checked — keep types
  simple and verify logic yourself.
- CSS: import `.css` files from your modules; the bundle is inlined into a
  `<style>` tag by the host. No CSS preprocessors.
- Target is modern browsers (`es2022`), output is one minified IIFE. Dynamic
  `import()` and code splitting are not a feature — keep the bundle in one graph.

## The SDK is already there

The generated page includes `<script src="/sdk/page-state-v1.js"></script>`
before your bundle, so use `window.Gallery` directly (load `gallery-page-data` /
`gallery-page-llm` as needed). Do not add another copy of the script tag.
Capabilities still must be enabled on the share and checked with
`Gallery.getCapabilities()`; hooks that touch SDK state should handle the
disabled case and loading/errors.

## Publishing

1. First upload the entry with `upload_file`:
   `filename: "index.jsx"`, `runtime: "react"`, plus capability flags.
2. Add the rest with `upload_share_files` (`files: [{path, content}]`,
   `entryPath: "index.jsx"` if needed). Every batch is validated before any
   write; the entry must exist and stay `.jsx`/`.tsx`.
3. Builds are content-addressed (sources + entry + React/builder version), so
   unchanged re-uploads are cheap and every file update triggers a fresh build.

## Errors

Build failures render an error page instead of the app; runtime errors and
unhandled rejections are shown in place of the root. When the user reports a
broken artifact, read the current files with `list_share_files`, fix the source,
and re-upload — do not ask them to paste build logs you can avoid by checking
imports against the whitelist first. Keep an intentional empty/loading state in
the component so first paint is never blank.

## Choice check

If the artifact is a single self-contained page with modest interactivity, plain
static HTML is simpler and builds instantly. Choose React when component
structure, hooks, or multi-file organization genuinely pay off.
