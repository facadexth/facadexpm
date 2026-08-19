# Installable PWA — Design Spec

## Overview

FacadeXPM is a React/Vite SPA reachable only through a browser URL today. This makes it installable as a Progressive Web App — users can "Add to Home Screen" on mobile (and "Install" on desktop Chrome/Edge) to get a real app icon, a full-screen window with no browser chrome, and a branded splash screen on launch. This is purely additive to the existing web app — nothing about how the app is built, deployed, or used in a normal browser tab changes.

## Goals

- The app is installable from any modern browser (Android Chrome, desktop Chrome/Edge, iOS Safari 16.4+) via the browser's native "Add to Home Screen" / "Install" affordance.
- Installed, it opens full-screen (`display: standalone`) with a branded splash screen — no address bar, matching what a native app looks like on launch.
- App icon and splash screen use the existing 🏗️ emoji (no real logo exists yet — confirmed with the user) rendered on a solid dark-purple (`--bg2`, `#1a1d2e`) background, at the icon sizes Android/iOS/desktop require.
- Repeat visits after installing load faster, since the app's static build assets (JS/CSS bundles) are cached by a service worker — explicitly NOT full offline data access (the app is Supabase-data-driven end to end; offline sync is out of scope per explicit user decision).

## Non-Goals

- No offline data access/sync. If the device has no network, the installed app will still fail to load data (same as today's plain web app would) — only the app *shell* (already-cached JS/CSS) loads faster/without a blank flash while waiting for the network, it does not let you view sites/income/etc. while disconnected.
- No custom/designed logo — reuses the existing 🏗️ emoji favicon, per explicit user decision (revisit icon design once real branding work happens, which is a separate not-yet-scoped white-labeling item).
- No push notifications — that's the explicitly-parked, separate "killer feature" the user wants to revisit later (LINE-based push vs. native push was the open question, deliberately not decided here).
- No native app store listing (Play Store/App Store) — this is the "Option A" path from the earlier PWA-vs-native discussion; wrapping in Capacitor for store distribution is a distinct, larger, not-yet-scoped follow-on if ever pursued.

## Design

**1. Web app manifest.** A new `public/manifest.webmanifest` (referenced from `index.html` via `<link rel="manifest">`) declares:
- `name`: "FACADE X Construction Dashboard", `short_name`: "FACADE X"
- `display`: `"standalone"`
- `theme_color` / `background_color`: `#1a1d2e` (`--bg2`) — matches the header's existing background and the user's chosen splash color
- `icons`: references to generated PNG icon files at the standard required sizes (192×192 and 512×512 minimum; a 512×512 `"purpose": "maskable"` variant too, since Android's adaptive-icon system crops/masks icons and a non-maskable-safe icon can get awkwardly cropped)
- `start_url`: `"/"`

**2. Icon generation.** Since no real logo exists, the icons are generated programmatically: an SVG string (the 🏗️ emoji centered on a `#1a1d2e` filled square, with extra padding for the maskable variant so the emoji survives Android's circular/rounded-square crop) rasterized to PNG at each required size using `sharp` (added as a new dev dependency — it rasterizes SVG natively, no browser/headless-Chrome needed). This is a one-time generation script (`scripts/generate-pwa-icons.js` or similar), run once to produce committed PNG files in `public/icons/` — not regenerated on every build, since the source (an emoji on a solid color) never changes without a deliberate edit to the script.

**3. Service worker.** Uses `vite-plugin-pwa` (the standard, well-maintained Vite integration for this — handles manifest injection, service worker generation, and safe update/registration behavior out of the box, far less error-prone than a hand-rolled service worker). Configured in "precache the built static assets, don't intercept/cache Supabase API calls" mode — network requests to Supabase always go straight to the network, never served from a cache, so data is never stale from a service-worker cache; only the app's own JS/CSS/icon files are precached for faster repeat loads.

**4. iOS-specific tags.** iOS Safari doesn't fully honor the web manifest spec for "Add to Home Screen" — `index.html` also gets `<link rel="apple-touch-icon">` (pointing at the 192×192 PNG) and `<meta name="apple-mobile-web-app-capable" content="yes">` / `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` so the iOS install path looks and behaves consistently with Android/desktop.

**5. No interaction with the light-mode work.** The manifest's `theme_color`/`background_color` and the generated icons are static (one fixed purple, not theme-aware) — this is a deliberate simplification, not an oversight: making the OS-level splash-screen/status-bar color react to the in-app light/dark toggle would require re-registering the manifest or using multiple manifest link tags switched at runtime, which is meaningfully more complex for a cosmetic detail (the splash screen is only visible for a fraction of a second during app launch). Revisit only if it's noticeably jarring in practice.

## Testing

- No new pure-logic function — this is build configuration + static asset generation, verified via `npm run build` (confirm the manifest, service worker, and icon files land in `dist/`) and a manual, disclosed-limitation-caveated check (no test login credentials available this session, consistent with every other UI feature built this session) of: the browser's install prompt/menu item appears, installing produces a home-screen icon with the correct image, and the installed app opens full-screen with the correct splash color.
- Lighthouse's PWA audit (built into Chrome DevTools) is a reasonable objective check for "is this actually installable" — worth running once during implementation if the environment allows it, though not a hard requirement given the manual-browser-check limitation already applies.
