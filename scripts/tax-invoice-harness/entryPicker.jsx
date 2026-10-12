import React from 'react'
import { createRoot } from 'react-dom/client'
import DocumentTemplatePicker from 'SRC/components/DocumentTemplatePicker.jsx'

// window.__picker = { tenant, templates, packs } set by runPicker.mjs
window.__render = () => {
  const d = window.__picker
  createRoot(document.getElementById('root')).render(
    <div style={{ padding: 16, background: 'var(--bg)', color: 'var(--text)', minHeight: 900 }}>
      <DocumentTemplatePicker tenant={d.tenant} templates={d.templates} packs={d.packs} refetchTenant={() => {}} />
    </div>,
  )
}
