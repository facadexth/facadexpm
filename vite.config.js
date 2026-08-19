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
