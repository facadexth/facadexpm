// ============================================================
// RecordProgressDialog -- "+ บันทึกยอด" on a quantity card (OWNER/PM).
// Saves through rpc('record_progress') and lists the card's entries
// (useProgressReports); a wrong entry is cancelled with
// rpc('cancel_progress'), never deleted -- cancelled rows stay, struck
// through. DB messages are shown verbatim. The DB re-checks everything
// (remaining qty, PLAN gate, role); the client check only saves a round trip.
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { Modal } from '../../components/Modal.jsx'
import { useProgressReports } from '../../hooks/useSupabase.js'
import { auditLog } from '../../lib/audit.js'
import { bangkokTodayIso } from '../../lib/photoUpload.js'
import { fmtNum as fmtQty } from './progressCalc.js'

export default function RecordProgressDialog({ task, unit, canManage, onClose, onSaved }) {
  const { data: reports, loading, refetch } = useProgressReports(task.id)
  const [qty, setQty] = useState('')
  const [workDate, setWorkDate] = useState(() => bangkokTodayIso())
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [confirmCancelId, setConfirmCancelId] = useState(null)

  const planned = Number(task.planned_qty) || 0
  const done = Number(task.done_qty) || 0
  const remaining = Math.max(0, Math.round((planned - done) * 10000) / 10000)
  const qtyNum = Number(qty)
  const qtyEntered = qty !== '' && Number.isFinite(qtyNum)
  const qtyError = !qtyEntered ? null
    : qtyNum <= 0 ? 'จำนวนต้องมากกว่า 0'
      : qtyNum > remaining ? `ใส่เกิน ${fmtQty(remaining)} ไม่ได้` : null
  const canSave = canManage && qtyEntered && !qtyError && !!workDate && !saving

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.rpc('record_progress', {
      p_task_id: task.id, p_qty: qtyNum, p_work_date: workDate, p_note: note.trim() || null,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved?.()
    onClose()
  }

  const cancelReport = async (r) => {
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.rpc('cancel_progress', { p_report_id: r.id })
    setSaving(false)
    setConfirmCancelId(null)
    if (err) { setError(err.message); return }
    await auditLog('progress_reports', r.id, 'cancel',
      { task_id: task.id, qty: r.qty, work_date: r.work_date, note: r.note ?? null },
      { cancelled: true })
    await refetch()
    onSaved?.()
  }

  const unitSuffix = unit ? ` ${unit}` : ''

  return (
    <Modal title={`บันทึกยอด — ${task.name}`} onClose={() => (saving ? false : onClose())} maxWidth={520}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text2)' }}>
          {`ติดแล้ว ${fmtQty(done)} จาก ${fmtQty(planned)} · เหลือ ${fmtQty(remaining)} · ใส่เกิน ${fmtQty(remaining)} ไม่ได้`}
        </div>
        {canManage && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ fontSize: 11, color: 'var(--text3)' }}>
              จำนวนที่ติดตั้ง{unit ? ` (${unit})` : ''}
              <input type="number" min="0" step="any" className="input input-sm" aria-label="จำนวนที่ติดตั้ง"
                style={{ width: '100%', marginTop: 2 }} value={qty} autoFocus
                onChange={(e) => setQty(e.target.value)} />
            </label>
            <label style={{ fontSize: 11, color: 'var(--text3)' }}>
              วันที่ทำงาน
              <input type="date" className="input input-sm" aria-label="วันที่ทำงาน"
                style={{ width: '100%', marginTop: 2 }} value={workDate}
                onChange={(e) => setWorkDate(e.target.value)} />
            </label>
            <label style={{ fontSize: 11, color: 'var(--text3)', gridColumn: '1 / -1' }}>
              หมายเหตุ
              <input className="input input-sm" aria-label="หมายเหตุ" placeholder="เช่น ชั้น 3 ฝั่งทิศเหนือ"
                style={{ width: '100%', marginTop: 2 }} value={note}
                onChange={(e) => setNote(e.target.value)} />
            </label>
          </div>
        )}
        {qtyError && <div style={{ color: 'var(--red)', fontSize: 12 }}>{qtyError}</div>}
        {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}

        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginTop: 4 }}>ประวัติการบันทึก</div>
        {loading && !reports.length ? (
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>กำลังโหลด...</div>
        ) : !reports.length ? (
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีรายการ</div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {reports.map((r) => {
              const isCancelled = !!r.cancelled_at
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5, padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
                  <span data-testid={`report-${r.id}`}
                    style={{ flex: 1, minWidth: 0, textDecoration: isCancelled ? 'line-through' : 'none', color: isCancelled ? 'var(--text3)' : 'var(--text)' }}>
                    {r.work_date} · <b>{fmtQty(r.qty)}{unitSuffix}</b>
                    {r.note ? ` · ${r.note}` : ''}
                    {r.created_by ? <span style={{ color: 'var(--text3)' }}> · {r.created_by}</span> : null}
                  </span>
                  {isCancelled && <span style={{ fontSize: 11, color: 'var(--text3)' }}>ยกเลิกแล้ว</span>}
                  {!isCancelled && canManage && (
                    confirmCancelId === r.id ? (
                      <>
                        <button type="button" className="btn btn-sm btn-danger" disabled={saving} onClick={() => cancelReport(r)}>ยืนยันยกเลิก</button>
                        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={() => setConfirmCancelId(null)}>ไม่ใช่</button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={() => setConfirmCancelId(r.id)}>ยกเลิกรายการ</button>
                    )
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>ปิด</button>
        {canManage && (
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={save}>
            {saving ? '⏳ กำลังบันทึก...' : 'บันทึกยอด'}
          </button>
        )}
      </div>
    </Modal>
  )
}
