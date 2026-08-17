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
