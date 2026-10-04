import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'))

export default defineConfig({
  // Baked in at build time, not read at runtime -- __BUILD_TIME__ is
  // literally "when `vite build` ran", the closest thing to a deploy
  // timestamp this app has (no CI/commit metadata reaches the client
  // otherwise). Shown in Settings so support can ask "what version are
  // you on" instead of guessing from behavior.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // The self-hosted user manual (public/manual/index.html, ~3MB with
      // its embedded screenshots) is fetched on demand when someone opens
      // it (see ManualModal.jsx) -- it has no reason to be force-downloaded
      // into every user's offline app-shell cache on install/update.
      workbox: {
        globIgnores: ['manual/**'],
        // A new service worker takes over pages that have none (e.g. after a Shift-reload,
        // which loads the page without one). Without this the "รีเฟรชเพื่ออัปเดต" button
        // activated the new worker but never got the signal to reload, so nothing visibly
        // happened and the banner stayed. Safe in 'prompt' mode: a new worker only becomes
        // active after the user taps the button.
        clientsClaim: true,
        // Web Push: shows notifications and opens the tapped page (public/push-handler.js).
        importScripts: ['push-handler.js'],
        // globIgnores above only keeps manual/index.html OUT of the
        // precache -- it does NOT stop Workbox's default catch-all
        // NavigationRoute (registered with no denylist) from treating a
        // request for that path as an unmatched SPA route and serving
        // this app's own index.html instead. Since ManualModal.jsx loads
        // /manual/index.html in an <iframe>, and an iframe's top-level
        // load is itself a navigation-mode request, that fallback was
        // recursively rendering the whole app inside the manual iframe
        // instead of the real manual page. Excluding /manual/ from the
        // fallback lets that request go straight to the network/cache
        // like any other static file.
        navigateFallbackDenylist: [/^\/manual\//],
      },
      manifest: {
        name: 'CHANG',
        short_name: 'CHANG',
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
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**', 'e2e/**'],
  },
})
