// Settings -> 🧩 แม่แบบเฟสงาน (OWNER): the company's phase template -- names, order and a
// weight % per phase that must total 100. Stored in app_settings 'phase_template'
// (src/pages/sites/phaseTemplate.js has the format). Used by the Gantt "apply template"
// button, "ใช้น้ำหนักจากแม่แบบ", and as the default row of the BOQ % per phase matrix.
import { useEffect, useState } from 'react'
import { useAppSetting, saveAppSetting } from '../hooks/useSupabase.js'
import {
  PHASE_TEMPLATE_KEY, DEFAULT_PHASE_TEMPLATE, parsePhaseTemplate, serializePhaseTemplate,
  templateTotal, templateProblems, moveTemplateRow,
} from '../pages/sites/phaseTemplate.js'

const GRID = { display: 'grid', gridTemplateColumns: '40px 1fr 110px 92px', gap: 8, alignItems: 'center' }

export default function PhaseTemplateSettings() {
  const { data: raw, loading, refetch } = useAppSetting(PHASE_TEMPLATE_KEY, '')
  const [rows, setRows] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  // the stored value is the editor's starting point; a later refetch (after save) keeps the edits
  useEffect(() => { if (!loading && rows === null) setRows(parsePhaseTemplate(raw).map((r) => ({ ...r }))) }, [loading, raw, rows])

  if (rows === null) return <div style={{ color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>

  const total = templateTotal(rows)
  const problems = templateProblems(rows)
  const canSave = problems.length === 0 && !saving
  const setRow = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const removeRow = (i) => setRows((rs) => rs.filter((_, k) => k !== i).map((r, k) => ({ ...r, sort_order: k + 1 })))
  const addRow = () => setRows((rs) => [...rs, { name: '', sort_order: rs.length + 1, weight: 0 }])
  const restore = () => { setRows(DEFAULT_PHASE_TEMPLATE.map((r) => ({ ...r }))); setMsg(null) }

  const save = async () => {
    if (!canSave) return
    setSaving(true); setMsg(null)
    try {
      await saveAppSetting(PHASE_TEMPLATE_KEY, serializePhaseTemplate(rows))
      setMsg({ ok: true, text: 'บันทึกแม่แบบแล้ว' })
      refetch?.()
    } catch (e) {
      setMsg({ ok: false, text: 'บันทึกไม่สำเร็จ: ' + e.message })
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...GRID, fontSize: 12, fontWeight: 700, color: 'var(--text3)', padding: '0 4px' }}>
        <span>ลำดับ</span><span>ชื่อเฟส</span><span>น้ำหนัก %</span><span />
      </div>
      {rows.map((r, i) => (
        <div key={i} style={GRID} data-testid={`tpl-row-${i}`}>
          <span style={{ fontSize: 13, color: 'var(--text3)', textAlign: 'center' }}>{i + 1}</span>
          <input className="input input-sm" value={r.name} placeholder="ชื่อเฟส" aria-label={`ชื่อเฟส ${i + 1}`}
            onChange={(e) => setRow(i, { name: e.target.value })} />
          <input className="input input-sm" type="number" min="0" max="100" step="any" value={r.weight} aria-label={`น้ำหนัก ${i + 1}`}
            style={{ textAlign: 'right', fontWeight: Number(r.weight) > 0 ? 700 : 400 }}
            onChange={(e) => setRow(i, { weight: e.target.value })} />
          <span style={{ display: 'flex', gap: 2 }}>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="เลื่อนขึ้น" disabled={i === 0} onClick={() => setRows((rs) => moveTemplateRow(rs, i, -1))}>↑</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="เลื่อนลง" disabled={i === rows.length - 1} onClick={() => setRows((rs) => moveTemplateRow(rs, i, 1))}>↓</button>
            <button type="button" className="btn btn-ghost btn-sm" aria-label="ลบเฟส" style={{ color: 'var(--red)' }} onClick={() => removeRow(i)}>×</button>
          </span>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" className="btn btn-ghost btn-sm" style={{ border: '1px dashed var(--border)' }} onClick={addRow}>+ เพิ่มเฟส</button>
        <span style={{ flex: 1 }} />
        <span data-testid="tpl-total" style={{ fontSize: 13, fontWeight: 700, color: Math.abs(total - 100) <= 0.001 ? 'var(--green)' : 'var(--red)' }}>
          รวม {total}% {Math.abs(total - 100) <= 0.001 ? '✓' : '✗'}
        </span>
      </div>
      {problems.length > 0 && <div style={{ fontSize: 12, color: 'var(--red)' }}>{problems.join(' · ')}</div>}
      <div style={{ fontSize: 12, color: 'var(--text3)', background: 'var(--bg2)', borderRadius: 8, padding: '8px 10px' }}>
        ใช้ปุ่ม ↑ ↓ เรียงลำดับ · ยังไม่ตั้ง = ใช้แม่แบบเดิมของระบบ (5 / 15 / 5 / 30 / 30 / 10 / 5) · แก้แม่แบบแล้ว ไซท์เดิมไม่เปลี่ยนเอง (กด "ใช้น้ำหนักจากแม่แบบ" ในแท็บ Gantt ของไซท์นั้น)
      </div>
      {msg && <div style={{ fontSize: 12, color: msg.ok ? 'var(--green)' : 'var(--red)' }}>{msg.text}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button type="button" className="btn btn-ghost" onClick={restore}>คืนค่าแม่แบบเดิม</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>{saving ? '⏳ กำลังบันทึก...' : 'บันทึกแม่แบบ'}</button>
      </div>
    </div>
  )
}
