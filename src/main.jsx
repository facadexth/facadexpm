import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import './mobile.css'   // phone-only rules (<= 900px); see src/mobile.css.test.js
import { installInputGuards } from './lib/inputGuards.js'

// Enter never submits a form (except data-enter-submit forms); wheel never
// changes a number input. Installed once, app-wide.
installInputGuards()

// /sign/<linkId> is a standalone public page (remote document signing) --
// checked before App even mounts, so a visitor with no account never
// touches the login screen or any authenticated session logic at all.
const signMatch = window.location.pathname.match(/^\/sign\/([^/]+)\/?$/)
// /f/<token> is the same idea for the LINE crew bot's เบิกของ/ขอลา deep
// links -- see FieldFormPage.jsx + the field-form Edge Function.
const fieldFormMatch = window.location.pathname.match(/^\/f\/([^/]+)\/?$/)
// /r/<token> is the customer LINE bot's repair form (RepairFormPage.jsx + the
// customer-form Edge Function), same no-login, no-app-shell idea.
const repairFormMatch = window.location.pathname.match(/^\/r\/([^/]+)\/?$/)
// /w/<token> is the crew's repair work order from LINE "งานวันนี้" (RepairWorkOrderPage.jsx + the
// repair-workorder Edge Function): view, customer signs on the crew's phone, or a sign-later link.
const workOrderMatch = window.location.pathname.match(/^\/w\/([^/]+)\/?$/)

// The public link pages have no "รีเฟรชเพื่ออัปเดต" banner and no state to lose on
// load, so a new service worker waiting (or installing) takes over at once and
// the page reloads -- otherwise a worker who opened a form before a deploy gets
// the old page (a payslip link once showed the leave form that way).
// Returns true when a reload is on its way.
async function takeWaitingWorker() {
  if (!('serviceWorker' in navigator)) return false
  let reg
  try { reg = await navigator.serviceWorker.getRegistration() } catch { return false }
  if (!reg) return false
  // one try per visit: the reload carries ?swu=1, so a worker that refuses to
  // activate can never cause a reload loop
  const url = new URL(location.href)
  if (url.searchParams.has('swu')) return false
  url.searchParams.set('swu', '1')
  let done = false
  const go = () => { if (!done) { done = true; location.replace(url.toString()) } }
  const take = (w) => {
    navigator.serviceWorker.addEventListener('controllerchange', go, { once: true })
    w.postMessage({ type: 'SKIP_WAITING' })
    setTimeout(go, 2000)
  }
  if (reg.waiting) { take(reg.waiting); return true }
  const w = reg.installing
  if (!w) return false
  // a new version is downloading right now: wait briefly for it, else carry on with this one
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 3000)
    w.addEventListener('statechange', () => {
      if (w.state === 'installed' && navigator.serviceWorker.controller) { clearTimeout(t); take(w); resolve(true) }
    })
  })
}

async function boot() {
  if ((signMatch || fieldFormMatch || repairFormMatch || workOrderMatch) && await takeWaitingWorker()) return
  const root = ReactDOM.createRoot(document.getElementById('root'))
  if (signMatch) {
    const { default: PublicSignPage } = await import('./PublicSignPage.jsx')
    root.render(
      <React.StrictMode>
        <PublicSignPage linkId={signMatch[1]} />
      </React.StrictMode>
    )
  } else if (fieldFormMatch) {
    const { default: FieldFormPage } = await import('./FieldFormPage.jsx')
    root.render(
      <React.StrictMode>
        <FieldFormPage token={fieldFormMatch[1]} />
      </React.StrictMode>
    )
  } else if (repairFormMatch) {
    const { default: RepairFormPage } = await import('./RepairFormPage.jsx')
    root.render(
      <React.StrictMode>
        <RepairFormPage token={repairFormMatch[1]} />
      </React.StrictMode>
    )
  } else if (workOrderMatch) {
    const { default: RepairWorkOrderPage } = await import('./RepairWorkOrderPage.jsx')
    root.render(
      <React.StrictMode>
        <RepairWorkOrderPage token={workOrderMatch[1]} />
      </React.StrictMode>
    )
  } else {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    )
  }
}

boot()
