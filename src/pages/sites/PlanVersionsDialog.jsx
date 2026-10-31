// ============================================================
// PlanVersionsDialog — บันทึกเป็น PLAN ใหม่ + ประวัติเวอร์ชัน PLAN
// pre-check สดจากเฟสปัจจุบัน สะท้อนเงื่อนไขของ RPC save_site_plan
// (เฟสที่ไม่ใช่ VO/issue ต้องมีวันเริ่ม-จบ, น้ำหนักรวม 100 ±0.01, ต้องมีเหตุผล)
// ข้อความ error จาก DB แสดงตามจริง
// ============================================================
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { Modal } from '../../components/Modal.jsx'
import { supabase } from '../../lib/supabase.js'

export function planPreChecks(phases) {
  const counted = (phases || []).filter(p => !p.is_vo && !p.is_issue_phase)
  const missingDates = counted.filter(p => !p.start_date || !p.end_date)
  const sum = counted.reduce((a, p) => a + (Number(p.billing_weight_pct) || 0), 0)
  return {
    hasPhases: counted.length > 0,
    missingDates,
    sum: Math.round(sum * 100) / 100,
    weightOk: Math.abs(sum - 100) <= 0.01,
  }
}

const fmtDate = (iso) => { try { return format(new Date(iso), 'd MMM yy HH:mm', { locale: th }) } catch { return '' } }

export default function PlanVersionsDialog({ siteId, phases, plans, canSave, onClose, onSaved }) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const checks = useMemo(() => planPreChecks(phases), [phases])
  const noteOk = note.trim() !== ''
  const nextVersion = (plans[0]?.version ?? 0) + 1
  const canSubmit = canSave && noteOk && checks.hasPhases && checks.missingDates.length === 0 && checks.weightOk && !saving

  const handleSave = async () => {
    setSaving(true); setError('')
    const { error: err } = await supabase.rpc('save_site_plan', { p_site_id: siteId, p_note: note.trim() })
    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved?.()
    onClose()
  }

  const Check = ({ ok, children }) => (
    <div style={{ fontSize: 13, color: ok ? 'var(--green)' : 'var(--yellow)' }}>{ok ? '✓' : '⚠'} {children}</div>
  )

  return (
    <Modal title="PLAN ของไซท์" onClose={() => { if (!saving) onClose() }} maxWidth={640}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {canSave && (
          <>
            <div style={{ fontWeight: 600 }}>บันทึกเป็น PLAN v{nextVersion}</div>
            <div style={{ display: 'grid', gap: 4 }}>
              <Check ok={checks.hasPhases}>มีเฟสงาน</Check>
              <Check ok={checks.missingDates.length === 0}>
                {checks.missingDates.length === 0
                  ? 'ทุกเฟสมีวันเริ่ม/วันจบ'
                  : `เฟสที่ยังไม่มีวันเริ่ม/วันจบ: ${checks.missingDates.map(p => p.name).join(', ')}`}
              </Check>
              <Check ok={checks.weightOk}>น้ำหนักเฟสรวม {checks.sum}% {checks.weightOk ? '' : '(ต้องเท่ากับ 100%)'}</Check>
            </div>
            <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
              เหตุผล (จำเป็น)
              <input className="input" value={note} onChange={e => setNote(e.target.value)} placeholder="เช่น ลูกค้าเลื่อนส่งมอบ" disabled={saving} />
            </label>
            {error && <div role="alert" style={{ color: 'var(--red)', fontSize: 13 }}>{error}</div>}
          </>
        )}
        <div style={{ fontWeight: 600 }}>ประวัติ PLAN</div>
        {plans.length === 0 ? (
          <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มี PLAN</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead><tr><th>เวอร์ชัน</th><th>วันที่</th><th>ผู้บันทึก</th><th>เหตุผล</th></tr></thead>
              <tbody>
                {plans.map(p => (
                  <tr key={p.id}>
                    <td>v{p.version}{p.is_auto && <span className="badge" style={{ marginLeft: 6 }}>อัตโนมัติ</span>}</td>
                    <td>{fmtDate(p.created_at)}</td>
                    <td>{p.created_by || '-'}</td>
                    <td>{p.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>ปิด</button>
        {canSave && (
          <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={handleSave}>
            {saving ? '⏳ กำลังบันทึก...' : `บันทึก PLAN v${nextVersion}`}
          </button>
        )}
      </div>
    </Modal>
  )
}

// Banner + buttons above the single-site Gantt. Shows nothing while loading or when the
// fetch failed (so a missing table never reads as "no PLAN").
export function PlanBar({ plans, loading, loadError, canManage, onOpen }) {
  if (loading || loadError) return null
  if (plans.length === 0) {
    return (
      <div className="card" role="status" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderColor: 'var(--yellow)' }}>
        <div style={{ flex: 1, minWidth: 220, fontSize: 13 }}>
          ยังไม่มี PLAN ต้องบันทึก PLAN v1 ก่อน จึงจะย้ายการ์ดไป "กำลังทำ/เสร็จ" หรือบันทึกยอดติดตั้งได้ ระหว่างนี้วางเฟสและการ์ดได้ตามปกติ
        </div>
        {canManage && <button type="button" className="btn btn-primary btn-sm" onClick={onOpen}>บันทึก PLAN v1</button>}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, color: 'var(--text3)' }}>PLAN v{plans[0].version}</span>
      {canManage && <button type="button" className="btn btn-primary btn-sm" onClick={onOpen}>บันทึกเป็น PLAN ใหม่</button>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onOpen}>ประวัติ PLAN</button>
    </div>
  )
}
