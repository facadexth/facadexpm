# Installable PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make FacadeXPM installable ("Add to Home Screen" / "Install") on Android, desktop Chrome/Edge, and iOS Safari 16.4+, with a branded icon and splash screen, and faster repeat loads via a precaching service worker — no offline data access, no app-store distribution.

**Architecture:** A one-time Node script (using `sharp`) rasterizes an SVG (the 🏗️ emoji on a solid dark-purple background) into the PNG sizes a web manifest requires, committed to `public/icons/`. `vite-plugin-pwa` is added to `vite.config.js` to generate the manifest and a precaching-only service worker at build time; `index.html` gets the iOS-specific meta/link tags the plugin doesn't cover.

**Tech Stack:** `sharp` (new devDependency, SVG→PNG rasterization), `vite-plugin-pwa` (new devDependency, manifest + service worker generation for Vite).

## Global Constraints

- No offline data access — the service worker must only precache the app's own built static assets (JS/CSS/icons), never intercept or cache requests to Supabase (a different origin entirely, so this happens by construction with the plugin's default config — do not add any `runtimeCaching` rule that touches the Supabase origin).
- No custom/designed logo — icons are generated from the existing 🏗️ emoji on a `#1a1d2e` (`--bg2`) background. If the emoji fails to rasterize correctly in whatever environment the icon-generation script runs in (a real risk with headless SVG rasterization — some environments lack a color-emoji font), fall back to a simple bold "FX" text mark on the same background rather than shipping a broken/blank icon — Task 1 has an explicit visual-verification step for this.
- No push notifications, no app-store listing — out of scope for this plan entirely.
- `theme_color`/`background_color`/icons are static (not theme-aware) — this is deliberate, not something to "fix" by wiring in the separate light-mode work.

---

### Task 1: Generate the PWA icon set

**Files:**
- Create: `scripts/generate-pwa-icons.js`
- Create (generated output, committed): `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-512-maskable.png`, `public/icons/apple-touch-icon.png`

