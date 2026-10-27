// src/pages/aluCatalog/SettingsTab.jsx
// ค่ามาตรฐาน: the tenant-wide constants of the estimation module (one row in estimation_settings).
import { useState, useEffect } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import { useEstimationSettings, saveEstimationSettings } from '../../hooks/useEstimation2b.js'
import { mergeSettings } from '../../lib/estimationSettings.js'
import { friendlyDbError } from '../../lib/catalogForm.js'

const NUMBER_FIELDS = [
  { key: 'stock_length_m', label: 'ความยาวเส้นมาตรฐาน (ม.)', step: '0.01', min: 0 },
  { key: 'kerf_square_mm', label: 'kerf ตัดฉาก 90° (มม.)', step: '0.1', min: 0, hint: 'kerf เป็นค่าสมมติ ใส่ค่าจริงของเลื่อย' },
  { key: 'kerf_miter_mm', label: 'kerf ตัด 45° (มม.)', step: '0.1', min: 0, hint: 'ตัด 45° เสียมากกว่า (ประมาณ 10 มม.) ให้วัดจริง และระบุความยาวชิ้น 45° เป็นความยาวด้านนอกเสมอ' },
  { key: 'min_keep_offcut_m', label: 'เศษขั้นต่ำที่เก็บไว้ใช้ต่อ (ม.)', step: '0.01', min: 0 },
  { key: 'sealant_m_per_tube', label: 'ซีลแลนท์ (ม./หลอด 300 มล.)', step: '0.1', min: 0 },
  { key: 'fixing_pitch_m', label: 'ระยะห่างจุดยึด (ม.)', step: '0.01', min: 0 },
  { key: 'fixing_min_per_side', label: 'จุดยึดขั้นต่ำต่อด้าน', step: '1', min: 1 },
  // custom-length order from the mill (งานโครงการ)
  { key: 'custom_len_min_m', label: 'ความยาวสั่งพิเศษต่ำสุด (ม.)', step: '0.01', min: 0 },
  { key: 'custom_len_max_m', label: 'สูงสุด (ม.)', step: '0.01', min: 0 },
  { key: 'custom_len_step_m', label: 'ทีละ (ม.)', step: '0.01', min: 0 },
  { key: 'custom_moq_kg', label: 'ขั้นต่ำสั่งพิเศษ (กก.)', step: '1', min: 0, hint: 'น้ำหนักรวมของเส้นความยาวพิเศษทั้งโครงการ ไม่ถึงนี้ใช้เส้นมาตรฐานทั้งโครงการ' },
]
const PART_FIELDS = [
  { key: 'sealant_part_id', label: 'ซีลแลนท์' },
  { key: 'shim_part_id', label: 'แผ่นรอง (shim)' },
  { key: 'screw_part_id', label: 'สกรู' },
  { key: 'plug_part_id', label: 'พุก/ปลั๊ก' },
]

export const toForm = s => Object.fromEntries([...NUMBER_FIELDS, ...PART_FIELDS].map(f => [f.key, s[f.key] ?? '']))
// The row a save writes: the form over the stored settings, so a value with no field on this page is kept, not reset
// to its default. mergeSettings: a blank / invalid number falls back to its default, never NaN or null.
export const formToSettings = (stored, form) => mergeSettings({ ...(stored || {}), ...form })

export default function SettingsTab({ canEdit }) {
  const st = useEstimationSettings()
  const parts = useCatalogTable('alu_parts')
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  // load the stored values once they arrive (and again after a save refetch)
  useEffect(() => { if (!st.loading && !st.error) setForm(toForm(st.settings)) }, [st.loading, st.error, st.row, st.settings])

  if (st.error) return <div style={{ color: 'var(--red)' }}>โหลดค่ามาตรฐานไม่สำเร็จ (บันทึกถูกปิดไว้): {String(st.error)}</div>
  if (parts.error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {parts.error}</div>
  if (!form) return <div style={{ color: 'var(--text3)' }}>กำลังโหลด...</div>

  const accessories = (parts.data || []).filter(p => p.kind === 'accessory' && (p.active !== false || Object.values(form).includes(p.id)))
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async (e) => {
    e.preventDefault()
    if (!canEdit || saving) return
    setSaving(true)
    try {
      await saveEstimationSettings(st.row, formToSettings(st.settings, form))
      st.refetch()
      alert('บันทึกแล้ว')
    } catch (err) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(err)) }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={save} className="card" style={{ padding: 16, maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>⚙️ ค่ามาตรฐาน</h3>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>ใช้กับทุกโปรเจกต์ · เว้นว่างช่องตัวเลข = ใช้ค่าเริ่มต้น</div>
      <div style={{ display: 'grid', gap: 12 }}>
        {NUMBER_FIELDS.map(f => (
          <div key={f.key}>
            <label className="label">{f.label}</label>
            <input className="input" type="number" step={f.step} min={f.min} disabled={!canEdit} value={form[f.key]} onChange={e => set(f.key, e.target.value)} />
            {f.hint && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{f.hint}</div>}
          </div>
        ))}
        {PART_FIELDS.map(f => (
          <div key={f.key}>
            <label className="label">{f.label}</label>
            <select className="input" disabled={!canEdit} value={form[f.key] || ''} onChange={e => set(f.key, e.target.value)}>
              <option value="">— ไม่ใช้ —</option>
              {accessories.map(p => <option key={p.id} value={p.id}>{(p.code ? `${p.code} · ` : '') + p.name + (p.active === false ? ' (ปิดใช้งาน)' : '')}</option>)}
            </select>
          </div>
        ))}
      </div>
      {canEdit && (
        <div style={{ marginTop: 14 }}>
          <button type="submit" className="btn btn-primary" disabled={saving || !!st.error}>{saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
        </div>
      )}
    </form>
  )
}
