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
