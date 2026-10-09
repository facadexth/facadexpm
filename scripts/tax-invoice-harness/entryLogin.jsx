import React from 'react'
import { createRoot } from 'react-dom/client'
import Login from 'SRC/pages/Login.jsx'
import ResetPassword from 'SRC/components/ResetPassword.jsx'
// ?screen=reset shows the new-password screen, anything else the login page
window.__render = () => {
  const el = document.getElementById('root')
  const reset = new URLSearchParams(window.location.search).get('screen') === 'reset'
  createRoot(el).render(reset ? <ResetPassword onDone={() => { window.__done = true }} /> : <Login />)
}