**Interfaces:**
- Produces (used by Task 2): four PNG files at fixed paths under `public/icons/` — `icon-192.png` (192×192), `icon-512.png` (512×512, full-bleed), `icon-512-maskable.png` (512×512, content padded into Android's ~80% maskable safe zone), `apple-touch-icon.png` (180×180, the standard iOS home-screen icon size).

- [ ] **Step 1: Install `sharp`**

Run: `npm install --save-dev sharp`
Expected: adds `sharp` to `devDependencies` in `package.json` (any `^0.35.x` release is fine — this is a build-time-only tool, not shipped to the browser).

- [ ] **Step 2: Write the icon generation script**

Create `scripts/generate-pwa-icons.js`:
```js
#!/usr/bin/env node
// One-time PWA icon generator. Not run as part of `npm run build` --
// the source (an emoji on a solid color) never changes without a
// deliberate edit to this script, so the output PNGs are committed
// like any other static asset, not regenerated on every build.
const sharp = require('sharp')
const fs = require('fs')

const BG = '#1a1d2e' // --bg2, matches the header background and the
                      // splash-screen color the user chose

fs.mkdirSync('public/icons', { recursive: true })

function iconSvg(fontSize, textY) {
  return `
<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="${BG}"/>
  <text x="256" y="${textY}" font-size="${fontSize}" text-anchor="middle">🏗️</text>
</svg>
`
}

// Full-bleed: emoji fills most of the canvas, used for the plain
// (non-maskable) icons.
const FULL_BLEED_SVG = iconSvg(280, 330)

// Maskable: Android's adaptive-icon system can crop up to ~20% off each
// edge (a circle inscribed in the icon), so keep the emoji smaller and
// centered within that safe zone.
const MASKABLE_SVG = iconSvg(200, 300)

async function generate() {
  await sharp(Buffer.from(FULL_BLEED_SVG)).resize(192, 192).png().toFile('public/icons/icon-192.png')
  await sharp(Buffer.from(FULL_BLEED_SVG)).resize(512, 512).png().toFile('public/icons/icon-512.png')
  await sharp(Buffer.from(MASKABLE_SVG)).resize(512, 512).png().toFile('public/icons/icon-512-maskable.png')
  await sharp(Buffer.from(FULL_BLEED_SVG)).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png')
  console.log('Generated PWA icons in public/icons/')
}

generate().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 3: Run the script**

Run: `node scripts/generate-pwa-icons.js`
Expected output: `Generated PWA icons in public/icons/`, and the four PNG files now exist.

Verify the files exist and are the right dimensions:
Run: `file public/icons/*.png`
Expected: each line reports the correct pixel dimensions (`192 x 192`, `512 x 512`, `512 x 512`, `180 x 180`) and `PNG image data`.

- [ ] **Step 4: Visually verify the emoji actually rendered (do not skip this)**

Use the Read tool to view `public/icons/icon-512.png` directly (Read can display image files). Confirm it genuinely shows the 🏗️ construction-crane emoji in color, centered on the dark-purple background — not a blank box, a monochrome/broken glyph, or a "missing character" placeholder square. This is a real risk with headless SVG-to-PNG rasterization: some environments don't have a color-emoji font available to the rasterizer.

**If the emoji rendered correctly**: proceed to Step 5.

**If the emoji did NOT render correctly** (blank, broken, or placeholder box): the environment this script ran in lacks color-emoji font support. Do not ship a broken icon. Fall back to a text mark instead — edit `scripts/generate-pwa-icons.js`'s `iconSvg` function to render bold white "FX" text instead of the emoji:
```js
function iconSvg(fontSize, textY) {
  return `
<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="${BG}"/>
  <text x="256" y="${textY}" font-size="${fontSize}" font-family="sans-serif" font-weight="800" fill="#ffffff" text-anchor="middle">FX</text>
</svg>
`
}
```
(keep the same `FULL_BLEED_SVG`/`MASKABLE_SVG` font-size/y-position calls as before — sans-serif bold text at those sizes reads fine as a simple wordmark). Re-run Step 3 and re-verify with Step 4 again until the generated icon actually looks correct when viewed.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-pwa-icons.js public/icons/
git commit -m "feat: generate PWA icon set"
```

---

### Task 2: Web manifest, service worker, and iOS meta tags

**Files:**
- Modify: `vite.config.js`
- Modify: `index.html`
- Modify: `package.json` (new devDependency)

**Interfaces:**
- Consumes: the four PNG paths produced by Task 1 (`public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-512-maskable.png`, `public/icons/apple-touch-icon.png`).

- [ ] **Step 1: Install `vite-plugin-pwa`**

Run: `npm install --save-dev vite-plugin-pwa`
Expected: adds `vite-plugin-pwa` to `devDependencies` (any `^1.x` release is fine).

- [ ] **Step 2: Add the plugin to `vite.config.js`**

The file currently reads:
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 3000 },
  test: {
    // .claude/worktrees/** holds full nested git checkouts (other
    // in-progress branches, each with their own test files/deps) —
    // Vitest's default excludes don't cover .claude, so without this
    // `npm test` from the main checkout also runs every other
    // worktree's tests against this project's node_modules.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
})
```
Change it to:
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'FACADE X Construction Dashboard',
        short_name: 'FACADE X',
        theme_color: '#1a1d2e',
        background_color: '#1a1d2e',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: { port: 3000 },
  test: {
    // .claude/worktrees/** holds full nested git checkouts (other
    // in-progress branches, each with their own test files/deps) —
    // Vitest's default excludes don't cover .claude, so without this
    // `npm test` from the main checkout also runs every other
    // worktree's tests against this project's node_modules.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
})
```
No `runtimeCaching`/`workbox` options are configured beyond the plugin's defaults — the default `generateSW` strategy only precaches this app's own same-origin build output (JS/CSS/HTML/icons matched by the plugin's default glob patterns), so requests to Supabase (a completely different origin) are never intercepted or cached without extra configuration explicitly asking for that. Do not add a `workbox.runtimeCaching` rule targeting the Supabase origin — that would violate the "no offline data access" constraint.

- [ ] **Step 3: Add the iOS-specific and theme-color tags to `index.html`**

`index.html`'s `<head>` currently reads (after Task 1 of the light-mode plan, if that's already been implemented — the exact starting point below assumes the *original* file; if the inline theme script from that plan is already present, add these new tags after it, not in place of it):
```html
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FACADE X — Dashboard</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏗️</text></svg>" />
  </head>
```
Add these lines immediately after the existing `<link rel="icon" ...>` line:
```html
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="theme-color" content="#1a1d2e" />
```
(`vite-plugin-pwa` auto-injects the `<link rel="manifest">` tag itself during build with its default `injectRegister` setting — do not add one manually, since that risks a duplicate. Step 5 verifies this actually happened in the built output rather than assuming it.)

- [ ] **Step 4: Build and verify the manifest/service-worker output**

Run: `npm run build`
Expected: succeeds with no new errors. `vite-plugin-pwa` prints a summary of precached files during the build (something like `PWA v1.x.x` followed by a list of precached entries).

Verify the manifest link was actually injected:
Run: `grep -o '<link rel="manifest"[^>]*>' dist/index.html`
Expected: prints one `<link rel="manifest" href="...">` tag. If this prints nothing, the plugin's auto-injection didn't happen with the default config — add `<link rel="manifest" href="/manifest.webmanifest">` manually to `index.html`'s `<head>` (immediately after the `theme-color` meta tag added in Step 3), re-run `npm run build`, and re-check.

Verify the manifest and service worker files exist in the build output:
Run: `ls dist/manifest.webmanifest dist/sw.js`
Expected: both files listed (exact service worker filename may differ slightly by plugin version — if `sw.js` doesn't exist, run `ls dist/*.js | grep -i sw` to find the actual generated filename and confirm it's a `vite-plugin-pwa`-generated Workbox service worker, not a false match).

Verify the manifest content is correct:
Run: `cat dist/manifest.webmanifest`
Expected: valid JSON containing `"name":"FACADE X Construction Dashboard"`, `"display":"standalone"`, `"theme_color":"#1a1d2e"`, and the three icon entries from Step 2, with the maskable one showing `"purpose":"maskable"`.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all 36 existing tests still pass (this task is build configuration only, no application logic changed).

- [ ] **Step 6: Manual verification (documented limitation)**

This app has no test login credentials available to any subagent this session — a standing, disclosed limitation for every UI feature built this session. Manual confirmation of the actual install prompt, home-screen icon, and standalone-launch behavior cannot be performed here; note this explicitly in your report rather than claiming a browser check that wasn't possible. If you want an objective, code-independent check of installability, Chrome DevTools' Lighthouse PWA audit (Application tab → Manifest, and the Lighthouse panel) can be run against `npm run preview`'s output and doesn't require login, since it only inspects the manifest/service-worker/HTTPS-eligibility of the page shell — mention in your report whether you were able to run this.

- [ ] **Step 7: Commit**

```bash
git add vite.config.js index.html package.json package-lock.json
git commit -m "feat: make the app installable as a PWA"
```
