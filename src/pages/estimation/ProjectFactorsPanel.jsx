// Project price factors: waste %, profit %, PM %, transport total (baht), round step. Saves the estimation_projects row.
import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase.js'

const FIELDS = [
  ['waste_pct', 'เผื่อเสียเศษ (% ของอลูมิเนียม)'],
  ['profit_pct', 'กำไร (% ทับรวมต้นทุน)'],
  ['pm_pct', 'PM (% ของราคาขาย)'],
  ['transport_total', 'ค่าขนส่งทั้งโปรเจกต์ (บาท)'],
  ['round_step', 'ปัดราคาขายขึ้นทีละ (บาท)'],
]
export const FACTOR_COLUMNS = FIELDS.map(f => f[0])

const show = v => (v === null || v === undefined ? '' : String(v))
const draftOf = p => Object.fromEntries(FIELDS.map(([k]) => [k, show(p && p[k])]))

export function validateFactors(draft) {
  for (const [k, label] of FIELDS) {
    const raw = String(draft[k] ?? '').trim()
    if (raw === '') { if (k === 'round_step') return `${label}: ต้องมากกว่า 0`; continue }
    const x = Number(raw)
    if (!Number.isFinite(x) || x < 0) return `${label}: ต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป`
    if (k === 'round_step' && !(x > 0)) return `${label}: ต้องมากกว่า 0`
  }
  return null
}

export function buildFactorPatch(draft) {
  const out = {}
  for (const k of FACTOR_COLUMNS) { const raw = String(draft[k] ?? '').trim(); out[k] = raw === '' ? null : Number(raw) }
  return out
}

export default function ProjectFactorsPanel({ project, canEdit, onSaved }) {
  const [draft, setDraft] = useState(() => draftOf(project))
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setDraft(draftOf(project)); setError(null) }, [project && project.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    const e = validateFactors(draft)
    if (e) { setError(e); return }
    setError(null); setSaving(true)
    try {
      const { error: err } = await supabase.from('estimation_projects').update(buildFactorPatch(draft)).eq('id', project.id)
      if (err) throw err
      await onSaved()
    } catch (err) { setError('บันทึกไม่สำเร็จ: ' + err.message) } finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ fontWeight: 700 }}>ตัวคูณราคาของโปรเจกต์</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
        {FIELDS.map(([k, label]) => (
          <div key={k}>
            <label className="label">{label}</label>
            <input className="input" type="number" min="0" step="any" disabled={!canEdit} value={draft[k]} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}
      {canEdit && <div><button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? 'กำลังบันทึก...' : 'บันทึก'}</button></div>}
    </div>
  )
}
