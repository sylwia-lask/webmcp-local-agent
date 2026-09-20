// Simple esbuild-based build. Produces `dist/` that you load as an unpacked extension.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const outdir = "dist";
mkdirSync(outdir, { recursive: true });

const common = {
  outdir,
  bundle: true,
  target: "chrome123",
  sourcemap: true,
  logLevel: "info",
};

// ESM bundles: the service worker (type: module) and the side panel (loaded as
// <script type="module">).
await build({
  ...common,
  entryPoints: {
    "background/service-worker": "extension/src/background/service-worker.ts",
    "sidepanel/sidepanel": "extension/src/sidepanel/sidepanel.ts",
  },
  format: "esm",
});

// Content scripts are injected by the browser as CLASSIC scripts (not modules),
// so they must be IIFE bundles. This applies to both the ISOLATED-world content
// script and the MAIN-world page bridge (now injected declaratively via the
// manifest's "world": "MAIN", rather than by appending a <script> tag).
await build({
  ...common,
  entryPoints: {
    "content/content-script": "extension/src/content/content-script.ts",
    "content/page-bridge": "extension/src/content/page-bridge.ts",
  },
  format: "iife",
});

// Copy static assets (manifest + html/css + icons) into dist.
cpSync("extension/manifest.json", `${outdir}/manifest.json`);
cpSync("extension/src/sidepanel/sidepanel.html", `${outdir}/sidepanel/sidepanel.html`);
cpSync("extension/src/sidepanel/sidepanel.css", `${outdir}/sidepanel/sidepanel.css`);
cpSync("extension/src/icons", `${outdir}/icons`, { recursive: true });

console.log("\nBuild complete -> ./dist  (Load unpacked in chrome://extensions)");
