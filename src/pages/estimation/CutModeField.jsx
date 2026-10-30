// src/pages/estimation/CutModeField.jsx
// "ประเภทงาน": a normal job buys the market stock bar only; a project job may order custom lengths
// (estimation_projects.cut_mode 'stock' | 'custom'; a project without the column yet counts as 'stock').
import { useState } from 'react'
import { saveProjectCutMode } from '../../hooks/useEstimation2b.js'
import InlineError from './InlineError.jsx'

export default function CutModeField({ project, settings, canEdit, onProjectSaved }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const mode = project.cut_mode === 'custom' ? 'custom' : 'stock'
  const choose = async next => {
    if (next === mode) return
    setBusy(true); setError(null)
    try { await saveProjectCutMode(project.id, next); await onProjectSaved() } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
  }
  const options = [
    ['stock', `งานทั่วไป · เส้น ${Number(settings.stock_length_m).toFixed(2)} ม. หาซื้อได้เลย`],
    ['custom', 'งานโครงการ · สั่งความยาวพิเศษ'],
  ]
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map(([v, label]) => (
          <button key={v} type="button" aria-pressed={mode === v} className={`btn btn-sm ${mode === v ? 'btn-primary' : 'btn-ghost'}`}
            disabled={!canEdit || busy} onClick={() => choose(v)}>{label}</button>
        ))}
      </div>
      {error && <InlineError title="บันทึกประเภทงานไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
    </div>
  )
}
