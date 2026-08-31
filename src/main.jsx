import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

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
