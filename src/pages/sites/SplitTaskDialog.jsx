// ============================================================
// SplitTaskDialog -- "แตกงาน": a general card (งานทั่วไป, 0 points) becomes a
// parent of ≥ 2 child cards (one level only), at any status. Children are
// names only: the DB gives each the parent's status and 0 points, so the
// node % does not move; the parent's status then follows its children.
// Saves through rpc('split_task'); the DB re-checks the rules (BOQ cards
// cannot be split) and its message is shown verbatim.
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { auditLog } from '../../lib/audit.js'

/** Two rows named after the parent ("<name> 1", "<name> 2"). */
export function defaultSplitRows(task) {
  return [{ name: `${task.name} 1` }, { name: `${task.name} 2` }]
}

export default function SplitTaskDialog({ task, onClose, onSaved }) {
  const [rows, setRows] = useState(() => defaultSplitRows(task))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const namesOk = rows.every((r) => r.name.trim() !== '')
  const canSave = rows.length >= 2 && namesOk && !saving

  const setRow = (i, name) => setRows((rs) => rs.map((r, j) => (j === i ? { name } : r)))

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const children = rows.map((r) => ({ name: r.name.trim() }))
    const { error: err } = await supabase.rpc('split_task', { p_task_id: task.id, p_children: children })
    setSaving(false)
    if (err) { setError(err.message); return }
    await auditLog('phase_tasks', task.id, 'split', { status: task.status }, { children })
    onSaved?.()
    onClose()
  }

  return (
    <Modal title={`แตกงาน — ${task.name}`} onClose={() => (saving ? false : onClose())} maxWidth={520}>
      <div className="modal-body" style={{ display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          แบ่งงานทั่วไปนี้เป็นงานย่อย — งานย่อยเริ่มที่สถานะเดียวกับงานนี้ สถานะงานหลักจะคิดจากงานย่อย ไม่กระทบ % (แตกได้ชั้นเดียว)
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" aria-label="ชื่องานย่อย" placeholder="ชื่องานย่อย" value={r.name}
              onChange={(e) => setRow(i, e.target.value)} />
            <button type="button" className="btn btn-sm btn-ghost" disabled={rows.length <= 2} title="ลบแถว"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows((rs) => [...rs, { name: '' }])}>+ เพิ่มแถว</button>
        {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>
          {saving ? '⏳ กำลังบันทึก...' : 'แตกงาน'}
        </button>
      </div>
    </Modal>
  )
}
