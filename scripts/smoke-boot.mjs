// Opens the BUILT app (dist/, served by `vite preview`) in a real browser and
// checks that it starts: something renders into #root and nothing throws.
//
// Why: on 2026-10-03 a deploy shipped an app that crashed on load (a variable
// used before its declaration), so every page, even the login page, was a
// black screen. verify-bundle.mjs only reads the bundle text and cannot see
// that. This runs the app the way a visitor does. `npm run deploy` runs it
// after the build and before wrangler, and stops the deploy on failure.
//
// Signed out, so it exercises everything that runs on first load (all the
// top-level hooks) and the login page; it cannot exercise signed-in pages.
import { spawn } from 'node:child_process'
import { chromium } from '@playwright/test'

const PORT = 4179
const URL = `http://localhost:${PORT}/`

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(URL); if (r.ok) return } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`preview server did not start on port ${PORT}`)
}

// Console errors that are not the app crashing (failed loads of optional files).
const IGNORABLE = [/Failed to load resource/i, /favicon/i]

const server = spawn('npx', ['--no-install', 'vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
let exitCode = 0
try {
  await waitForServer()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const problems = []
    page.on('pageerror', e => problems.push(`uncaught error: ${e.message}`))
    page.on('console', m => {
      if (m.type() === 'error' && !IGNORABLE.some(re => re.test(m.text()))) problems.push(`console error: ${m.text()}`)
    })
    await page.goto(URL, { waitUntil: 'load' })
    try {
      await page.waitForSelector('#root > *', { timeout: 15000 })
    } catch {
      problems.push('nothing rendered into #root within 15s (blank screen)')
    }
    await page.waitForTimeout(1500) // let first-load effects run and any late crash surface
    if (problems.length) {
      console.error('smoke-boot: FAILED')
      problems.forEach(p => console.error('  - ' + p))
      exitCode = 1
    } else {
      console.log('smoke-boot: OK (app starts, login page renders, no errors)')
    }
  } finally {
    await browser.close()
  }
} catch (e) {
  console.error('smoke-boot: could not run the check: ' + e.message)
  exitCode = 1
} finally {
  server.kill()
}
process.exit(exitCode)
