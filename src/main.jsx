import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import DebugLogPanel from './DebugLogPanel.jsx'
import './index.css'

// TEMPORARY diagnostic capture for the Android document-scan crash
// investigation (2026-09-10) -- remove once resolved, along with
// DebugLogPanel.jsx. Persists to localStorage BEFORE anything else can
// happen, so an error survives even a hard page reload/crash right after
// it fires. See DebugLogPanel.jsx for how it's displayed.
;(function setupDebugCapture() {
  const KEY = '__fx_debug_log'
  function push(entry) {
    try {
      const log = JSON.parse(localStorage.getItem(KEY) || '[]')
      log.push(entry)
      localStorage.setItem(KEY, JSON.stringify(log.slice(-20))) // keep it bounded
    } catch { /* localStorage unavailable/full -- nothing to do */ }
  }
  window.addEventListener('error', (e) => {
    push({ type: 'error', message: e.message, stack: e.error?.stack, filename: e.filename, lineno: e.lineno, time: new Date().toISOString() })
  })
  window.addEventListener('unhandledrejection', (e) => {
    push({ type: 'unhandledrejection', message: String(e.reason?.message || e.reason), stack: e.reason?.stack, time: new Date().toISOString() })
  })
  // React/library warnings often precede a real crash without necessarily
  // throwing a catchable error -- log every console.error too.
  const origError = console.error
  console.error = function (...args) {
    push({ type: 'console.error', message: args.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) } }).join(' '), time: new Date().toISOString() })
    origError.apply(console, args)
  }
})()

// /sign/<linkId> is a standalone public page (remote document signing) --
// checked before App even mounts, so a visitor with no account never
// touches the login screen or any authenticated session logic at all.
const signMatch = window.location.pathname.match(/^\/sign\/([^/]+)\/?$/)

async function boot() {
  const root = ReactDOM.createRoot(document.getElementById('root'))
  if (signMatch) {
    const { default: PublicSignPage } = await import('./PublicSignPage.jsx')
    root.render(
      <React.StrictMode>
        <PublicSignPage linkId={signMatch[1]} />
        <DebugLogPanel />
      </React.StrictMode>
    )
  } else {
    root.render(
      <React.StrictMode>
        <App />
        <DebugLogPanel />
      </React.StrictMode>
    )
  }
}

boot()
