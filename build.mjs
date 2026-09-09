// Simple esbuild-based build. Produces `dist/` that you load as an unpacked extension.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const outdir = "dist";
mkdirSync(outdir, { recursive: true });

// Bundle each entry point. All are plain ESM/IIFE bundles with no runtime deps.
await build({
  entryPoints: {
    "background/service-worker": "extension/src/background/service-worker.ts",
    "content/content-script": "extension/src/content/content-script.ts",
    "content/page-bridge": "extension/src/content/page-bridge.ts",
    "sidepanel/sidepanel": "extension/src/sidepanel/sidepanel.ts",
  },
  outdir,
  bundle: true,
  format: "esm",
  target: "chrome123",
  sourcemap: true,
  logLevel: "info",
});

// Copy static assets (manifest + html/css + icons) into dist.
cpSync("extension/manifest.json", `${outdir}/manifest.json`);
cpSync("extension/src/sidepanel/sidepanel.html", `${outdir}/sidepanel/sidepanel.html`);
cpSync("extension/src/sidepanel/sidepanel.css", `${outdir}/sidepanel/sidepanel.css`);
cpSync("extension/src/icons", `${outdir}/icons`, { recursive: true });

console.log("\nBuild complete -> ./dist  (Load unpacked in chrome://extensions)");
