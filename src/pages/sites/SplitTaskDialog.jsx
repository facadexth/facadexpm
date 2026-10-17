// ============================================================
// SplitTaskDialog -- "แตกงาน": a status card becomes a parent whose points
// are divided over ≥ 2 child cards (one level only). Saves through
// rpc('split_task'); the DB re-checks the rules and its message is shown
// verbatim. The total must equal the parent's points (±0.005 here, the
// DB allows ±0.01).
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { auditLog } from '../../lib/audit.js'
import { round2, fmtNum } from './progressCalc.js'

/** Two rows splitting the parent's points equally (2 dp); the rounding
 *  remainder goes on the first row. Points are kept as input strings. */
export function defaultSplitRows(task) {
  const total = Number(task.weight_pts) || 0
  const each = Math.floor((total / 2) * 100) / 100
  return [
    { name: `${task.name} 1`, pts: fmtNum(total - each) },
    { name: `${task.name} 2`, pts: fmtNum(each) },
  ]
}

export default function SplitTaskDialog({ task, onClose, onSaved }) {
  const [rows, setRows] = useState(() => defaultSplitRows(task))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const parentPts = Number(task.weight_pts) || 0
  const total = round2(rows.reduce((s, r) => s + (Number(r.pts) || 0), 0))
  const totalOk = Math.abs(total - parentPts) <= 0.005
  const namesOk = rows.every((r) => r.name.trim() !== '')
  const ptsOk = rows.every((r) => r.pts !== '' && Number.isFinite(Number(r.pts)) && Number(r.pts) >= 0)
  const canSave = rows.length >= 2 && totalOk && namesOk && ptsOk && !saving

  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const children = rows.map((r) => ({ name: r.name.trim(), weight_pts: Number(r.pts) }))
    const { error: err } = await supabase.rpc('split_task', { p_task_id: task.id, p_children: children })
    setSaving(false)
    if (err) { setError(err.message); return }
    await auditLog('phase_tasks', task.id, 'split',
      { weight_pts: task.weight_pts, status: task.status }, { children })
    onSaved?.()
    onClose()
  }

  return (
    <Modal title={`แตกงาน — ${task.name}`} onClose={() => (saving ? false : onClose())} maxWidth={520}>
      <div className="modal-body" style={{ display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          แบ่งแต้มของงานนี้ให้งานย่อย — สถานะงานหลักจะคิดจากงานย่อย (แตกได้ชั้นเดียว)
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 32px', gap: 6, alignItems: 'center' }}>
            <input className="input input-sm" aria-label="ชื่องานย่อย" placeholder="ชื่องานย่อย" value={r.name}
              onChange={(e) => setRow(i, { name: e.target.value })} />
            <input type="number" min="0" step="0.01" className="input input-sm" aria-label="แต้ม" value={r.pts}
              onChange={(e) => setRow(i, { pts: e.target.value })} />
            <button type="button" className="btn btn-sm btn-ghost" disabled={rows.length <= 2} title="ลบแถว"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows((rs) => [...rs, { name: '', pts: '0' }])}>+ เพิ่มแถว</button>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: totalOk ? 'var(--green)' : 'var(--red)' }}>
          {`รวม ${fmtNum(total)} / ${fmtNum(parentPts)} แต้ม${totalOk ? ' ✓' : ''}`}
        </div>
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
