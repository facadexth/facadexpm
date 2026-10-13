import React from 'react'
import { createRoot } from 'react-dom/client'
import DocumentTemplatesAdmin from 'SRC/pages/DocumentTemplatesAdmin.jsx'

window.__render = () => {
  createRoot(document.getElementById('root')).render(<div style={{ padding: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: 900 }}><DocumentTemplatesAdmin /></div>)
}
