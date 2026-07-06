// ============================================================
// PhaseManageModal — เพิ่ม/แก้/ลบขั้นตอนงานของไซท์เดียว
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'

const STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จ' },
]

let tempIdCounter = 0
function nextTempId() { tempIdCounter -= 1; return tempIdCounter }

export default function PhaseManageModal({ site, phases, onClose, onSaved }) {
  const [rows, setRows] = useState(() => phases.map((p) => ({ ...p })))
  const [saving, setSaving] = useState(false)
  const originalIds = phases.map((p) => p.id)

  const setRow = (id, patch) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const addRow = () => setRows((rs) => [
    ...rs,
    { id: nextTempId(), site_id: site.id, name: '', sort_order: rs.length + 1, start_date: '', end_date: '', status: 'not_started', billing_weight_pct: 0 },
  ])
  const removeRow = (id) => setRows((rs) => rs.filter((r) => r.id !== id))

  const totalWeight = rows.reduce((s, r) => s + (parseFloat(r.billing_weight_pct) || 0), 0)

  const handleSave = async () => {
    setSaving(true)
    try {
      const toUpdate = rows.filter((r) => r.id > 0).map((r) => ({
        id: r.id,
        site_id: site.id,
        name: r.name,
        sort_order: r.sort_order,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
        status: r.status,
        billing_weight_pct: parseFloat(r.billing_weight_pct) || 0,
      }))
      const toInsert = rows.filter((r) => r.id < 0).map((r) => ({
        site_id: site.id,
        name: r.name,
        sort_order: r.sort_order,
        start_date: r.start_date || null,
        end_date: r.end_date || null,
        status: r.status,
        billing_weight_pct: parseFloat(r.billing_weight_pct) || 0,
      }))
      const keptIds = rows.filter((r) => r.id > 0).map((r) => r.id)
      const deletedIds = originalIds.filter((id) => !keptIds.includes(id))

      if (toUpdate.length) {
        const { error } = await supabase.from('site_phases').upsert(toUpdate)
        if (error) throw error
      }
      if (toInsert.length) {
        const { error } = await supabase.from('site_phases').insert(toInsert)
        if (error) throw error
      }
      if (deletedIds.length) {
        const { error } = await supabase.from('site_phases').delete().in('id', deletedIds)
        if (error) throw error
      }
      onSaved()
      onClose()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={`จัดการขั้นตอน: ${site.name}`} onClose={onClose} maxWidth={760}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {rows.map((r) => (
          <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 80px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" value={r.name} onChange={(e) => setRow(r.id, { name: e.target.value })} placeholder="ชื่อขั้นตอน" />
            <input type="date" className="input input-sm" value={r.start_date || ''} onChange={(e) => setRow(r.id, { start_date: e.target.value })} />
            <input type="date" className="input input-sm" value={r.end_date || ''} onChange={(e) => setRow(r.id, { end_date: e.target.value })} />
            <select className="select" value={r.status} onChange={(e) => setRow(r.id, { status: e.target.value })}>
              {STATUS_OPTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <input type="number" className="input input-sm" min="0" max="100" value={r.billing_weight_pct}
              onChange={(e) => setRow(r.id, { billing_weight_pct: e.target.value })} placeholder="%" />
            <button type="button" className="btn btn-sm btn-danger" onClick={() => removeRow(r.id)}>✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={addRow}>+ เพิ่มขั้นตอน</button>
        <div style={{ fontSize: 12, color: totalWeight === 100 ? 'var(--text3)' : 'var(--yellow)' }}>
          รวม % เบิกเงิน: {totalWeight}% {totalWeight !== 100 && '(ควรรวมได้ 100%)'}
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>
          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </Modal>
  )
}
